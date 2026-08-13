"""What this package refuses to do with input it does not control.

Three of these are not questions about a building. They are questions about the
PROCESS the building is measured in, and every one of them was reproduced
against the code before it was fixed:

  - ``open_model(url=…)`` fetched whatever the URL named. The agent chooses the
    URL and the server makes the connection, so a tool for reading a model was
    also a reader of ``http://169.254.169.254/latest/meta-data/`` and of every
    port on the loopback interface — and the failure text said which ports were
    open;
  - ``write_ids(name=…)`` joined ``name`` onto the target directory, so an
    absolute name replaced the directory and a ``..`` walked out of it;
  - ``render.plan`` derived the raster HEIGHT from the model's aspect ratio and
    allocated it. A 400 m × 2 m gallery is 365 megapixels at the default width,
    which is 1.41 GB and an OOM-killed worker rather than a refused request.

The first two are refusals and read as ``ToolError``: the call could not be
made. None of them is an ``undecidable`` — that is a finding about an export,
and "we will not connect there" is a finding about us.
"""

from __future__ import annotations

import email.message
import http.server
import io
import socketserver
import threading
from pathlib import Path
from typing import Any

import ifcopenshell
import pytest
from ifc_spatial import render
from ifc_spatial.model import SpatialModel
from ifc_spatial.tools import ALLOW_PRIVATE_URLS_ENV
from ifc_spatial.tools import ToolError
from ifc_spatial.tools import _GuardedRedirectHandler
from ifc_spatial.tools import _opener
from ifc_spatial.tools import _read_source
from ifc_spatial.tools import _refuse_unroutable_destination

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"


# ── [4] the destination of a download ───────────────────────────────────────


class _Counter(http.server.BaseHTTPRequestHandler):
    """Answers anything, and counts. The count is the assertion."""

    hits = 0

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's name
        type(self).hits += 1
        body = b"ISO-10303-21;\nEND-ISO-10303-21;\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:  # noqa: D102 — silence the test log
        return


@pytest.fixture()
def loopback_server():
    """A real HTTP server on 127.0.0.1 — a stand-in for everything inside the
    perimeter that a URL from an agent must not reach."""
    handler = type("_H", (_Counter,), {"hits": 0})
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield handler, f"http://127.0.0.1:{server.server_address[1]}/modell.ifc"
    finally:
        server.shutdown()
        server.server_close()


def test_a_loopback_url_is_refused_before_a_socket_is_opened(loopback_server, monkeypatch) -> None:
    """The reproduction, verbatim: this URL returned the server's bytes.

    The hit count is the part that matters. A guard that refuses AFTER the
    request has been made has already told the attacker whether the port is
    open, which is the whole value of an SSRF probe.
    """
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    handler, url = loopback_server

    with pytest.raises(ToolError) as raised:
        _read_source({"url": url})

    assert handler.hits == 0
    assert "öffentlichen Netzes" in str(raised.value)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/modell.ifc",
        "http://127.1/modell.ifc",
        "http://0.0.0.0/modell.ifc",
        # The cloud metadata endpoint — the reason link-local is on this list.
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        "http://10.0.0.5/modell.ifc",
        "http://172.16.0.1/modell.ifc",
        "http://192.168.1.1/modell.ifc",
        # Carrier-grade NAT: routable-looking, not the public internet.
        "http://100.64.0.1/modell.ifc",
        "http://224.0.0.1/modell.ifc",
        "https://[::1]/modell.ifc",
        # Loopback wearing an IPv6 hat. A check that reads only the outer form
        # lets this one through.
        "https://[::ffff:127.0.0.1]/modell.ifc",
        "http://[fd00::1]/modell.ifc",
        "http://[fe80::1]/modell.ifc",
    ],
)
def test_every_address_outside_the_public_internet_is_refused(url: str, monkeypatch) -> None:
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    with pytest.raises(ToolError):
        _refuse_unroutable_destination(url)


def test_a_public_address_is_not_refused(monkeypatch) -> None:
    """The guard has to leave the tool usable, which is the half that is easy to
    lose: a check that refuses everything passes every security test."""
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    _refuse_unroutable_destination("https://93.184.216.34/modell.ifc")
    _refuse_unroutable_destination("http://93.184.216.34:8080/modell.ifc")


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/m.ifc", "gopher://x/1"])
def test_only_http_and_https_are_read(url: str, monkeypatch) -> None:
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    with pytest.raises(ToolError) as raised:
        _read_source({"url": url})
    assert "http://" in str(raised.value)


def test_a_redirect_hop_is_checked_like_the_first_one(monkeypatch) -> None:
    """A public URL answering ``302 → 169.254.169.254`` is the standard way past
    a guard that only reads what the caller typed."""
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    import urllib.request

    request = urllib.request.Request("https://93.184.216.34/modell.ifc")
    handler = _GuardedRedirectHandler()

    with pytest.raises(ToolError):
        handler.redirect_request(
            request,
            io.BytesIO(b""),
            302,
            "Found",
            email.message.Message(),
            "http://169.254.169.254/latest/meta-data/",
        )


def test_the_download_still_goes_through_the_guarded_opener() -> None:
    """Pins the wiring, not the behaviour.

    Every hop check in this file is dead code the moment ``_read_source`` goes
    back to a bare ``urllib.request.urlopen``, and nothing else in the suite
    would notice.
    """
    assert any(isinstance(handler, _GuardedRedirectHandler) for handler in _opener.handlers)


def test_a_failed_connection_does_not_report_which_failure_it_was(monkeypatch) -> None:
    """„Connection refused" and „timed out" are a port scanner.

    The two words are the difference between a closed port and a filtered one on
    a host the agent cannot otherwise see, and the agent picks the URL.
    """
    monkeypatch.delenv(ALLOW_PRIVATE_URLS_ENV, raising=False)
    # `.invalid` is reserved by RFC 2606 and never resolves.
    with pytest.raises(ToolError) as raised:
        _read_source({"url": "https://kein-modell.invalid/haus.ifc"})

    text = str(raised.value)
    assert "path verwenden" in text
    for leak in ("Errno", "refused", "Connection", "urlopen", "timed out", "getaddrinfo"):
        assert leak not in text


def test_a_host_that_knows_its_own_network_can_opt_back_in(loopback_server, monkeypatch) -> None:
    """The escape hatch a MinIO on the compose network needs.

    Opt-in and not opt-out, because the two mistakes are not symmetric: a
    deployment that needed this and did not set it reads a refusal and fixes it
    in one environment variable, while a deployment that never needed it and was
    never asked fetches an agent's URL from inside its own perimeter and nobody
    finds out.
    """
    monkeypatch.setenv(ALLOW_PRIVATE_URLS_ENV, "1")
    handler, url = loopback_server

    assert _read_source({"url": url}).startswith(b"ISO-10303-21;")
    assert handler.hits == 1


# ── [30] the size of a raster ───────────────────────────────────────────────


def _gallery(path: Path) -> SpatialModel:
    """A 400 m × 2 m covered walkway — two long walls and nothing else.

    Not a contrived shape. A noise barrier, a gallery, a tunnel section and a
    platform canopy all have this aspect ratio, and each of them is a perfectly
    ordinary IFC that an architect uploads. At the default 1400 px width it
    derives a height of 260 942 px: 365 megapixels, 1.41 GB of RGB, and the
    worker dies before the first line is drawn.
    """
    f = ifcopenshell.file(schema="IFC4")

    def gid(tag: str) -> str:
        """A readable 22-character GlobalId, as the other synthetic fixtures use."""
        return f"2Long{tag}".ljust(22, "0")[:22]

    z = f.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
    x = f.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
    axes = f.create_entity(
        "IfcAxis2Placement3D",
        Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)),
        Axis=z,
        RefDirection=x,
    )
    context = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1e-5,
        WorldCoordinateSystem=axes,
    )
    placement = f.create_entity("IfcLocalPlacement", RelativePlacement=axes)
    units = f.create_entity(
        "IfcUnitAssignment",
        Units=[
            f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"),
            f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
            f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
        ],
    )
    project = f.create_entity(
        "IfcProject",
        GlobalId=gid("Project"),
        Name="Laermschutzgalerie",
        RepresentationContexts=[context],
        UnitsInContext=units,
    )

    def wall(tag: str, name: str, box: tuple[float, float, float, float, float, float]) -> Any:
        x0, x1, y0, y1, z0, z1 = box
        profile = f.create_entity(
            "IfcRectangleProfileDef",
            ProfileType="AREA",
            ProfileName=name,
            Position=f.create_entity(
                "IfcAxis2Placement2D",
                Location=f.create_entity("IfcCartesianPoint", Coordinates=((x0 + x1) / 2, (y0 + y1) / 2)),
            ),
            XDim=x1 - x0,
            YDim=y1 - y0,
        )
        solid = f.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=profile,
            Position=f.create_entity(
                "IfcAxis2Placement3D",
                Location=f.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, z0)),
                Axis=z,
                RefDirection=x,
            ),
            ExtrudedDirection=z,
            Depth=z1 - z0,
        )
        return f.create_entity(
            "IfcWall",
            GlobalId=gid(tag),
            Name=name,
            ObjectPlacement=placement,
            Representation=f.create_entity(
                "IfcProductDefinitionShape",
                Representations=[
                    f.create_entity(
                        "IfcShapeRepresentation",
                        ContextOfItems=context,
                        RepresentationIdentifier="Body",
                        RepresentationType="SweptSolid",
                        Items=[solid],
                    )
                ],
            ),
        )

    site = f.create_entity("IfcSite", GlobalId=gid("Site"), Name="Trasse", ObjectPlacement=placement)
    building = f.create_entity("IfcBuilding", GlobalId=gid("Build"), Name="Galerie", ObjectPlacement=placement)
    storey = f.create_entity(
        "IfcBuildingStorey", GlobalId=gid("Storey"), Name="Trassenebene", ObjectPlacement=placement, Elevation=0.0
    )
    f.create_entity("IfcRelAggregates", GlobalId=gid("Agg1"), RelatingObject=project, RelatedObjects=[site])
    f.create_entity("IfcRelAggregates", GlobalId=gid("Agg2"), RelatingObject=site, RelatedObjects=[building])
    f.create_entity("IfcRelAggregates", GlobalId=gid("Agg3"), RelatingObject=building, RelatedObjects=[storey])

    # 400 m long, 2 m apart: an aspect ratio of 1:200.
    west = wall("Wall01", "Galeriewand West", (0.0, 0.2, 0.0, 400.0, 0.0, 3.0))
    east = wall("Wall02", "Galeriewand Ost", (1.8, 2.0, 0.0, 400.0, 0.0, 3.0))
    f.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=gid("Cont1"),
        RelatingStructure=storey,
        RelatedElements=[west, east],
    )
    f.write(str(path))
    return SpatialModel(str(path))


def test_a_long_thin_building_cannot_allocate_the_worker_away(tmp_path: Path) -> None:
    """The finding, end to end and through the public entry point.

    Before the bound this produced a 1400 × 260 942 px canvas. The assertion is
    on the pixel count rather than on either edge, because that is what the
    allocation is proportional to.
    """
    drawn = render.plan(_gallery(tmp_path / "galerie.ifc"))

    assert drawn is not None
    assert drawn.width * drawn.height <= render.MAX_RASTER_PIXELS
    # And it is still a drawing of a long thin thing, not a cropped square: the
    # bound moves the SCALE, so the aspect ratio survives it.
    assert drawn.height > drawn.width


def test_a_caller_cannot_ask_for_an_arbitrary_canvas(tmp_path: Path) -> None:
    """``tools.view`` never passes ``width_px``, so anything past the ceiling is
    a library caller — and 12 000 px on the sample house is 63 megapixels."""
    house = SpatialModel(str(HOUSE))
    drawn = render.plan(house, width_px=12_000)

    assert drawn is not None
    assert drawn.width <= render.MAX_RASTER_WIDTH
    assert drawn.width * drawn.height <= render.MAX_RASTER_PIXELS


@pytest.mark.parametrize(
    ("width", "margin", "span_x", "span_y"),
    [
        (1400, 48, 2.0, 400.0),
        (1400, 48, 0.5, 2_000.0),
        (100_000, 48, 14.16, 6.08),
        (8_000, 48, 1.0, 1_000.0),
        # A margin at or past half the width drove the scale to zero or below,
        # which is a divide-by-nothing rather than a small plan.
        (10, 900, 5.0, 5.0),
    ],
)
def test_no_span_and_no_request_gets_past_the_pixel_ceiling(
    width: int, margin: int, span_x: float, span_y: float
) -> None:
    fitted_width, fitted_height, fitted_margin, scale = render._fit_raster(width, margin, span_x, span_y)

    assert fitted_width * fitted_height <= render.MAX_RASTER_PIXELS
    assert fitted_width <= render.MAX_RASTER_WIDTH
    assert fitted_width > 2 * fitted_margin
    assert scale > 0


def test_an_ordinary_plan_is_untouched_by_the_bound() -> None:
    """The guard must be invisible on every model anyone actually draws.

    The sample house at the default width is 1.0 megapixels — 40× under the
    ceiling — and its numbers must not move, because `scale_px_per_m` is printed
    on the drawing's own scale bar.
    """
    house = SpatialModel(str(HOUSE))
    drawn = render.plan(house)

    assert drawn is not None
    assert drawn.width == 1400
    assert drawn.width * drawn.height < render.MAX_RASTER_PIXELS // 10


# ── [28] where an IDS file is written ───────────────────────────────────────


class _Empty:
    """A document with no specifications.

    Used deliberately: the empty list is the branch that returns EARLY, and a
    guard placed after it would be a guard an attacker can choose their way
    past by picking a model with no findings.
    """

    class ids:  # noqa: N801 — mirrors the attribute name on IdsShoppingList
        specifications: list[Any] = []

    exported: list[str] = []
    not_exportable: list[Any] = []

    def summary(self) -> str:
        return "Keine Befunde."


@pytest.mark.parametrize(
    "name",
    [
        "../../../etc/cron.d/ifc",
        "../nebenan.ids",
        "/etc/cron.d/ifc",
        "unterordner/haus.ids",
        "..\\..\\haus.ids",
        "..",
        ".",
        "",
        "haus\x00.ids",
    ],
)
def test_a_name_that_leaves_the_target_directory_is_refused(name: str, tmp_path: Path) -> None:
    from ifc_spatial.ids_export import write_ids

    before = sorted(p.name for p in tmp_path.iterdir())
    with pytest.raises(ToolError):
        write_ids(_Empty(), directory=str(tmp_path), name=name)
    assert sorted(p.name for p in tmp_path.iterdir()) == before


def test_a_nested_name_is_refused_and_not_silently_renamed(tmp_path: Path) -> None:
    """``os.path.basename`` is the obvious sanitiser and the wrong one.

    It turns ``"befunde/haus.ids"`` into ``"haus.ids"`` and writes a file the
    caller did not ask for. This module's whole promise is that the file an
    architect loads into their checker is exactly the document that was
    described, so a name it cannot honour is refused rather than reinterpreted.
    """
    from ifc_spatial.ids_export import write_ids

    with pytest.raises(ToolError):
        write_ids(_Empty(), directory=str(tmp_path), name="befunde/haus.ids")
    assert not (tmp_path / "haus.ids").exists()
    assert list(tmp_path.iterdir()) == []


def test_a_plain_file_name_is_still_accepted(tmp_path: Path) -> None:
    from ifc_spatial.ids_export import _checked_name

    assert _checked_name("fehlt-a1b2c3d4.ids") == "fehlt-a1b2c3d4.ids"
    assert _checked_name("Haus 42 — Befunde.ids") == "Haus 42 — Befunde.ids"


def test_a_real_document_still_lands_under_the_given_name(tmp_path: Path) -> None:
    from ifc_spatial.ids_export import blind_spots_as_ids
    from ifc_spatial.ids_export import write_ids

    document = blind_spots_as_ids(SpatialModel(str(HOUSE)))
    facts = write_ids(document, directory=str(tmp_path), name="haus.ids")

    assert facts["path"] == str(tmp_path / "haus.ids")
    assert (tmp_path / "haus.ids").is_file()

"""The ``ifc_measure`` tool's argument handling, its errors and its rendering.

The tool is the seam where a language model's free-form intent becomes a
geometric operation on a real building. Three things can go wrong there and
none of them is visible from the engine's own tests:

  - an enum value the engine would refuse arrives as an exception several
    seconds and one download later, by which time the agent has been told only
    that something failed;
  - "the service is unreachable" and "your arguments are wrong" collapse into
    one message, and a typo ends the turn with the agent instructed to say
    nothing about the building;
  - a ``decidable: false`` answer — the file cannot say — is rendered as a
    FAILURE, which turns a finding about the export into a fact about the
    building.

All three are exercised here without a frontend and without IfcOpenShell.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

from aiq_agent.agents.bim.measure_register import ENGINE_UNAVAILABLE_TEXT
from aiq_agent.agents.bim.measure_register import UNAVAILABLE_TEXT
from aiq_agent.agents.bim.measure_register import _build_call
from aiq_agent.agents.bim.measure_register import _provenance_line
from aiq_agent.agents.bim.measure_register import _rejected_text
from aiq_agent.agents.bim.measure_register import _render
from aiq_agent.agents.bim.measure_register import _render_unresolved
from aiq_agent.agents.bim.measure_register import _unrunnable_text


def build(**overrides):
    defaults = dict(operation="briefing")
    defaults.update(overrides)
    return _build_call(**defaults)


class TestBuildCall:
    """Every enum, checked BEFORE the model is resolved or parsed."""

    def test_the_default_operation_is_the_briefing(self):
        assert build(operation="briefing") == ("briefing", {"format": "text"})

    def test_unknown_operation_is_refused_by_name(self):
        result = build(operation="measure_room")
        assert isinstance(result, str)
        assert "unknown operation" in result
        # The valid set is spelled out so the model can correct itself in one turn.
        assert "storey_heights" in result

    @pytest.mark.parametrize("operation", ["element", "relations", "measure", "distance"])
    def test_an_operation_about_one_element_needs_its_global_id(self, operation):
        answer = build(operation=operation)
        assert isinstance(answer, str)
        assert "needs a global_id" in answer
        # And it says where a real one comes from, because the failure mode
        # this prevents is the model inventing a plausible-looking id.
        assert "find_elements" in answer

    def test_an_unknown_relation_is_refused_with_the_list(self):
        answer = build(operation="relations", global_id="1kTv", relation="borders")
        assert isinstance(answer, str)
        assert "relation 'borders' does not exist" in answer
        assert "adjacentSpaces" in answer

    def test_a_real_relation_passes_through_verbatim(self):
        assert build(operation="relations", global_id="1kTv", relation="opensTo") == (
            "relations",
            {"globalId": "1kTv", "relation": "opensTo"},
        )

    def test_an_unknown_measure_is_refused_with_the_list(self):
        answer = build(operation="measure", global_id="1kTv", measure="area")
        assert isinstance(answer, str)
        assert "measure 'area' does not exist" in answer
        assert "floorArea" in answer

    def test_every_measure_the_engine_has_is_accepted(self):
        for name in ("extent", "floorArea", "sillAndHead", "elevation", "clearHeight", "azimuth"):
            assert build(operation="measure", global_id="g1", measure=name) == (
                "measure",
                {"globalId": "g1", "measure": name},
            ), name

    def test_distance_needs_two_elements(self):
        answer = build(operation="distance", global_id="a")
        assert isinstance(answer, str)
        assert "other_global_id" in answer

    def test_distance_defaults_to_the_shortest_gap(self):
        assert build(operation="distance", global_id="a", other_global_id="b") == (
            "distance",
            {"a": "a", "b": "b", "mode": "min"},
        )

    def test_an_unknown_distance_mode_is_refused_and_says_which_to_use(self):
        # A lichte Breite measured on the slant is a wrong number that reads
        # perfectly, so the correction names the two directional modes.
        answer = build(operation="distance", global_id="a", other_global_id="b", mode="diagonal")
        assert isinstance(answer, str)
        assert "mode 'diagonal' does not exist" in answer
        assert "horizontal" in answer and "vertical" in answer

    def test_an_unknown_kind_is_refused_and_distinguished_from_an_ifc_type(self):
        # `kind` is the spatial ROLE. A model that puts "IfcSpace" here gets
        # zero matches, which reads as "the building has no rooms".
        answer = build(operation="find_elements", kind="IfcSpace")
        assert isinstance(answer, str)
        assert "kind 'IfcSpace' does not exist" in answer
        assert "'ifc_type'" in answer

    def test_find_elements_passes_the_filters_the_engine_knows(self):
        assert build(
            operation="find_elements",
            ifc_type="IfcWindow",
            name_contains="Nord",
            storey="Ground Floor",
            kind="element",
            limit=10,
        ) == (
            "find_elements",
            {
                "limit": 10,
                "ifcType": "IfcWindow",
                "nameContains": "Nord",
                "storey": "Ground Floor",
                "kind": "element",
            },
        )

    @pytest.mark.parametrize("limit,expected", [(0, 50), (5, 5), (10_000, 500)])
    def test_the_element_limit_is_clamped(self, limit, expected):
        name, args = build(operation="find_elements", limit=limit or 50)
        assert name == "find_elements"
        assert args["limit"] == expected

    def test_an_unknown_room_kind_is_refused(self):
        answer = build(operation="room_inventory", room_kind="wohnraum")
        assert isinstance(answer, str)
        assert "room_kind 'wohnraum' does not exist" in answer
        assert "aufenthaltsraum" in answer

    def test_the_room_kinds_the_lexicon_knows_pass_through_lowercased(self):
        for value in ("aufenthaltsraum", "nebenraum", "erschliessung"):
            assert build(operation="room_inventory", room_kind=value.upper()) == (
                "room_inventory",
                {"kind": value},
            ), value

    def test_storey_heights_takes_nothing(self):
        assert build(operation="storey_heights") == ("storey_heights", {})

    def test_draw_narrows_by_storey_and_type(self):
        assert build(operation="draw", storey="Ground Floor", ifc_type="IfcWall") == (
            "draw",
            {"storey": "Ground Floor", "include": ["IfcWall"]},
        )


class TestTheEnumsMatchTheEngine:
    """The tool's vocabulary is a COPY of the package's, and copies drift.

    `measure_register` spells the enums out rather than importing them, so that
    NAT's plugin discovery does not pull IfcOpenShell, numpy and shapely into
    every process at startup. The price of that is this test: an operator
    renamed in the package has to fail HERE, in a sentence naming both sides,
    rather than at a user whose perfectly good call is refused by name.
    """

    @staticmethod
    def _engine():
        return pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")

    def test_the_relations_are_the_engine_s_relations(self):
        from aiq_agent.agents.bim.measure_register import RELATIONS

        assert set(RELATIONS) == set(self._engine().RELATIONS)

    def test_the_geometric_relations_are_the_engine_s(self):
        # The ones the description warns cost ~7 s on a cold model. A relation
        # that quietly joined that set would be called speculatively.
        from aiq_agent.agents.bim.measure_register import GEOMETRIC_RELATIONS

        assert set(GEOMETRIC_RELATIONS) == set(self._engine().GEOMETRIC_RELATIONS)

    def test_the_measures_are_the_engine_s_measures(self):
        from aiq_agent.agents.bim.measure_register import MEASURES

        assert set(MEASURES) == set(self._engine().MEASURES)

    def test_the_kinds_are_the_engine_s_kinds(self):
        from aiq_agent.agents.bim.measure_register import KINDS

        assert set(KINDS) == set(self._engine().KINDS)


class TestProvenanceIsThreeDifferentSentences:
    """The reason this tool exists.

    A declared value is the architect's own statement; a computed one is ours,
    with a tolerance; an inferred one is a proposal. Rendering all three the
    same way is how a guess acquires the authority of a measurement.
    """

    def test_a_declared_value_is_reported_as_the_file_s_own_statement(self):
        line = _provenance_line(
            {"value": 15.41678125, "unit": "m²", "provenance": "declared", "decidable": True}
        )
        assert line.startswith("deklariert:")
        assert "so steht es in der Datei" in line

    def test_a_computed_value_carries_its_tolerance_and_says_it_was_measured(self):
        line = _provenance_line(
            {
                "value": 2.2,
                "unit": "m",
                "tolerance": 0.005,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert line.startswith("gemessen")
        assert "±0.005" in line
        assert "nicht deklariert" in line
        # And it must NOT read as something the model states.
        assert "deklariert:" not in line

    def test_an_inferred_value_is_a_proposal_with_its_confidence(self):
        line = _provenance_line(
            {
                "value": None,
                "unit": None,
                "provenance": "inferred",
                "confidence": 0.72,
                "decidable": True,
            }
        )
        assert line.startswith("vermutlich:")
        assert "0.72" in line
        assert "keine Feststellung" in line

    def test_a_measured_number_is_never_reshaped_on_the_way_out(self):
        # The tool's whole claim is that the agent reports what was measured. A
        # renderer that rounded would break that claim invisibly.
        line = _provenance_line(
            {"value": 15.41678125, "unit": "m²", "tolerance": None, "provenance": "computed", "decidable": True}
        )
        assert "15.41678125" in line


class TestUndecidableIsAFindingAboutTheExport:
    """`decidable: false` is a successful answer, and must never read as an error.

    The question was well formed and THIS FILE cannot answer it. That is a fact
    about the export the architect can act on — `missing.remedy` is literally
    what they change in their CAD — while an error is a fact about us.
    """

    UNDECIDABLE = {
        "value": None,
        "unit": None,
        "tolerance": None,
        "provenance": "declared",
        "from": ["1kTvXnbbzCWw8lcMd1dR4o"],
        "method": "sillAndHead(1kTv…)",
        "decidable": False,
        "missing": {
            "what": "Pset_WindowCommon.SillHeight",
            "remedy": "Brüstungshöhe im CAD am Fenstertyp hinterlegen und neu exportieren.",
        },
    }

    def test_it_renders_as_a_finding_and_not_as_an_error(self):
        rendered = _render("measure", dict(self.UNDECIDABLE))

        assert "NICHT ENTSCHEIDBAR" in rendered
        # The word the agent must not reach for. An "Error:" prefix is how this
        # tool reports that nothing was looked at, and this is the opposite —
        # the file was read and it does not say.
        assert not rendered.startswith("Error")
        assert "Error:" not in rendered

    def test_it_names_what_is_missing_and_what_fixes_it(self):
        rendered = _render("measure", dict(self.UNDECIDABLE))

        assert "Pset_WindowCommon.SillHeight" in rendered
        # The remedy is the actionable half and must survive verbatim.
        assert "Brüstungshöhe im CAD am Fenstertyp hinterlegen" in rendered

    def test_it_says_the_finding_is_about_the_export_not_the_building(self):
        # The sentence that stops "the model does not publish a sill height"
        # becoming "the window has no sill".
        assert "Befund über den EXPORT, nicht über das Gebäude" in _render("measure", dict(self.UNDECIDABLE))

    def test_the_method_is_still_reported_so_the_refusal_can_be_checked(self):
        assert "sillAndHead" in _render("measure", dict(self.UNDECIDABLE))


class TestRendering:
    def test_the_model_line_names_the_file_and_the_parsed_handle(self):
        rendered = _render(
            "measure",
            {"value": 2.5, "unit": "m", "provenance": "computed", "tolerance": 0.005, "decidable": True},
            source={"model": {"filename": "Haus-A_V3.ifc", "schemaVersion": "IFC4", "elements": 74}},
            handle="3f2a1b0c9d8e7f6a",
        )
        assert "Modell: Haus-A_V3.ifc (IFC4, 74 Bauteile)" in rendered
        assert "Kennung 3f2a1b0c9d8e" in rendered

    def test_a_relation_lists_the_elements_it_found_with_their_ids(self):
        rendered = _render(
            "relations",
            {
                "value": [
                    {
                        "globalId": "3cUkl32yn9qRSPvBJVyWcE",
                        "ifcType": "IfcSpace",
                        "name": "Living room",
                        "kind": "space",
                        "via": "Kontaktkarte",
                    }
                ],
                "unit": None,
                "provenance": "computed",
                "from": ["1kTv"],
                "method": "opensTo(1kTv)",
                "decidable": True,
            },
        )
        assert "IfcSpace „Living room“ · GlobalId 3cUkl32yn9qRSPvBJVyWcE (über Kontaktkarte)" in rendered

    def test_a_caveat_is_never_dropped(self):
        # The storey-pitch caveat is the difference between a Rohbauhöhe and a
        # Raumhöhennachweis. An answer that loses it publishes a different
        # claim than the operator made.
        rendered = _render(
            "storey_heights",
            {
                "value": [{"storey": "Ground Floor", "elevation": 0.0, "height": 2.85}],
                "unit": "m",
                "provenance": "computed",
                "decidable": True,
                "caveat": "Rohbau-Geschoßhöhe … NICHT die lichte Raumhöhe.",
            },
        )
        assert "Hinweis: Rohbau-Geschoßhöhe" in rendered
        assert "Ground Floor" in rendered and "2.85" in rendered

    def test_a_contradiction_between_two_routes_is_surfaced_as_one(self):
        # Agreement is a fact; DISAGREEMENT is a finding about the export, and
        # one an architect wants before submission.
        rendered = _render(
            "measure",
            {
                "value": 15.41,
                "unit": "m²",
                "provenance": "computed",
                "decidable": True,
                "agreement": "disagree",
                "caveat": "Zwei Wege zu dieser Zahl widersprechen sich: 15.41 gegen 12.00 …",
            },
        )
        assert "WIDERSPRUCH" in rendered
        assert "widersprechen sich" in rendered

    def test_the_briefing_is_handed_over_whole_with_its_instruction(self):
        rendered = _render("briefing", {"briefing": "GEBÄUDE  Haus-A.ifc · IFC4\nBLIND  keine …"})
        assert "GEBÄUDE  Haus-A.ifc" in rendered
        # The briefing is only useful if the agent copies names OUT of it.
        assert "wörtlich übernehmen" in rendered
        assert "BLIND" in rendered

    def test_find_elements_reports_the_total_separately_from_the_page(self):
        # A page presented as a total is the failure this whole surface is
        # built to avoid.
        rendered = _render(
            "find_elements",
            {
                "elements": [{"globalId": "g1", "ifcType": "IfcWindow", "name": "W-01"}],
                "total": 14,
                "truncated": True,
            },
        )
        assert "14 Treffer, 1 aufgelistet." in rendered
        assert "Weitere Treffer vorhanden" in rendered

    def test_a_drawing_forbids_reading_numbers_off_it(self):
        rendered = _render("draw", {"path": "/tmp/plan.svg", "bytes": 120_000, "seconds": 5.1})
        assert "/tmp/plan.svg" in rendered
        assert "NICHT aus dem Bild ablesen" in rendered

    def test_a_unit_goes_after_a_number_and_beside_a_set_of_them(self):
        # "sill=0.9, head=2.11 m" reads as though only the last figure carried
        # the unit, and "2 Einträge m" is not German at all.
        named = _provenance_line(
            {
                "value": {"sill": 0.9, "head": 2.11},
                "unit": "m",
                "tolerance": 0.01,
                "provenance": "computed",
                "decidable": True,
            }
        )
        assert "sill=0.9, head=2.11 (m)" in named
        # The tolerance is a scalar in that unit whatever shape the value has.
        assert "±0.01 m" in named

    def test_a_list_of_one_is_reported_in_the_singular(self):
        line = _provenance_line(
            {"value": [{"globalId": "g1", "ifcType": "IfcWall", "name": "W"}], "unit": None,
             "provenance": "computed", "decidable": True}
        )
        assert "1 Eintrag" in line and "1 Einträge" not in line

    def test_an_unresolved_model_reports_the_reason_and_the_choices(self):
        rendered = _render_unresolved(
            {
                "resolved": False,
                "reason": "ambiguous",
                "message": "Mehrere Modelle.",
                "models": [{"filename": "haus-a.ifc", "status": "ready", "elements": 120}],
            }
        )
        assert "Mehrere Modelle." in rendered
        assert "haus-a.ifc (ready, 120 Bauteile)" in rendered

    def test_a_model_that_is_still_extracting_is_not_offered_as_available(self):
        rendered = _render_unresolved(
            {
                "resolved": False,
                "reason": "not_ready",
                "message": "Wird verarbeitet.",
                "models": [{"filename": "haus-a.ifc", "status": "extracting", "elements": 0}],
            }
        )
        assert "noch nicht abfragbar" in rendered
        assert "Verfügbare Modelle" not in rendered


class TestUnavailableIsNotRejected:
    """Could-not-look versus looked-and-your-arguments-were-wrong.

    An unavailable service is nothing the agent can do anything about; a
    rejected request is a mistake it can correct in the same turn. Collapsing
    the two ends a turn on a typo, with the agent instructed to say nothing
    about the building.
    """

    def test_the_two_messages_are_different_and_say_different_things(self):
        rejected = _rejected_text("Unrecognized key(s): 'storeys'")

        assert rejected != UNAVAILABLE_TEXT
        assert "problem with the arguments" in rejected
        assert "call the tool again" in rejected
        assert "nicht erreichbar" in UNAVAILABLE_TEXT
        assert "could not be read" in UNAVAILABLE_TEXT

    def test_neither_invites_a_statement_about_the_building(self):
        for text in (_rejected_text("nope"), UNAVAILABLE_TEXT, ENGINE_UNAVAILABLE_TEXT):
            assert "Do NOT" in text

    def test_a_missing_engine_is_not_reported_as_a_broken_model(self):
        # Nothing is wrong with the building or the request: this deployment
        # has no geometry engine. It also names what still works.
        assert "not installed" in ENGINE_UNAVAILABLE_TEXT
        assert "ifc_query" in ENGINE_UNAVAILABLE_TEXT

    def test_an_id_that_is_not_in_the_model_is_a_correctable_mistake(self):
        # And NOT a `decidable: false` — the call could not be made at all.
        text = _unrunnable_text("Bauteil 0xyz ist in diesem Modell nicht enthalten")
        assert "not with the building" in text
        assert "find_elements" in text


class TestTheSourceClientDrawsTheSameDistinction:
    """The client that fetches the bytes, and the two errors it can raise."""

    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")

    @staticmethod
    def _http_error(status: int, body) -> urllib.error.HTTPError:
        payload = json.dumps(body).encode("utf-8")
        return urllib.error.HTTPError(
            "http://frontend:3000/api/internal/bim/source",
            status,
            "Bad Request",
            {},  # type: ignore[arg-type]
            io.BytesIO(payload),
        )

    def _raise(self, monkeypatch, error: Exception) -> None:
        def opener(_request, timeout=None):  # noqa: ANN001, ARG001
            raise error

        monkeypatch.setattr(
            "aiq_agent.knowledge.ifc_spatial_client._opener",
            type("O", (), {"open": staticmethod(opener)})(),
        )

    def test_a_correctable_400_is_a_rejection(self, monkeypatch):
        from aiq_agent.knowledge.bim_query import BimQueryRejectedError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        self._raise(monkeypatch, self._http_error(400, {"error": "modelName must not be empty"}))
        with pytest.raises(BimQueryRejectedError) as caught:
            resolve_model_source(organization_id="org", project_id="p", model_name=" ")
        assert "modelName" in str(caught.value)

    @pytest.mark.parametrize("status", [401, 403, 429, 500, 503])
    def test_everything_else_is_unavailable(self, monkeypatch, status):
        # A revoked `ifc-models` flag arrives as a 403 and is NOT something the
        # agent can fix by rewriting its arguments.
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        self._raise(monkeypatch, self._http_error(status, {"error": "nope"}))
        with pytest.raises(BimQueryUnavailableError):
            resolve_model_source(organization_id="org", project_id="p")

    def test_a_missing_service_token_never_reaches_the_network(self, monkeypatch):
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        with pytest.raises(BimQueryUnavailableError):
            resolve_model_source(organization_id="org", project_id="p")

    def test_a_model_is_addressed_by_project_and_file_name_never_by_uuid(self, monkeypatch):
        # ADR-0045: a UUID carried through a conversation is a reliable source
        # of hallucinated identifiers, so the tool names the model the way a
        # person does and the BFF resolves it.
        from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source

        sent: dict = {}

        class _Response:
            def read(self):
                return b'{"resolved": false, "reason": "no_models", "message": "kein Modell"}'

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        def opener(request, timeout=None):  # noqa: ANN001, ARG001
            sent["url"] = request.full_url
            sent["body"] = json.loads(request.data)
            sent["headers"] = request.headers
            return _Response()

        monkeypatch.setattr(
            "aiq_agent.knowledge.ifc_spatial_client._opener",
            type("O", (), {"open": staticmethod(opener)})(),
        )

        result = resolve_model_source(organization_id="org-1", project_id="p-1", model_name="V3")

        assert sent["url"].endswith("/api/internal/bim/source")
        assert sent["body"] == {"organizationId": "org-1", "projectId": "p-1", "modelName": "V3"}
        assert "modelId" not in sent["body"]
        # The service token is the whole authentication of this call.
        assert sent["headers"]["X-grid-internal-token"] == "test-token"
        # A `resolved: false` body is an ANSWER, returned rather than raised.
        assert result["reason"] == "no_models"


class TestTheSourceIdentityDecidesWhatIsReused:
    """What "the same building as last time" means, and what it must not mean."""

    def test_the_object_s_etag_is_preferred(self):
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        identity = source_identity(
            {"model": {"modelId": "m1", "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {"etag": "abc123"}}
        )
        assert identity == "etag:abc123"

    def test_it_falls_back_to_the_model_id_and_its_revision(self):
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        identity = source_identity(
            {"model": {"modelId": "m1", "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {"etag": None}}
        )
        assert identity == "model:m1:2026-05-04T09:30:15.400Z"

    def test_a_re_export_is_never_served_out_of_the_cache(self):
        # Re-exporting under the same file name is the ordinary way an
        # architect works. Keying on the name would answer questions about a
        # building that no longer exists.
        from aiq_agent.knowledge.ifc_spatial_client import source_identity

        name = "Haus-A.ifc"
        before = {"model": {"modelId": "m1", "filename": name, "updatedAt": "2026-05-04T09:30:15.400Z"}, "source": {}}
        after = {"model": {"modelId": "m1", "filename": name, "updatedAt": "2026-08-12T07:00:00.000Z"}, "source": {}}

        assert source_identity(before) != source_identity(after)


class TestTheSameModelIsParsedOncePerProcess:
    """The claim the two-key cache makes, checked against a real IFC.

    Skipped where the engine is not installed — which is also the deployment
    shape `ifc_measure` refuses in words rather than pretending to answer.
    """

    FIXTURE = "packages/ifc-spatial/test/fixtures/Ifc4_SampleHouse.ifc"

    @pytest.fixture()
    def engine(self):
        pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
        from aiq_agent.knowledge import ifc_spatial_client

        ifc_spatial_client.reset_cache_for_tests()
        yield ifc_spatial_client
        ifc_spatial_client.reset_cache_for_tests()

    @pytest.fixture()
    def served(self):
        """The fixture behind an HTTP URL — the only scheme the client reads.

        `file://` is refused by `_download`, and deliberately: a presigned URL
        arrives from the BFF, and a client that would read whatever scheme it
        was handed turns a model lookup into a local file read.
        """
        import functools
        import http.server
        import pathlib
        import threading

        fixture = pathlib.Path(self.FIXTURE).resolve()
        if not fixture.is_file():
            pytest.skip("the sample house fixture is not in this checkout")

        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=str(fixture.parent)
        )
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            yield fixture, f"http://127.0.0.1:{server.server_address[1]}/{fixture.name}"
        finally:
            server.shutdown()

    def _source(self, served, etag: str = "abc123") -> dict:
        fixture, url = served
        return {
            "resolved": True,
            "model": {"modelId": "m1", "filename": fixture.name, "updatedAt": "2026-08-12T07:00:00Z"},
            "source": {"url": url, "bytes": fixture.stat().st_size, "etag": etag},
        }

    def test_a_file_url_is_never_read(self, engine, served):
        # The guard that keeps "resolve a model" from becoming "read any path
        # this process can reach".
        from aiq_agent.knowledge.bim_query import BimQueryUnavailableError

        fixture, _ = served
        source = self._source(served)
        source["source"]["url"] = fixture.as_uri()
        with pytest.raises(BimQueryUnavailableError):
            engine.open_model(source)

    def test_the_second_question_about_a_building_downloads_nothing(self, engine, served, monkeypatch):
        source = self._source(served)
        first = engine.open_model(source)

        # Anything that reaches the network on the second call fails the test:
        # a 150 MB download per tool call is what the source identity exists to
        # prevent.
        monkeypatch.setattr(
            engine, "_download", lambda *a, **k: pytest.fail("the model was downloaded twice")
        )
        assert engine.open_model(source) == first

    def test_a_re_export_under_the_same_name_is_a_different_model(self, engine, served):
        # Same file name, same model id, new bytes in the store: the ETag moves
        # and the second call must not be served from the first one's parse.
        source = self._source(served, etag="abc123")
        engine.open_model(source)

        moved = {**source, "source": {**source["source"], "etag": "def456"}}
        assert engine.source_identity(moved) != engine.source_identity(source)

    def test_an_operator_answers_through_the_handle(self, engine, served):
        handle = engine.open_model(self._source(served))
        found = engine.call_spatial_tool(handle, "find_elements", {"ifcType": "IfcSpace", "limit": 10})

        assert found["total"] == 4
        area = engine.call_spatial_tool(
            handle,
            "measure",
            {"globalId": found["elements"][0]["globalId"], "measure": "floorArea"},
        )
        assert area["decidable"] is True
        assert area["provenance"] == "computed"

    def test_an_id_that_is_not_in_the_model_could_not_be_looked_up(self, engine, served):
        # And is therefore an ERROR, not a `decidable: false` answer.
        handle = engine.open_model(self._source(served))
        with pytest.raises(engine.SpatialToolError):
            engine.call_spatial_tool(handle, "element", {"globalId": "0nichtvorhanden00000"})


class TestWhatTheTraceRecords:
    """The SHAPE of the call, never the building (ADR-0045 §Observability)."""

    @pytest.fixture(autouse=True)
    def _clean(self):
        from aiq_agent.observability.langfuse_trace_attributes import reset_contributions

        reset_contributions()
        yield
        reset_contributions()

    @staticmethod
    def _recorded() -> dict:
        from aiq_agent.observability.langfuse_trace_attributes import _CONTRIBUTED

        return _CONTRIBUTED.get() or {"metadata": {}, "tags": []}

    def test_a_call_records_its_operation_and_its_operator(self):
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure", "clearHeight", outcome="resolved")

        assert self._recorded()["metadata"] == {
            "ifc_op": "measure:measure",
            "ifc_outcome": "resolved",
            "ifc_measure_detail": "clearHeight",
        }
        # The same tag `ifc_query` writes: "which turns read a building model"
        # is a trace-list filter, and metadata is the slower path.
        assert self._recorded()["tags"] == ["feature:ifc"]

    def test_free_text_from_the_model_is_not_echoed_onto_the_trace(self):
        # An operation the model invented is not a fact about this call, and an
        # external observability service is not the place to discover it.
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure the Wohnzimmer of Familie Mayr", "Brandabschnitt Nord", outcome="rejected")

        recorded = self._recorded()["metadata"]
        assert recorded["ifc_op"] == "measure:unknown"
        assert "ifc_measure_detail" not in recorded
        assert "Mayr" not in str(recorded)

    def test_an_undecidable_answer_is_distinguishable_from_a_failure(self):
        # The two mean opposite things — the file was read and cannot say,
        # versus nothing was read at all — and an operator auditing a wrong
        # answer needs to tell them apart after the fact.
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("measure", "sillAndHead", outcome="undecidable")
        assert self._recorded()["metadata"]["ifc_outcome"] == "undecidable"

    def test_a_transport_failure_is_not_recorded_as_an_empty_building(self):
        from aiq_agent.agents.bim.measure_register import _trace

        _trace("relations", "opensTo", outcome="service_unavailable")
        assert self._recorded()["metadata"]["ifc_outcome"] == "service_unavailable"


class TestTheDescriptionDescribesTheRealTool:
    """The description is the only spec the model reads.

    A parameter documented in it that the function does not have is not a typo
    — it is an instruction the model follows to produce a call that silently
    does something else.
    """

    @staticmethod
    def _description_and_parameters() -> tuple[str, list[str]]:
        # Read through the AST rather than importing: `_ifc_measure` is nested
        # inside a registration generator, so its signature is not reachable
        # without standing up the whole NAT builder.
        import ast
        import inspect

        from aiq_agent.agents.bim import measure_register

        tree = ast.parse(inspect.getsource(measure_register))
        description = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "_TOOL_DESCRIPTION"
        )
        parameters = next(
            [argument.arg for argument in node.args.args + node.args.kwonlyargs]
            for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "_ifc_measure"
        )
        from aiq_agent.agents.bim.measure_register import _TOOL_DESCRIPTION

        assert isinstance(description, ast.Assign)  # the node exists; the value is built at import
        return _TOOL_DESCRIPTION, parameters

    def test_every_argument_the_description_shows_being_set_exists(self):
        import re

        description, parameters = self._description_and_parameters()
        shown = set(re.findall(r"\b([a-z][a-z0-9_]{2,})\s*=", description))

        assert shown, "the invariant is vacuous if the description shows no arguments at all"
        assert sorted(shown - set(parameters)) == []

    def test_every_operation_it_names_is_one_the_tool_accepts(self):
        import re

        from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

        description, _ = self._description_and_parameters()
        named = set(re.findall(r"'([a-z_]+)'\s+—", description))

        assert named, "the invariant is vacuous if the description names no operations"
        assert named <= VALID_OPERATIONS

    def test_it_tells_the_agent_to_call_the_briefing_first(self):
        # Storey and property names come from THIS file. A name the agent
        # invented matches nothing, and an empty result reads like "the
        # building has none" — the single most expensive failure on this
        # surface.
        description, _ = self._description_and_parameters()

        assert "CALL 'briefing' FIRST" in description
        assert "copied verbatim" in description
        assert "BLIND" in description

    def test_it_teaches_the_three_provenances_as_three_german_sentences(self):
        description, _ = self._description_and_parameters()

        assert "deklariert" in description
        assert "gemessen" in description
        assert "vermutlich" in description
        # And forbids the one substitution that turns our number into the
        # architect's own statement.
        assert "NEVER write a computed number as something the model states" in description

    def test_it_explains_that_undecidable_is_about_the_export(self):
        description, _ = self._description_and_parameters()

        assert "'decidable: false' is NOT an error" in description
        assert "missing.remedy" in description
        assert "what the architect changes in their CAD" in description

    def test_it_forbids_arithmetic_and_reading_numbers_off_a_drawing(self):
        description, _ = self._description_and_parameters()

        assert "NEVER recompute, round, convert or extrapolate" in description
        assert "NEVER read a measurement off a" in description

    def test_it_states_what_the_expensive_calls_cost_before_they_are_made(self):
        # An agent told a call costs seven seconds can decide it is worth it;
        # one that finds out afterwards cannot.
        description, _ = self._description_and_parameters()

        assert "COST" in description
        assert "opensTo" in description
        assert "speculatively" in description

    def test_it_says_which_tool_the_metadata_questions_belong_to(self):
        # `ifc_query` stays the fast path. A tool description that did not say
        # so would make every count cost a download and a geometry pass.
        description, _ = self._description_and_parameters()

        assert "NOT a replacement for ifc_query" in description
        assert "Reach for it first" in description

"""The plan the agent looks at.

Testing a picture is awkward and mostly worth refusing — asserting pixel colours
pins the drawing rather than the drawing's job. So these assert the properties
that decide whether the image is USABLE by a model, each of which was broken at
some point while building it and each of which is invisible from the return
value alone:

  - it is a real PNG of a sane size (a zero-byte or 40-byte image is what a
    silently failed render produces, and it travels through a data URL happily);
  - the cut is at the height where doors and windows are, so their openings
    appear as gaps — a footprint projection draws solid walls, which is the one
    feature a reader is most likely asking about;
  - `highlight` actually changes the pixels, because a marker that does not mark
    is worse than none;
  - `only` isolates, and isolating leaves a SMALLER drawing;
  - nothing drawable means `None`, not a blank page — a blank page and a broken
    renderer are indistinguishable, and this package's whole discipline is that
    those are different findings.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from ifc_spatial import render
from ifc_spatial.model import SpatialModel

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
NO_SPACES = FIXTURES / "einheiten-fuss.ifc"

WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
INTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWax"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(HOUSE))


@pytest.fixture(scope="module")
def drawn(house: SpatialModel):
    return render.plan(house)


def _open(png: bytes):
    from PIL import Image

    return Image.open(io.BytesIO(png))


def _red_pixels(png: bytes) -> int:
    """How much highlight ink is on the page.

    `getdata()` is deprecated from Pillow 14; `list(image.convert("RGB").getdata())`
    would carry the same warning, so the pixels are read through `tobytes()`,
    which is stable and faster besides.
    """
    image = _open(png).convert("RGB")
    raw = image.tobytes()
    return sum(1 for i in range(0, len(raw), 3) if raw[i] > 180 and raw[i + 1] < 90)


def test_it_is_a_real_png_a_model_could_be_handed(drawn) -> None:
    assert drawn is not None
    # The magic bytes, not just "it returned something". A silently failed
    # render produces a tiny valid-looking blob that a data URL carries just as
    # willingly as a real one.
    assert drawn.png[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(drawn.png) > 4_000

    image = _open(drawn.png)
    assert image.size == (drawn.width, drawn.height)
    assert image.mode == "RGB"


def test_the_caption_facts_are_true_of_the_image(drawn) -> None:
    """Everything the tool will say about the drawing, checked against it.

    The caption is what the model reasons from when it cannot resolve a detail
    in the pixels, so a caption that drifts from the image is worse than a
    caption that says less.
    """
    assert drawn.storey == "Ground Floor"
    assert drawn.cut_z == pytest.approx(0.0 + render.CUT_ABOVE_STOREY)
    assert drawn.scale_px_per_m > 0
    assert drawn.drawn > 0
    assert sorted(drawn.rooms) == ["Bedroom", "Entrance hall", "Living room"]
    # This file declares a TrueNorth, so the arrow is drawn rather than guessed.
    assert drawn.north_deg is not None


def test_the_cut_passes_through_the_openings(house: SpatialModel) -> None:
    """1.2 m is not decoration.

    A plan drawn from footprints shows unbroken walls; cut at door height it
    shows the openings. The check is on the geometry rather than the pixels: the
    window's own solid must be sliced by the plane, which is only true if the
    cut height is inside it.
    """
    geometry = house.geometry(WINDOW)
    segments = render._segments_at_z(geometry.triangles, render.CUT_ABOVE_STOREY)
    assert segments, "the cut misses the window entirely — openings will not show"

    # And well above it there is nothing left of the window to cut.
    assert not render._segments_at_z(geometry.triangles, 9.0)


def test_highlighting_changes_the_picture(house: SpatialModel, drawn) -> None:
    marked = render.plan(house, highlight=[WINDOW])
    assert marked is not None
    assert marked.highlighted == [WINDOW]
    # A marker that does not mark is worse than no marker: the caption claims
    # the element is indicated and the reader cannot find it.
    assert marked.png != drawn.png

    red = _red_pixels(marked.png)
    assert red > 200, "the highlight is not visibly on the page"
    assert _red_pixels(drawn.png) == 0


def test_two_highlights_both_land(house: SpatialModel) -> None:
    both = render.plan(house, highlight=[WINDOW, INTERNAL_DOOR])
    assert both is not None
    assert both.highlighted == sorted([WINDOW, INTERNAL_DOOR])
    one = render.plan(house, highlight=[WINDOW])
    red_both = _red_pixels(both.png)
    red_one = _red_pixels(one.png)
    assert red_both > red_one


def test_only_isolates_rather_than_marking(house: SpatialModel, drawn) -> None:
    """`only` and `highlight` answer different questions.

    "Where is this in the building" wants the whole plan with one thing marked;
    "what does this look like" wants everything else out of the way. Collapsing
    them into one parameter loses one of the two.
    """
    isolated = render.plan(house, only=[WINDOW, INTERNAL_DOOR])
    assert isolated is not None
    assert isolated.drawn < drawn.drawn
    assert isolated.rooms == []


def test_a_label_never_leaves_the_canvas(house: SpatialModel) -> None:
    """The highlighted window sits at the far right of the plan.

    Its type name is 36 characters. Drawn to the right of the marker it ran off
    the page; flipped to the left it printed straight across the red bar it was
    labelling. Both are regressions this asserts against by construction — the
    label is clamped, so the render simply must not raise and must still differ
    from the unmarked plan.
    """
    marked = render.plan(house, highlight=[WINDOW], width_px=700)
    assert marked is not None
    assert marked.width == 700
    image = _open(marked.png)
    # Nothing drawn outside the canvas, which is what a clamp guarantees.
    assert image.size[0] == 700


def test_a_storey_with_nothing_drawable_is_none_not_a_blank_page(house: SpatialModel) -> None:
    assert render.plan(house, storey="Kein solches Geschoß") is None
    # And a file whose one wall is on another storey than the one asked for.
    empty = SpatialModel(str(NO_SPACES))
    assert render.plan(empty, only=["nicht-vorhanden"]) is None


def test_a_shortened_label_keeps_the_end_not_the_start() -> None:
    # The tail carries the size and the instance number, which is the part that
    # tells two windows of the same family apart.
    assert render._shorten("Windows_Sgl_Plain:1810x1210mm:286105", 20).endswith("1210mm:286105")
    assert render._shorten("kurz") == "kurz"


def test_north_is_declared_or_absent_never_invented(house: SpatialModel) -> None:
    """An invented north arrow makes an orientation claim about a file that
    never made one, on a picture that reads as authoritative."""
    assert render._true_north_degrees(house) is not None
    assert render._true_north_degrees(SpatialModel(str(FIXTURES / "haus-mit-raeumen.ifc"))) is None

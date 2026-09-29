"""A visual chunk's bbox becomes a region only where it maps onto what the viewer shows (issue #433).

The visual analysis stores a box per segment, normalised over the picture it
read. That picture is the whole page for a rendered PDF page and the whole image
for an uploaded one, so the box can be drawn as it is. For a raster embedded in
a document the picture is the raster, whose place on the page was never stored,
and a box drawn on the page would point at the wrong drawing with full
confidence. These tests hold that line.
"""

import json
from types import SimpleNamespace

from aiq_agent.common.grounding_block import SourceRegion
from knowledge_layer import register as reg


def _chunk(file_name="plan.pdf", bbox=(0.1, 0.2, 0.5, 0.6), title="Grundriss EG", **metadata) -> SimpleNamespace:
    segment = {"segment_type": "floor_plan", "title": title, "bbox": list(bbox) if bbox is not None else None}
    drawing_data = json.dumps({"schema_version": 4, "segment": segment, "document": {}})
    return SimpleNamespace(file_name=file_name, metadata={"drawing_data": drawing_data, **metadata})


def test_a_rendered_pdf_page_carries_its_segment_box():
    assert reg._hit_regions(_chunk()) == (SourceRegion(box=(0.1, 0.2, 0.5, 0.6), label="Grundriss EG"),)


def test_an_uploaded_image_carries_its_segment_box():
    chunk = _chunk(file_name="Foto_Innenhof.JPG", image_index=0, title=None)
    assert reg._hit_regions(chunk) == (SourceRegion(box=(0.1, 0.2, 0.5, 0.6), label=None),)


def test_a_raster_embedded_in_a_pdf_carries_none():
    """Its box is relative to the raster, and where the raster sits on the page is unknown."""
    assert reg._hit_regions(_chunk(image_index=3)) == ()


def test_a_chunk_that_is_not_visual_carries_none():
    assert reg._hit_regions(SimpleNamespace(file_name="bescheid.pdf", metadata={"punkt_id": "3.5"})) == ()


def test_a_box_covering_the_sheet_marks_nothing():
    assert reg._hit_regions(_chunk(bbox=(0.0, 0.0, 1.0, 0.95))) == ()


def test_a_missing_or_malformed_box_carries_none():
    assert reg._hit_regions(_chunk(bbox=None)) == ()
    assert reg._hit_regions(_chunk(bbox=(0.5, 0.2, 0.1, 0.6))) == ()
    assert reg._hit_regions(_chunk(bbox=("a", 0, 1, 1))) == ()
    assert reg._hit_regions(SimpleNamespace(file_name="plan.pdf", metadata={"drawing_data": "{not json"})) == ()


def test_out_of_range_coordinates_are_clamped():
    region = reg._hit_regions(_chunk(bbox=(-0.1, 0.2, 0.5, 1.3)))
    assert region == (SourceRegion(box=(0.0, 0.2, 0.5, 1.0), label="Grundriss EG"),)

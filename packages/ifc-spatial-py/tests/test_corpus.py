"""One regression per defect the corpus run found — see ``CORPUS.md``.

The corpus itself is eleven third-party IFC files (buildingSMART, KIT/FZK, the
IfcOpenShell test repository, Revit sample projects) and **none of them are in
this repository**: they are other people's models, some tens of megabytes, and
committing them would be both a licensing problem and a 250 MB checkout. So
every defect they exposed is reproduced here from something this suite can
build: the in-repo sample house, a synthetic IFC written into ``tmp_path``, or —
for the pure geometry defects — an array of triangles with the offending
property.

That is deliberate and it is the stricter arrangement. A test that needs
``Trapelo_Design_Intent.ifc`` on disk is a test that silently skips in CI; a test
that writes a two-entity IFC in square feet runs everywhere and pins the same
behaviour.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ifc_spatial import operators as op
from ifc_spatial.model import (
    CONTACT_BUDGET_SECONDS,
    DERIVED_BOUNDARY_MAX_PRODUCTS,
    ModelTooLargeError,
    ModelUnreadableError,
    SpatialModel,
    UnknownElementError,
)

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"

BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
OPENING = "3cUkl32yn9qRSPvAVVyWcE"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"


@pytest.fixture(scope="module")
def model() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


# ════════════════════════════════════════════════════════════════════════════
# Defect 1 — a declared quantity was compared without converting its unit
# ════════════════════════════════════════════════════════════════════════════
#
# `Trapelo_Design_Intent.ifc` (Revit, IFC2X3, FOOT / SQUARE FOOT) declares
# `BaseQuantities.NetFloorArea = 68.1017516344055` for its ground-floor locker
# room. The geometry measures 6.3269 m². Those are the same room. `floor_area`
# compared 6.33 against 68.10, called it a 91 % disagreement and blamed the
# export — in an operator whose whole purpose is to report export defects.

#: A wall whose body is a degenerate profile (three identical points) extruded to
#: depth 0. The kernel builds nothing from it, which is the shape of the failure
#: 94 of 100 rooms in the corpus's ArchiCAD 18 export have.
_UNTESSELLATABLE = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('broken-body.ifc','2026-08-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'x',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'x',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','x','x');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCDIRECTION((1.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#8,#7,#6);
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#11=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#12=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#13=IFCUNITASSIGNMENT((#10,#11,#12));
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#15=IFCPROJECT('0aaaaaaaaaaaaaaaaaaaa0',#5,'P',$,$,$,$,(#14),#13);
#23=IFCLOCALPLACEMENT($,#9);
#30=IFCCARTESIANPOINT((0.,0.));
#33=IFCPOLYLINE((#30,#30,#30,#30));
#34=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'degenerate',#33);
#35=IFCEXTRUDEDAREASOLID(#34,#9,#7,0.);
#36=IFCSHAPEREPRESENTATION(#14,'Body','SweptSolid',(#35));
#37=IFCPRODUCTDEFINITIONSHAPE($,$,(#36));
#38=IFCWALL('0aaaaaaaaaaaaaaaaaaaa4',#5,'Broken Wall',$,$,#23,#37,$,$);
ENDSEC;
END-ISO-10303-21;
"""

_FEET_MODEL = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('feet.ifc','2026-08-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,'x',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'x',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','x','x');
#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#6=IFCDIRECTION((1.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#8,#7,#6);
#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#11=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.3048),#10);
#12=IFCCONVERSIONBASEDUNIT(#20,.LENGTHUNIT.,'FOOT',#11);
#13=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#14=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.09290304),#13);
#15=IFCCONVERSIONBASEDUNIT(#21,.AREAUNIT.,'SQUARE FOOT',#14);
#20=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#21=IFCDIMENSIONALEXPONENTS(2,0,0,0,0,0,0);
#22=IFCUNITASSIGNMENT((#12,#15));
#23=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#24=IFCPROJECT('0aaaaaaaaaaaaaaaaaaaa0',#5,'P',$,$,$,$,(#23),#22);
#30=IFCLOCALPLACEMENT($,#9);
#31=IFCSPACE('0aaaaaaaaaaaaaaaaaaaa1',#5,'R1','room',$,#30,$,'Locker Room',.ELEMENT.,$,$);
#40=IFCQUANTITYAREA('NetFloorArea','area measured in geometry',$,68.1017516344055,$);
#41=IFCELEMENTQUANTITY('0aaaaaaaaaaaaaaaaaaaa2',#5,'BaseQuantities',$,$,(#40));
#42=IFCRELDEFINESBYPROPERTIES('0aaaaaaaaaaaaaaaaaaaa3',#5,$,$,(#31),#41);
ENDSEC;
END-ISO-10303-21;
"""


def test_a_declared_area_in_square_feet_is_read_in_metres(tmp_path: Path) -> None:
    path = tmp_path / "feet.ifc"
    path.write_text(_FEET_MODEL)
    model = SpatialModel(str(path))
    space = model.file.by_guid("0aaaaaaaaaaaaaaaaaaaa1")

    found = model.declared_quantity(space, ("NetFloorArea",))
    assert found is not None
    assert found.raw == pytest.approx(68.1017516344055)
    assert found.unit_label == "SQUARE FOOT"
    assert found.scale == pytest.approx(0.09290304)
    # 68.10 ft² is 6.327 m². Before the fix this came back as 68.10 and was
    # compared against a measurement in metres.
    assert found.value == pytest.approx(6.3269, abs=1e-3)


def test_the_length_unit_does_not_decide_the_area_unit(model: SpatialModel) -> None:
    """The sample house measures in MILLIMETRES and declares areas in m².

    Which is why `unit_scale ** 2` is the wrong conversion and was never used:
    it would have divided this file's room areas by a million. The area unit is
    read on its own.
    """
    assert model.unit_scale == pytest.approx(0.001)
    found = model.declared_quantity(model.file.by_guid(BEDROOM), ("NetFloorArea",))
    assert found is not None
    assert found.scale == 1.0
    assert found.value == pytest.approx(15.41678125)


def test_a_quantity_set_outranks_a_look_alike_property_set(tmp_path: Path) -> None:
    """`PSet_Revit_Dimensions.Area` must not beat `Qto_SpaceBaseQuantities`.

    On the Duplex apartment it did, because `get_psets` merges quantity sets and
    property sets into one dictionary and the old search took whichever pset
    iterated first.
    """
    body = _FEET_MODEL.replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        """#50=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(999.),$);
#51=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaa4',#5,'PSet_Revit_Dimensions',$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('0aaaaaaaaaaaaaaaaaaaa5',#5,$,$,(#31),#51);
ENDSEC;
END-ISO-10303-21;""",
    )
    path = tmp_path / "both.ifc"
    path.write_text(body)
    model = SpatialModel(str(path))
    space = model.file.by_guid("0aaaaaaaaaaaaaaaaaaaa1")

    found = model.declared_quantity(space, ("NetFloorArea", "NetArea", "GrossFloorArea", "Area"))
    assert found is not None
    assert found.path == "BaseQuantities.NetFloorArea"


# ════════════════════════════════════════════════════════════════════════════
# Defect 2 — a space wound inside-out measured 0 m² of floor
# ════════════════════════════════════════════════════════════════════════════
#
# The Duplex apartment's *Hallway* (Revit, IFC2X3) is a closed solid with 28
# downward-facing triangles and none facing up. `util.shape.get_footprint_area`
# keeps only faces pointing towards +Z, so it returned 0.0 — and `floor_area`
# published that zero with a caveat saying the element has no horizontal
# surfaces, which was false, and triangulated it against a declared 7.80 m².


def _unit_box_triangles(flip: bool) -> np.ndarray:
    """A 2 × 3 × 1 m box as triangles, optionally wound inside-out."""
    x, y, z = 2.0, 3.0, 1.0
    corners = np.array(
        [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]],
        dtype=float,
    )
    faces = [
        (0, 2, 1), (0, 3, 2),  # bottom, pointing −Z
        (4, 5, 6), (4, 6, 7),  # top, pointing +Z
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]
    if flip:
        faces = [(c, b, a) for a, b, c in faces]
    return corners[np.array(faces)]


def test_a_footprint_is_measured_whichever_way_the_mesh_is_wound() -> None:
    outward = op._footprint_area(_unit_box_triangles(flip=False))
    inward = op._footprint_area(_unit_box_triangles(flip=True))
    assert outward == pytest.approx(6.0)
    # This was 0.0 before the fix — a confident zero on a 6 m² floor.
    assert inward == pytest.approx(6.0)


def test_the_union_still_refuses_to_double_count() -> None:
    """A stepped floor: two horizontal faces over the same plan, at two heights.

    The reason `get_footprint_area` was chosen over summing projected areas in
    the first place. Taking the maximum of two directions must not undo it.
    """
    lower = _unit_box_triangles(flip=False)
    upper = lower + np.array([0.0, 0.0, 0.5])
    both = np.concatenate([lower, upper])
    assert op._footprint_area(both) == pytest.approx(6.0)


def test_zero_is_still_the_answer_for_something_with_no_horizontal_face() -> None:
    """The fix must not invent a floor where there is none.

    A vertical plate has no face pointing either up or down, so both projections
    are empty and 0 m² is the measurement — which `floor_area` says in as many
    words rather than reporting it as a missing value.
    """
    plate = np.array(
        [
            [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [3.0, 0.0, 2.5]],
            [[0.0, 0.0, 0.0], [3.0, 0.0, 2.5], [0.0, 0.0, 2.5]],
        ]
    )
    assert op._footprint_area(plate) == 0.0


def test_a_walls_own_footprint_is_unchanged(model: SpatialModel) -> None:
    """The sample house's north wall measured 4.10205 m² of footprint before the
    winding fix and must measure it after."""
    assert op.floor_area(model, NORTH_WALL).value == pytest.approx(4.10205, abs=1e-5)


def test_the_sample_house_room_areas_do_not_move(model: SpatialModel) -> None:
    """The regression guard on the regression: the corrected footprint must
    reproduce the numbers the parity suite was built on, to 1e-9 m²."""
    for global_id, expected in (
        ("3w0zWKm7n8SB1qbfwUzt0J", 15.41678125),
        ("3w0zWKm7n8SB1qbfwUzt0U", 51.994825),
        ("3w0zWKm7n8SB1qbfwUzt0G", 8.69350625),
    ):
        assert op.floor_area(model, global_id).value == pytest.approx(expected, abs=1e-9)


# ════════════════════════════════════════════════════════════════════════════
# Defect 3 — every way a file can fail to open produced a different exception
# ════════════════════════════════════════════════════════════════════════════


def test_an_empty_file_is_refused_with_a_reason(tmp_path: Path) -> None:
    path = tmp_path / "empty.ifc"
    path.write_bytes(b"")
    with pytest.raises(ModelUnreadableError) as raised:
        SpatialModel(str(path))
    assert "leer" in raised.value.reason


def test_a_missing_file_is_refused_with_a_reason(tmp_path: Path) -> None:
    with pytest.raises(ModelUnreadableError):
        SpatialModel(str(tmp_path / "nope.ifc"))


def test_a_directory_is_refused_with_a_reason(tmp_path: Path) -> None:
    with pytest.raises(ModelUnreadableError) as raised:
        SpatialModel(str(tmp_path))
    assert "Verzeichnis" in raised.value.reason


def test_something_that_is_not_ifc_is_refused_with_a_reason(tmp_path: Path) -> None:
    path = tmp_path / "image.ifc"
    path.write_bytes(b"\x89PNG\r\n\x1a\n and then some bytes")
    with pytest.raises(ModelUnreadableError) as raised:
        SpatialModel(str(path))
    assert "ISO-10303-21" in raised.value.reason


def test_an_unsupported_schema_is_refused_with_a_reason(tmp_path: Path) -> None:
    path = tmp_path / "schema.ifc"
    path.write_text(_FEET_MODEL.replace("IFC4", "IFCNOPE"))
    with pytest.raises(ModelUnreadableError) as raised:
        SpatialModel(str(path))
    assert "IFCNOPE" in raised.value.reason


def test_a_truncated_file_is_refused_before_the_parser_crashes(tmp_path: Path) -> None:
    """The one that is not a nicety.

    ``ifcopenshell.open`` **segfaults** on a file cut mid-entity — measured on
    the Duplex export at 100 000 and at 300 000 bytes, both times a
    SIGSEGV that no ``except`` can catch and that takes the whole process with
    it. A complete SPF file ends with ``END-ISO-10303-21;``, so the bytes are
    checked before the parser ever sees them.
    """
    whole = SAMPLE_HOUSE.read_bytes()
    path = tmp_path / "cut.ifc"
    path.write_bytes(whole[: len(whole) // 3])
    with pytest.raises(ModelUnreadableError) as raised:
        SpatialModel(str(path))
    assert "unvollständig" in raised.value.reason
    assert "END-ISO-10303-21" in raised.value.reason


def test_a_file_too_large_for_this_process_is_refused_not_attempted(tmp_path: Path) -> None:
    """A real limit gets a stated refusal, not an attempt that dies.

    A 22 MB IFC2X3 export reaches 3.1 GB of resident memory in the geometry pass
    and the tree build. There is a size above which starting is the wrong move,
    and the caller has to be told which one it is.
    """
    path = tmp_path / "big.ifc"
    path.write_text(_FEET_MODEL)
    with pytest.raises(ModelTooLargeError) as raised:
        SpatialModel(str(path), max_bytes=100)
    assert "Worker" in raised.value.reason
    assert raised.value.limit == 100


def test_a_valid_header_with_no_entities_is_a_model_not_an_error(tmp_path: Path) -> None:
    """An empty model must answer, not raise: every model-wide read is defined."""
    path = tmp_path / "header.ifc"
    path.write_text(
        "ISO-10303-21;\nHEADER;\n"
        "FILE_DESCRIPTION((''),'2;1');\n"
        "FILE_NAME('h.ifc','2026-08-12T00:00:00',(''),(''),'','','');\n"
        "FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
    )
    model = SpatialModel(str(path))
    assert model.geometry_pass() == {}
    assert model.bounds is None
    assert model.plan_centre is None
    assert model.storeys == []
    assert model.true_north is None
    assert model.georeferenced is False
    assert model.space_contacts() == {}
    # A ray with no stated length has no reach in a model with no extent, and
    # says so instead of scanning the 100 m `diagonal` falls back to and
    # reporting "nothing hit" as a result.
    unbounded = op.ray(model, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    assert unbounded.decidable is False
    assert "keine Modellausdehnung" in unbounded.missing.what
    # With an explicit length it is a real answer: nothing is there.
    stated = op.ray(model, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], length=10.0)
    assert stated.decidable is True
    assert stated.value is None
    with pytest.raises(UnknownElementError):
        op.extent(model, "3w0zWKm7n8SB1qbfwUzt0J")


# ════════════════════════════════════════════════════════════════════════════
# Defect 4 — a non-GlobalId reached an operator and answered about the wrong thing
# ════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("bad", [None, 123, "", "   ", 4.5, b"3w0zWKm7n8SB1qbfwUzt0J"])
def test_anything_that_is_not_a_global_id_raises_the_contract_error(model: SpatialModel, bad) -> None:
    """`file.by_guid` is lenient in two ways that are both dangerous here.

    `by_guid(None)` returns `None`, and the operator then dies of an
    `AttributeError` several frames later; `by_guid(123)` falls through to lookup
    **by entity id** and hands back `#123`, a real entity of the wrong kind for
    an id nobody asked about. Both used to escape as unhandled exceptions or, in
    the second case, as an ANSWER about the wrong element.
    """
    with pytest.raises(UnknownElementError):
        model.by_id(bad, "test")
    with pytest.raises(UnknownElementError):
        op.extent(model, bad)
    with pytest.raises(UnknownElementError):
        op.hosted_in(model, bad)
    with pytest.raises(UnknownElementError):
        op.opens_to(model, bad)


def test_an_entity_id_is_not_a_global_id(model: SpatialModel) -> None:
    """`by_guid(<int>)` falls through to lookup by entity id and returns a real
    entity. It must not become an answer."""
    entity_id = model.file.by_guid(NORTH_WALL).id()
    assert model.file.by_guid(entity_id) is not None  # the entity exists…
    with pytest.raises(UnknownElementError):  # …and is still not a subject
        model.by_id(entity_id, "test")


# ════════════════════════════════════════════════════════════════════════════
# Defect 5 — a malformed prism reached the broad phase
# ════════════════════════════════════════════════════════════════════════════


def test_obstructions_refuses_a_volume_that_is_not_a_prism(model: SpatialModel) -> None:
    for volume in ({}, {"openingId": OPENING}, None, [], "prism"):
        answer = op.obstructions(model, volume)  # type: ignore[arg-type]
        assert answer.decidable is False
        assert "Prisma" in answer.missing.what


def test_obstructions_on_a_prism_from_another_model_raises(model: SpatialModel) -> None:
    """A cached prism naming an id this file does not contain is a wrong
    SUBJECT, not an undecidable question — the same rule as everywhere else."""
    volume = op.prism(model, OPENING, 45, 30).value
    assert volume is not None
    volume = dict(volume, openingId="0000000000000000000000")
    with pytest.raises(UnknownElementError):
        op.obstructions(model, volume)


# ════════════════════════════════════════════════════════════════════════════
# Defect 9 — an unhosted window came back as a bare empty list
# ════════════════════════════════════════════════════════════════════════════


def test_a_window_with_no_opening_chain_says_why_it_is_empty(model: SpatialModel) -> None:
    """The ArchiCAD 18 export in the corpus has 464 windows and doors and 79
    `IfcRelVoidsElement`: 84 % of its fenestration resolves to no host at all,
    because the wall body was exported with the hole already subtracted.

    `[]` is the true answer and reads as "this window is in no wall". The caveat
    has to say which of the two it is.
    """
    hosted = op.hosted_in(model, WINDOW)
    assert hosted.decidable and hosted.value  # this fixture DOES carry the chain
    assert "voids+fills" in hosted.caveat


def test_a_window_the_export_never_chained_says_so(tmp_path: Path) -> None:
    """The dialect itself, in nine entities: one window with an opening chain,
    one without, in a file that plainly has the relations."""
    body = _FEET_MODEL.replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        """#60=IFCWALL('0aaaaaaaaaaaaaaaaaaaa6',#5,'W1',$,$,#30,$,$,$);
#61=IFCOPENINGELEMENT('0aaaaaaaaaaaaaaaaaaaa7',#5,'O1',$,$,#30,$,$,$);
#62=IFCWINDOW('0aaaaaaaaaaaaaaaaaaaa8',#5,'chained',$,$,#30,$,$,$,$,$);
#63=IFCWINDOW('0aaaaaaaaaaaaaaaaaaaa9',#5,'orphan',$,$,#30,$,$,$,$,$);
#64=IFCRELVOIDSELEMENT('0aaaaaaaaaaaaaaaaaaab0',#5,$,$,#60,#61);
#65=IFCRELFILLSELEMENT('0aaaaaaaaaaaaaaaaaaab1',#5,$,$,#61,#62);
ENDSEC;
END-ISO-10303-21;""",
    )
    path = tmp_path / "chain.ifc"
    path.write_text(body)
    model = SpatialModel(str(path))

    chained = op.hosted_in(model, "0aaaaaaaaaaaaaaaaaaaa8")
    assert chained.decidable
    assert [r.global_id for r in chained.value] == ["0aaaaaaaaaaaaaaaaaaaa6"]
    assert "voids+fills" in chained.caveat

    orphan = op.hosted_in(model, "0aaaaaaaaaaaaaaaaaaaa9")
    assert orphan.decidable
    assert orphan.value == []
    # `[]` alone would be rendered as "sitzt in keiner Wand".
    assert "keine Öffnungskette" in orphan.caveat
    assert "Öffnungen und Füllungen" in orphan.caveat


# ════════════════════════════════════════════════════════════════════════════
# Defect 11 — geometry the kernel rejects was reported as geometry that is absent
# ════════════════════════════════════════════════════════════════════════════


def test_a_body_the_kernel_rejects_is_not_reported_as_a_missing_body(tmp_path: Path) -> None:
    """94 of the 100 rooms in the corpus's ArchiCAD 18 export carry a full `Body`
    representation that OCCT will not build (`Failed to process shape`).

    Telling that architect "dieses Bauteil trägt keinen Körper" sends them to
    re-export with a setting that is already on. The two failures need different
    sentences, so the kernel's own message travels with the refusal.
    """
    path = tmp_path / "broken-body.ifc"
    path.write_text(_UNTESSELLATABLE)
    model = SpatialModel(str(path))
    wall = "0aaaaaaaaaaaaaaaaaaaa4"

    assert model.geometry(wall) is None
    reason = model.geometry_failure(wall)
    assert reason is not None
    assert reason.startswith("shape-failed") or reason == "empty-mesh"

    answer = op.extent(model, wall)
    assert answer.decidable is False
    assert "nicht auswertbar" in answer.missing.what
    assert "Geometriekern" in answer.missing.remedy
    assert "ändert daran nichts" in answer.missing.remedy


def test_an_element_with_no_representation_at_all_says_that_instead(model: SpatialModel) -> None:
    orphan = next(
        (
            e
            for e in model.file.by_type("IfcProduct")
            if not getattr(e, "Representation", None) and not e.is_a("IfcSpace")
        ),
        None,
    )
    assert orphan is not None, "the sample house has products without a body"
    answer = op.extent(model, orphan.GlobalId)
    assert answer.decidable is False
    assert "keine geometrische Repräsentation" in answer.missing.what
    assert model.geometry_failure(orphan.GlobalId) == "no-representation"


# ════════════════════════════════════════════════════════════════════════════
# Defect 6 — a ray with a nonsense length answered anyway
# ════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("length", [-5.0, 0.0, float("inf"), float("nan")])
def test_a_ray_with_an_unusable_length_is_undecidable(model: SpatialModel, length: float) -> None:
    """OCCT happily returns a hit for a NEGATIVE length — behind the origin. The
    answer looked valid and was not."""
    answer = op.ray(model, [0.0, 0.0, 1.0], [0.0, 0.0, 1.0], length=length)
    assert answer.decidable is False
    assert "Länge > 0" in answer.missing.what


@pytest.mark.parametrize(
    "origin,direction",
    [([0, 0, 0], [0, 0, 0]), ([float("nan")] * 3, [0, 0, 1]), ("x", [0, 0, 1]), ([0, 0], [0, 0, 1])],
)
def test_a_ray_with_an_unusable_geometry_is_undecidable(model: SpatialModel, origin, direction) -> None:
    answer = op.ray(model, origin, direction)
    assert answer.decidable is False


# ════════════════════════════════════════════════════════════════════════════
# Defect 7 — deriving space boundaries had no time bound
# ════════════════════════════════════════════════════════════════════════════


def test_bounds_costs_one_offset_not_one_per_room(model: SpatialModel) -> None:
    """`bounds(space)` needs the contacts of THAT space.

    It used to build the model-wide map, which is one OCCT offset per room:
    **212 seconds** on a 99-room office export, inside one call about one
    window. The per-space path must not populate the whole map.
    """
    fresh = SpatialModel(str(SAMPLE_HOUSE))
    answer = op.bounds(fresh, "3w0zWKm7n8SB1qbfwUzt0J")
    assert answer.decidable
    covered = fresh._space_contacts.get(0.05, {})
    assert set(covered) == {"3w0zWKm7n8SB1qbfwUzt0J"}
    assert len(fresh.file.by_type("IfcSpace")) > 1


def test_an_incomplete_contact_map_refuses_instead_of_reporting_a_subset(
    model: SpatialModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the budget bites, the answer is a refusal that says how far it got.

    A partial map is indistinguishable from a building with fewer neighbours,
    and `opens_to` returning three rooms out of ninety-nine reads exactly like
    the truth.
    """
    fresh = SpatialModel(str(SAMPLE_HOUSE))
    monkeypatch.setattr("ifc_spatial.model.CONTACT_BUDGET_SECONDS", -1.0)
    answer = op.opens_to(fresh, WINDOW)
    assert answer.decidable is False
    assert "Zeitbudget" in answer.missing.remedy
    assert "Worker" in answer.missing.remedy
    assert fresh.contacts_complete is False


def test_a_model_too_large_to_derive_refuses_before_it_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The time budget can only be checked BETWEEN offsets.

    One `tree.select(space, extend=…)` is a single OCCT call with no
    interruption point — a `SIGALRM` set for 900 s did not stop one on the
    3 729-product Trapelo export, because a Python signal handler only runs when
    the interpreter regains control. So a model above the product threshold is
    refused before anything is started.
    """
    fresh = SpatialModel(str(SAMPLE_HOUSE))
    monkeypatch.setattr("ifc_spatial.model.DERIVED_BOUNDARY_MAX_PRODUCTS", 1)
    assert fresh.derivable_boundaries is False

    for answer in (
        op.bounds(fresh, BEDROOM),
        op.opens_to(fresh, WINDOW),
        op.enclosed_by(fresh, NORTH_WALL),
    ):
        assert answer.decidable is False
        assert answer.missing.what == "IfcRelSpaceBoundary"
        assert "zu groß" in answer.missing.remedy
        assert "Worker" in answer.missing.remedy


def test_the_limits_are_stated_as_numbers() -> None:
    assert CONTACT_BUDGET_SECONDS > 0
    assert DERIVED_BOUNDARY_MAX_PRODUCTS > 0

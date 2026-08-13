"""The IDS export, tested the only way an IDS can honestly be tested.

**Round trip, not string matching.** An IDS is not a document, it is a program:
its worth is entirely in what a checker does when it runs it. So no test here
asserts on XML text. Each one writes a file, re-opens it through
``ifctester.ids.open(..., validate=True)`` — which parses it against the
bundled ``ids.xsd`` 1.0 and would reject anything the standard does not allow —
and then runs it against real IFC files, asserting the specifications FAIL on a
model that lacks the thing and PASS on one that has it.

Both halves are needed and the second is the one that catches real bugs. A
specification that fails everything looks like a working shopping list right up
until the architect fixes the model, re-runs it and gets red rows anyway; at
that point the file has taught them to ignore us.

Three further properties are guarded because breaking them silently is cheap:

  - **no specification states a value.** The XML is searched for ``<value>``
    elements and ``dataType`` attributes, both of which IDS would happily carry
    and neither of which we may emit — a threshold shipped under our name into
    an architect's checker is the worst failure this module has available;
  - **nothing is dropped in silence.** Every finding the briefing produced comes
    out on exactly one of the two lists, and the counts add up;
  - **the property table is not invented.** Every entry claiming to be standard
    is verified against the IFC property-set templates that ship with
    IfcOpenShell, and the one entry that is a convention is verified NOT to be
    in them — so the flag cannot decay into a comfortable fiction.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import ifcopenshell
import ifcopenshell.guid
import ifcopenshell.util.pset
import pytest
from ifc_spatial.briefing import briefing
from ifc_spatial.envelope import MissingFact
from ifc_spatial.envelope import declared
from ifc_spatial.envelope import undecidable
from ifc_spatial.ids_export import PROPERTY_TARGETS
from ifc_spatial.ids_export import WHY_NO_SPACE_BOUNDARY
from ifc_spatial.ids_export import IdsExportError
from ifc_spatial.ids_export import answers_as_ids
from ifc_spatial.ids_export import blind_spots_as_ids
from ifc_spatial.ids_export import to_xml
from ifc_spatial.ids_export import write_ids
from ifc_spatial.model import SpatialModel
from ifctester import ids as ifctester_ids

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
#: No IfcRelSpaceBoundary; FireRating, Combustible, AcousticRating and
#: SillHeight filled nowhere. Georeferenced (51°30′N), so that spot stays quiet.
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: One wall, no spaces, no property sets at all, IFC2X3 — the richest source of
#: blind spots in the fixture set.
NO_SPACES = FIXTURES / "einheiten-fuss.ifc"

IDS_NS = "{http://standards.buildingsmart.org/IDS}"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(SAMPLE_HOUSE))


@pytest.fixture(scope="module")
def spaceless() -> SpatialModel:
    return SpatialModel(str(NO_SPACES))


def _written(document: Any, tmp_path: Path) -> Any:
    """Write, then read back through the schema — the file, not the object.

    Going through disk and through ``validate=True`` is the point: it is the
    only step in this module that proves a third-party tool can consume what we
    produce, and it is where a plausible-looking but non-conforming document
    dies.
    """
    facts = write_ids(document, directory=str(tmp_path))
    assert facts["path"] is not None
    return ifctester_ids.open(facts["path"], validate=True)


def _run(document: Any, ifc_path: Path) -> list[Any]:
    document.validate(ifcopenshell.open(str(ifc_path)))
    return list(document.specifications)


def _verdicts(document: Any, ifc_path: Path) -> dict[str, bool]:
    return {spec.name: bool(spec.status) for spec in _run(document, ifc_path)}


# ── the round trip ──────────────────────────────────────────────────────────


def test_the_sample_house_fails_the_specifications_derived_from_it(house: SpatialModel, tmp_path: Path) -> None:
    """Every demand made of this model is one this model does not meet.

    The list was computed FROM the file, so a specification that passes here is
    a specification asking for something the file already publishes — i.e. a
    shopping list with an item nobody needs to buy.
    """
    document = _written(blind_spots_as_ids(house), tmp_path)
    verdicts = _verdicts(document, SAMPLE_HOUSE)

    assert verdicts, "the sample house must yield at least one specification"
    assert not any(verdicts.values()), f"passed although derived from this very file: {verdicts}"
    # The four properties the fixture is known to leave empty, each demanded in
    # the property set the IFC schema puts it in.
    assert "Brüstungshöhe vorhanden (Pset_WindowCommon.SillHeight)" in verdicts
    assert "Feuerwiderstand vorhanden (Pset_WallCommon.FireRating)" in verdicts
    assert "Brennbarkeit vorhanden (Pset_WallCommon.Combustible)" in verdicts
    assert "Schallschutz vorhanden (Pset_WallCommon.AcousticRating)" in verdicts


def test_the_same_specifications_pass_on_a_model_that_carries_the_properties(
    house: SpatialModel, tmp_path: Path
) -> None:
    """The half that decides whether the export is worth shipping.

    The architect's move after reading the shopping list is to author the
    properties and re-export. If the file we handed them still shows red, we
    have sent them a check they cannot satisfy. So the identical IDS is run
    against a model built to contain exactly what it asks for.
    """
    document = _written(blind_spots_as_ids(house), tmp_path)
    specifications = _run(document, _model_with_the_properties(tmp_path))

    assert specifications
    for spec in specifications:
        # Applicability first. A specification that matched nothing also
        # "passes", and a test asserting only on the verdict would be green for
        # a file the checker never looked at — the vacuous-pass trap this whole
        # module is built to keep out of the architect's report.
        assert spec.applicable_entities, f"{spec.name} matched nothing — the pass would be vacuous"
        assert spec.passed_entities
        assert not spec.failed_entities
        assert bool(spec.status) is True, f"still failing after the properties were authored: {spec.name}"


def test_existence_and_georeference_specifications_pass_where_the_fact_is_present(
    spaceless: SpatialModel, tmp_path: Path
) -> None:
    """Cross-fixture: the demands made of the poorest file, run on a richer one.

    ``einheiten-fuss.ifc`` has no rooms and no coordinates, so its shopping list
    contains the two specifications no property facet can express — an entity
    that must exist, and an attribute that must be filled. The sample house has
    both (four ``IfcSpace``, 51°30′N), and passes them.
    """
    document = _written(blind_spots_as_ids(spaceless), tmp_path)

    own = _verdicts(document, NO_SPACES)
    assert own["Räume als IfcSpace exportiert"] is False
    assert own["Georeferenzierung am IfcSite"] is False

    richer = _verdicts(document, SAMPLE_HOUSE)
    assert richer["Räume als IfcSpace exportiert"] is True
    assert richer["Georeferenzierung am IfcSite"] is True
    # And the wall properties that file also lacks are still demanded — the
    # sample house publishes a U-value and a LoadBearing flag, so those pass,
    # while the fire rating it does not publish still fails. One IDS, three
    # different verdicts, all correct.
    assert richer["U-Wert vorhanden (Pset_WallCommon.ThermalTransmittance)"] is True
    assert richer["Feuerwiderstand vorhanden (Pset_WallCommon.FireRating)"] is False


def test_openings_must_resolve_to_a_host_and_the_sample_house_already_does(tmp_path: Path) -> None:
    """The ``partOf`` route, on the one relation IDS 1.0 does cover.

    ``IfcRelVoidsElement + IfcRelFillsElement`` is the only relation in this
    library's vocabulary that the standard's closed enumeration includes, so it
    is the only relation blind spot that becomes a specification at all.
    """
    answer = undecidable(
        from_=[],
        method="hostedIn(x)",
        missing=MissingFact(
            what="IfcRelVoidsElement + IfcRelFillsElement",
            remedy="Öffnungen und Füllungen mitexportieren",
        ),
    )
    document = _written(answers_as_ids([answer]), tmp_path)
    name = "Fenster und Türen einer Öffnung zugeordnet"

    # The sample house writes both relations for all seven of its windows and
    # doors, so this passes — a specification that failed here would be one no
    # correctly exported model could satisfy.
    assert _verdicts(document, SAMPLE_HOUSE)[name] is True
    # And it is vacuously satisfied where there are no openings at all, rather
    # than failing a building for not having windows.
    assert _verdicts(document, NO_SPACES)[name] is True


# ── the rule that may never break ───────────────────────────────────────────


def test_no_specification_states_a_value(house: SpatialModel, spaceless: SpatialModel) -> None:
    """Not one threshold, in any facet, in any document this module produces.

    A ``<value>`` under a property, attribute or classification facet is IDS's
    way of saying "and it must equal this". That is a legal claim, it belongs to
    the OIB-Richtlinie and the reviewer who signs it, and it may not leave this
    module under our name. ``dataType`` is refused for the neighbouring reason:
    it fails a model that has the fact we asked for, spelled differently.
    """
    for model in (house, spaceless):
        root = ElementTree.fromstring(to_xml(blind_spots_as_ids(model)))
        assert root.findall(f".//{IDS_NS}value") == []
        for facet in root.iter():
            assert "dataType" not in facet.attrib


def test_every_finding_lands_on_exactly_one_list(house: SpatialModel, spaceless: SpatialModel) -> None:
    """The count the summary prints is the count the briefing produced.

    A shopping list that loses items quietly is worse than one that names its
    own edges: the architect reads a green report and believes the model can now
    answer questions it still cannot.
    """
    for model in (house, spaceless):
        b = briefing(model)
        shopping = blind_spots_as_ids(model, brief=b)
        findings = len(b.blind_spots) + len(b.absent_properties)
        assert len(shopping.exported) + len(shopping.not_exportable) == findings
        assert str(findings) in shopping.summary()


def test_space_boundaries_are_reported_as_not_exportable_with_a_reason(house: SpatialModel) -> None:
    """The headline blind spot of this fixture, and IDS 1.0 cannot state it.

    The ``partOf`` relation enumeration does not contain ``IfcRelSpaceBoundary``
    and no other facet reaches a relationship object. Emitting it through the
    entity facet would run in ``ifctester`` and may be silently skipped
    elsewhere, and a silent skip reads as a pass.
    """
    shopping = blind_spots_as_ids(house)
    refusals = {entry.what: entry.why for entry in shopping.not_exportable}
    assert "keine IfcRelSpaceBoundary" in refusals
    assert refusals["keine IfcRelSpaceBoundary"] == WHY_NO_SPACE_BOUNDARY
    assert "IfcRelSpaceBoundary" not in to_xml(shopping)
    # The findings that are about this run rather than about the model must not
    # reach an architect's checker at all.
    assert any("Geometrie-Pass" in what for what in refusals)


def test_the_property_table_is_the_ifc_templates_and_says_so_when_it_is_not() -> None:
    """Every ``standard=True`` target is the schema's demand, not ours.

    And the single ``standard=False`` entry is verified to be absent from the
    templates, so that the day someone "tidies up" the flag the test fails
    instead of the file quietly gaining an invented pedigree.
    """
    templates = {name: ifcopenshell.util.pset.get_template(name) for name in ("IFC4", "IFC2X3")}

    for target in PROPERTY_TARGETS:
        found = False
        for schema, template in templates.items():
            pset = template.get_by_name(target.pset)
            if pset is None:
                continue
            if target.property not in {p.Name for p in (pset.HasPropertyTemplates or [])}:
                continue
            applicable = {part.split("/")[0].strip() for part in (pset.ApplicableEntity or "").split(",")}
            for ifc_class in target.classes:
                if not _exists(schema, ifc_class):
                    continue
                assert applicable & _ancestry(schema, ifc_class), (
                    f"{target.pset} does not apply to {ifc_class} in {schema}"
                )
            found = True
        assert found is target.standard, (
            f"{target.pset}.{target.property}: standard={target.standard} contradicts the IFC templates"
        )


# ── answers_as_ids: the grammar of missing.what ─────────────────────────────


def test_answers_map_by_the_shape_of_missing_what(tmp_path: Path) -> None:
    """Each of the four expressible shapes, and one that is not.

    ``missing.what`` is defined by the envelope as the absent fact in the file's
    own vocabulary — a property path, an entity, a relation. Those are precisely
    what IDS can express; German prose about geometry is not, and says so.
    """
    answers = [
        declared(3, from_=[], method="ignored"),
        _gap("Pset_WindowCommon.SillHeight", "Brüstungshöhe im CAD pflegen."),
        _gap("IfcSpace", "Räume im CAD als IfcSpace exportieren."),
        _gap("IfcBuildingStorey.Elevation", "Höhenlagen im CAD setzen."),
        _gap("IfcRelVoidsElement + IfcRelFillsElement", "Öffnungen mitexportieren."),
        _gap("IfcGeometricRepresentationContext.TrueNorth", "Nordrichtung setzen."),
        _gap("keine senkrechte Fläche an IfcWall „Nord“", "Wand mit Körpergeometrie exportieren."),
    ]
    shopping = answers_as_ids(answers)

    # The decidable answer is not a finding and appears on neither list.
    assert len(shopping.exported) + len(shopping.not_exportable) == len(answers) - 1
    assert shopping.specifications == 4
    refused = {entry.what for entry in shopping.not_exportable}
    assert refused == {
        "IfcGeometricRepresentationContext.TrueNorth",
        "keine senkrechte Fläche an IfcWall „Nord“",
    }
    # TrueNorth is refused for a checkable reason, not for a vague one: its
    # owner is not an IfcObjectDefinition and no IDS applicability can reach it.
    reason = next(e.why for e in shopping.not_exportable if e.what.endswith("TrueNorth"))
    assert "IfcObjectDefinition" in reason

    document = _written(shopping, tmp_path)
    assert len(document.specifications) == 4


def test_the_same_gap_asked_twice_is_one_specification(tmp_path: Path) -> None:
    """Five questions, one thing to author in the CAD.

    The operators append a qualifier to ``missing.what`` naming the element that
    ran into the gap. Two of those are the same demand on the architect, and a
    checker listing it twice invites the reading that they are two different
    fixes.
    """
    shopping = answers_as_ids(
        [
            _gap("IfcBuildingStorey.Elevation", "Höhenlagen setzen."),
            _gap("IfcBuildingStorey.Elevation für IfcWall „Nord“", "Höhenlagen setzen."),
        ]
    )
    assert len(shopping.exported) == 2
    assert shopping.specifications == 1
    _written(shopping, tmp_path)


# ── the file handed back ────────────────────────────────────────────────────


def test_write_returns_facts_about_the_file_and_never_the_file(house: SpatialModel, tmp_path: Path) -> None:
    """Same discipline as ``tools.draw``: the payload goes to disk, not into an
    agent's context, and what comes back is what the agent can act on — plus the
    refusals, which are the part that must never be lost in the hand-off."""
    facts = write_ids(blind_spots_as_ids(house), directory=str(tmp_path))

    assert Path(facts["path"]).exists()
    assert facts["path"].endswith(".ids")
    assert facts["specifications"] == 10
    assert facts["bytes"] > 0
    assert [entry["what"] for entry in facts["notExportable"]]
    assert "<ids" not in repr(facts), "the document itself must not travel in the reply"
    assert "OIB-Richtlinie" in facts["note"]


def test_two_runs_over_one_model_produce_one_file(house: SpatialModel, tmp_path: Path) -> None:
    """Deterministic, and addressed by content.

    The briefing is deterministic for the same reason: two answers about one
    building that differ for reasons nobody can reconstruct are worse than one
    answer that is merely incomplete.
    """
    first = write_ids(blind_spots_as_ids(house), directory=str(tmp_path))
    second = write_ids(blind_spots_as_ids(house), directory=str(tmp_path))
    assert first["path"] == second["path"]
    assert Path(first["path"]).read_text(encoding="utf-8") == Path(second["path"]).read_text(encoding="utf-8")


def test_an_empty_shopping_list_is_a_result_and_not_a_file(tmp_path: Path) -> None:
    """Nothing to demand is a good outcome, and it may not be reported as an
    error — a caller that treats it as one would show a failure for a model that
    is fine. It also may not be reported as a file: an IDS with zero
    specifications violates the XSD, so there is nothing valid to write."""
    empty = answers_as_ids([declared(1, from_=[], method="ignored")])
    facts = write_ids(empty, directory=str(tmp_path))

    assert facts["path"] is None
    assert facts["specifications"] == 0
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(IdsExportError):
        to_xml(empty)


# ── fixtures built for the test ─────────────────────────────────────────────


def _gap(what: str, remedy: str) -> Any:
    return undecidable(from_=[], method="test", missing=MissingFact(what=what, remedy=remedy))


def _exists(schema: str, ifc_class: str) -> bool:
    return bool(_ancestry(schema, ifc_class))


def _ancestry(schema: str, ifc_class: str) -> set[str]:
    """A class and its supertypes, so a pset declared for ``IfcWall`` can be
    recognised as applying to an ``IfcWallStandardCase``."""
    from ifcopenshell import ifcopenshell_wrapper

    try:
        entity = ifcopenshell_wrapper.schema_by_name(schema).declaration_by_name(ifc_class).as_entity()
    except Exception:
        return set()
    names: set[str] = set()
    while entity is not None:
        names.add(entity.name())
        entity = entity.supertype()
    return names


def _model_with_the_properties(tmp_path: Path) -> Path:
    """A minimal IFC4 file carrying exactly what the sample house's IDS demands.

    Built in memory rather than committed, and deliberately minimal: one element
    of each class the shopping list is applicable to, each with the one property
    the list asks of it. Nothing else — a fixture that happened to satisfy the
    checks for an unrelated reason would prove nothing about the specifications.
    """
    file = ifcopenshell.file(schema="IFC4")
    units = file.create_entity(
        "IfcUnitAssignment",
        Units=[file.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")],
    )
    file.create_entity("IfcProject", GlobalId=ifcopenshell.guid.new(), Name="Nachgebessert", UnitsInContext=units)

    def element(ifc_class: str, pset: str, values: dict[str, Any]) -> None:
        instance = file.create_entity(ifc_class, GlobalId=ifcopenshell.guid.new(), Name=ifc_class)
        properties = [
            file.create_entity(
                "IfcPropertySingleValue",
                Name=name,
                NominalValue=file.create_entity(
                    "IfcBoolean" if isinstance(value, bool) else "IfcLabel",
                    value,
                ),
            )
            for name, value in values.items()
        ]
        file.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=ifcopenshell.guid.new(),
            RelatedObjects=[instance],
            RelatingPropertyDefinition=file.create_entity(
                "IfcPropertySet",
                GlobalId=ifcopenshell.guid.new(),
                Name=pset,
                HasProperties=properties,
            ),
        )

    element("IfcWall", "Pset_WallCommon", {"FireRating": "EI 90", "Combustible": False, "AcousticRating": "53 dB"})
    element("IfcDoor", "Pset_DoorCommon", {"FireRating": "EI2 30-C", "AcousticRating": "32 dB"})
    element("IfcSlab", "Pset_SlabCommon", {"FireRating": "REI 90", "Combustible": False, "AcousticRating": "55 dB"})
    element("IfcCovering", "Pset_CoveringCommon", {"Combustible": False})
    element("IfcWindow", "Pset_WindowCommon", {"SillHeight": "0.9"})

    path = tmp_path / "nachgebessert.ifc"
    file.write(str(path))
    return path

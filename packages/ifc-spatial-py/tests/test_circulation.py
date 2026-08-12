"""The circulation module, measured against a topology that is knowable by hand.

The sample house is small enough to walk through on paper, which is the only
reason these numbers are worth asserting: the entrance hall carries the external
double door, the living room reaches the hall through one internal door, and the
bedroom reaches the living room through the other. Nothing connects the ``Roof``
space at all. That shape was read out of the file before a line of
:mod:`ifc_spatial.circulation` existed — ``opens_to`` on each of the three doors
— so these assertions check the graph against the file and not against
themselves.

The lengths are hand-computed from the centroids the geometry pass reports, in
plan:

===============  ==============================  ==========
leg              from → to                       metres
===============  ==============================  ==========
hall → ext door  (3.894, −0.125) → (3.894, −1.185)     1.060
living → int aG  (−3.108, 1.610) → (1.607, −0.127)     5.025
int aG → hall    (1.607, −0.127) → (3.894, −0.125)     2.287
bedroom → int ax (3.894, 2.677) → (1.633, 2.679)       2.261
int ax → living  (1.633, 2.679) → (−3.108, 1.610)      4.860
===============  ==============================  ==========

which makes the three egress routes 1.060 m, 8.372 m and 15.492 m. They are
asserted at 20 mm — twice the operator's own ``DIMENSION_TOLERANCE`` per leg,
and nowhere near loose enough to hide a wrong route.

The suite deliberately also pins the things that are *not* answers: that a
window never becomes an edge, that a room with no doors produces an undecidable
rather than "kein Weg", that a truncated contact map refuses the whole graph,
and that no verdict word ever reaches a caveat.
"""

from __future__ import annotations

import time
from pathlib import Path

import ifc_spatial.model as model_module
import pytest
from ifc_spatial import circulation as ci
from ifc_spatial import operators as op
from ifc_spatial.model import SpatialModel
from ifc_spatial.model import UnknownElementError

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
TWO_ROOMS = FIXTURES / "haus-mit-raeumen.ifc"
NO_DOORS = FIXTURES / "geschossdecke-und-fenster.ifc"
NO_SPACES = FIXTURES / "einheiten-fuss.ifc"

LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
HALL = "3w0zWKm7n8SB1qbfwUzt0G"
ROOF = "09J5N7xMHBfQZeQGAEMota"

EXTERNAL_DOOR = "3cUkl32yn9qRSPvBJVyWYp"
DOOR_HALL_LIVING = "3cUkl32yn9qRSPvBJVyWaG"
DOOR_LIVING_BEDROOM = "3cUkl32yn9qRSPvBJVyWax"

#: The bedroom's own window. If windows were edges this room would have a 1.93 m
#: way out through the glass instead of a 15.49 m route through two rooms.
BEDROOM_WINDOW = "3cUkl32yn9qRSPvBJVyWcE"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"

#: The hand-computed polyline lengths, metres. See the module docstring.
HALL_EGRESS = 1.060
LIVING_EGRESS = 8.372
BEDROOM_EGRESS = 15.492
#: 20 mm — two legs' worth of the operators' own coordinate tolerance.
LENGTH_TOLERANCE = 0.02


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    """One model for the whole suite: the graph costs ~8 s to build once."""
    return SpatialModel(str(SAMPLE_HOUSE))


# ── the graph ───────────────────────────────────────────────────────────────


def test_graph_has_every_space_plus_one_outside_node(house: SpatialModel) -> None:
    answer = ci.door_graph(house)
    assert answer.decidable
    nodes = {ref.global_id: ref for ref in answer.value.nodes}
    assert set(nodes) == {LIVING, BEDROOM, HALL, ROOF, ci.OUTSIDE}
    # The Roof space is a node even though nothing reaches it. A room that is
    # simply absent from the graph cannot be reported as having no way out.
    assert nodes[ROOF].kind == "space"
    assert nodes[ci.OUTSIDE].kind == "outside"


def test_the_three_doors_are_the_three_edges(house: SpatialModel) -> None:
    graph = ci.door_graph(house).value
    found = {edge.global_id: {edge.a, edge.b} for edge in graph.edges}
    assert found == {
        EXTERNAL_DOOR: {HALL, ci.OUTSIDE},
        DOOR_HALL_LIVING: {HALL, LIVING},
        DOOR_LIVING_BEDROOM: {LIVING, BEDROOM},
    }
    external = [edge for edge in graph.edges if edge.external]
    assert [edge.global_id for edge in external] == [EXTERNAL_DOOR]
    # The one that decided it: IsExternal on the host wall, not the room count.
    # `_faces_outside` prefers the architect's own declaration, and on this file
    # it has one — so the external door is not merely "touches a single space".
    assert "IsExternal" in external[0].via


def test_every_edge_records_the_doors_id_and_name(house: SpatialModel) -> None:
    for edge in ci.door_graph(house).value.edges:
        assert edge.global_id and edge.name
        assert edge.ifc_type == "IfcDoor"
        assert house.file.by_guid(edge.global_id).Name == edge.name


def test_a_window_is_never_an_edge(house: SpatialModel) -> None:
    """The exclusion the whole module's numbers depend on.

    ``opens_to`` answers for a window exactly as it does for a door — the
    bedroom's window touches the bedroom and nothing else, which is the same
    signature as an external door. Only the type tells them apart.
    """
    assert op.opens_to(house, BEDROOM_WINDOW).value[0].global_id == BEDROOM
    edge_ids = {edge.global_id for edge in ci.door_graph(house).value.edges}
    windows = {w.GlobalId for w in house.file.by_type("IfcWindow")}
    assert windows and not (edge_ids & windows)


def test_the_roof_space_is_reported_as_isolated_in_the_caveat(house: SpatialModel) -> None:
    caveat = ci.door_graph(house).caveat
    assert "keine Türkante" in caveat
    assert "Roof" in caveat
    # And the derivation route is named, because this export has no boundaries.
    assert len(house.file.by_type("IfcRelSpaceBoundary")) == 0
    assert "geom.tree.select" in caveat


def test_the_graph_is_built_once_and_memoised(house: SpatialModel) -> None:
    """Cost discipline, asserted on identity rather than on a stopwatch.

    The first build on this file costs ~8 s, almost all of it the OCCT contact
    map. A second call that rebuilt it would make an agent asking about four
    rooms pay four times.
    """
    first = ci.door_graph(house)
    started = time.perf_counter()
    second = ci.door_graph(house)
    elapsed = time.perf_counter() - started
    assert first.value is second.value
    assert elapsed < 0.05, f"second door_graph() took {elapsed:.3f} s — the memo is not being hit"


def test_the_graph_does_not_trigger_a_model_wide_geometry_pass(house: SpatialModel) -> None:
    """Seven centroids are shaped one at a time (0.011 s), not 75 (2.3 s)."""
    ci.door_graph(house)
    assert house.geometry_seconds == 0.0


# ── egress ──────────────────────────────────────────────────────────────────


def test_the_hall_leaves_through_its_own_external_door(house: SpatialModel) -> None:
    answer = ci.egress_path(house, HALL)
    assert answer.decidable and answer.provenance == "computed"
    assert answer.unit == "m"
    assert answer.value["doorCount"] == 1
    assert answer.value["doors"] == [EXTERNAL_DOOR]
    assert answer.value["length"] == pytest.approx(HALL_EGRESS, abs=LENGTH_TOLERANCE)


def test_the_living_room_leaves_through_the_hall(house: SpatialModel) -> None:
    answer = ci.egress_path(house, LIVING)
    assert answer.value["spaces"] == [LIVING, HALL]
    assert answer.value["doors"] == [DOOR_HALL_LIVING, EXTERNAL_DOOR]
    assert answer.value["length"] == pytest.approx(LIVING_EGRESS, abs=LENGTH_TOLERANCE)


def test_the_bedroom_leaves_through_the_living_room_and_the_hall(house: SpatialModel) -> None:
    answer = ci.egress_path(house, BEDROOM)
    assert answer.value["spaces"] == [BEDROOM, LIVING, HALL]
    assert answer.value["doors"] == [DOOR_LIVING_BEDROOM, DOOR_HALL_LIVING, EXTERNAL_DOOR]
    assert answer.value["legs"][-1]["nach"]["globalId"] == ci.OUTSIDE
    assert answer.value["length"] == pytest.approx(BEDROOM_EGRESS, abs=LENGTH_TOLERANCE)


def test_the_bedroom_is_further_out_than_the_hall(house: SpatialModel) -> None:
    """The ordering is the only thing this length is actually good for."""
    hall = ci.egress_path(house, HALL).value["length"]
    living = ci.egress_path(house, LIVING).value["length"]
    bedroom = ci.egress_path(house, BEDROOM).value["length"]
    assert hall < living < bedroom


def test_the_legs_add_up_to_the_length(house: SpatialModel) -> None:
    """A total nobody can take apart is a total nobody can disagree with."""
    for space in (HALL, LIVING, BEDROOM):
        value = ci.egress_path(house, space).value
        assert sum(leg["length"] for leg in value["legs"]) == pytest.approx(value["length"], abs=0.002)
        assert len(value["legs"]) == value["doorCount"]


def test_the_legs_chain_room_to_room(house: SpatialModel) -> None:
    value = ci.egress_path(house, BEDROOM).value
    assert value["legs"][0]["von"]["globalId"] == BEDROOM
    for previous, following in zip(value["legs"], value["legs"][1:], strict=False):
        assert previous["nach"]["globalId"] == following["von"]["globalId"]


def test_the_tolerance_is_the_geometric_one_and_grows_with_the_route(house: SpatialModel) -> None:
    hall = ci.egress_path(house, HALL)
    bedroom = ci.egress_path(house, BEDROOM)
    assert hall.tolerance == pytest.approx(op.DIMENSION_TOLERANCE)
    assert bedroom.tolerance == pytest.approx(3 * op.DIMENSION_TOLERANCE)


def test_the_caveat_says_plainly_that_the_number_is_too_short(house: SpatialModel) -> None:
    """The one caveat this module cannot ship without.

    Under-estimating an escape route is the direction that hides a problem, so
    the German has to say so in words an architect reads rather than in a
    hedge.
    """
    caveat = ci.egress_path(house, BEDROOM).caveat
    assert "UNTERGRENZE" in caveat
    assert "KÜRZER" in caveat
    assert "gefährliche Richtung" in caveat
    assert "darf nicht als Fluchtweglänge im Sinne der OIB-Richtlinie 2 verwendet werden" in caveat
    # And what the polyline is, so the reader can judge it themselves.
    assert "POLYGONZUG" in caveat
    assert "Raumschwerpunkte" in caveat
    # The route stops at the door leaf, not at a safe place outdoors.
    assert "endet an der Außentür" in caveat
    # Stairs are not edges, so a multi-storey route is not representable.
    assert "Treppen" in caveat


def test_a_room_with_no_door_is_undecidable_and_not_an_empty_answer(house: SpatialModel) -> None:
    """The Roof space. „Es gibt keinen Weg hinaus" would be a claim about a
    building; what is true is a claim about this export."""
    answer = ci.egress_path(house, ROOF)
    assert not answer.decidable
    assert answer.value is None
    assert "Türverbindung" in answer.missing.what
    assert "IfcDoor" in answer.missing.remedy
    # The remedy has to be something an architect can do in their CAD.
    assert "CAD" in answer.missing.remedy
    assert "Treppe" in answer.missing.remedy


# ── reachability ────────────────────────────────────────────────────────────


def test_reachable_from_the_bedroom_counts_hops_and_metres(house: SpatialModel) -> None:
    value = ci.reachable_from(house, BEDROOM).value
    found = {entry["globalId"]: entry for entry in value["reachable"]}
    assert set(found) == {LIVING, HALL}
    assert found[LIVING]["hops"] == 1
    assert found[HALL]["hops"] == 2
    assert found[HALL]["length"] > found[LIVING]["length"]
    assert value["outside"] == {"reachable": True, "doorCount": 3, "length": pytest.approx(BEDROOM_EGRESS, abs=0.02)}


def test_reachable_from_lists_the_rooms_it_cannot_reach(house: SpatialModel) -> None:
    value = ci.reachable_from(house, HALL).value
    assert [entry["globalId"] for entry in value["nichtErreichbar"]] == [ROOF]
    assert ci.OUTSIDE not in {entry["globalId"] for entry in value["nichtErreichbar"]}


def test_reachable_from_a_room_with_no_egress_says_so_without_a_verdict(house: SpatialModel) -> None:
    answer = ci.reachable_from(house, ROOF)
    assert answer.decidable
    assert answer.value["reachable"] == []
    assert answer.value["outside"] == {"reachable": False}
    assert "Aussage über den Türgraph dieses Exports, nicht über das Gebäude" in answer.caveat
    assert {entry["globalId"] for entry in answer.value["nichtErreichbar"]} == {LIVING, BEDROOM, HALL}


# ── the ways this can and must refuse ───────────────────────────────────────


def test_a_model_without_spaces_refuses_with_a_remedy() -> None:
    model = SpatialModel(str(NO_SPACES))
    answer = ci.door_graph(model)
    assert not answer.decidable
    assert answer.missing.what == "IfcSpace"
    assert "IfcSpace exportieren" in answer.missing.remedy


def test_a_model_without_doors_refuses_with_a_remedy() -> None:
    model = SpatialModel(str(NO_DOORS))
    assert len(model.file.by_type("IfcSpace")) == 3
    answer = ci.door_graph(model)
    assert not answer.decidable
    assert answer.missing.what == "IfcDoor"
    assert "IfcDoor" in answer.missing.remedy
    # And the same refusal reaches the operator an agent actually calls.
    egress = ci.egress_path(model, "4Decke00000Space00001")
    assert not egress.decidable
    assert egress.method == "egressPath(4Decke00000Space00001)"
    assert egress.missing.what == "IfcDoor"


def test_a_door_whose_rooms_cannot_be_resolved_is_reported_not_dropped() -> None:
    """``haus-mit-raeumen.ifc`` carries a door with no body at all.

    ``opens_to`` is undecidable for it, and the graph must not quietly become a
    building with no doors: the door is listed under ``unbestimmt`` with the
    German reason, and the caveat says how many routes are therefore unknown.
    """
    model = SpatialModel(str(TWO_ROOMS))
    answer = ci.door_graph(model)
    assert answer.decidable
    assert answer.value.edges == ()
    assert [entry["globalId"] for entry in answer.value.unresolved] == ["2Haus0Raeume00Door0001"]
    assert "keine geometrische Repräsentation" in answer.value.unresolved[0]["warum"]
    assert "unbestimmt" in answer.caveat
    # The consequence, stated rather than hidden: no route out of either room.
    egress = ci.egress_path(model, "2Haus0Raeume00Space001")
    assert not egress.decidable


def test_an_oversized_model_is_refused_before_any_offset_starts() -> None:
    """The admission test from :data:`DERIVED_BOUNDARY_MAX_PRODUCTS`, borrowed.

    An OCCT offset cannot be interrupted — one has been measured at over 200 s
    — so the refusal has to happen before the loop, and the proof of that is
    that neither the tree nor the contact map was ever built.
    """
    model = SpatialModel(str(SAMPLE_HOUSE))
    model.__dict__["derivable_boundaries"] = False
    answer = ci.door_graph(model)
    assert not answer.decidable
    assert answer.missing.what == "IfcRelSpaceBoundary"
    assert str(model_module.DERIVED_BOUNDARY_MAX_PRODUCTS) in answer.missing.remedy
    assert model.contact_seconds == 0.0
    assert model.tree_seconds == 0.0


def test_a_truncated_contact_map_refuses_the_whole_graph(monkeypatch: pytest.MonkeyPatch) -> None:
    """A short graph is not a smaller building.

    With the budget at zero the contact map comes back empty and every door is
    unresolvable. The trap is that "no edge was derived" then looks exactly like
    "nothing needed deriving", and a graph with zero edges and a mild caveat
    would go out. It must be a refusal that names how far the derivation got.
    """
    monkeypatch.setattr(model_module, "CONTACT_BUDGET_SECONDS", 0.0)
    model = SpatialModel(str(SAMPLE_HOUSE))
    answer = ci.door_graph(model)
    assert not answer.decidable
    assert "zu teuer" in answer.missing.what
    assert "0 von 4 Räumen" in answer.missing.remedy
    assert "fehlende Kante ist ein fehlender Weg" in answer.missing.remedy
    assert model.contacts_complete is False


def test_a_hallucinated_global_id_raises_rather_than_answering(house: SpatialModel) -> None:
    with pytest.raises(UnknownElementError):
        ci.egress_path(house, "0000000000000000000000")
    with pytest.raises(UnknownElementError):
        ci.reachable_from(house, "0000000000000000000000")


def test_asking_a_wall_for_its_escape_route_names_the_operator_that_would_answer(house: SpatialModel) -> None:
    answer = ci.egress_path(house, NORTH_WALL)
    assert not answer.decidable
    assert "erwartet einen Raum (IfcSpace)" in answer.missing.what
    assert "opensTo()" in answer.missing.remedy


# ── the line this layer may not cross ───────────────────────────────────────


def test_no_answer_this_module_produces_states_a_verdict_or_a_threshold(house: SpatialModel) -> None:
    """OIB Richtlinie 2 names a maximum length. This layer must not know it.

    Scanned on the German that actually reaches a reader — every caveat, every
    ``missing.what`` and ``remedy``, every per-door reason — rather than on the
    source, because the source is allowed to discuss verdicts and the answers
    are not. A caveat that says „erfüllt" turns a measurement into a ruling that
    nobody downstream can take apart again.
    """
    texts: list[str] = []

    def collect(answer: object) -> None:
        texts.append(getattr(answer, "caveat", None) or "")
        missing = getattr(answer, "missing", None)
        if missing is not None:
            texts.extend([missing.what, missing.remedy])
        value = getattr(answer, "value", None)
        if isinstance(value, ci.DoorGraph):
            for entry in (*value.unresolved, *value.excluded):
                texts.extend(str(v) for v in entry.values() if v)

    collect(ci.door_graph(house))
    for space in (HALL, LIVING, BEDROOM, ROOF):
        collect(ci.egress_path(house, space))
        collect(ci.reachable_from(house, space))
    for path in (TWO_ROOMS, NO_DOORS, NO_SPACES):
        collect(ci.door_graph(SpatialModel(str(path))))

    blob = " ".join(texts)
    assert len(blob) > 2000  # the collector actually collected something
    for verdict in ("erfüllt", "eingehalten", "compliant", "unzulässig", "zulässig", "verstößt", "Grenzwert"):
        assert verdict not in blob, f"verdict word {verdict!r} reached a reader"
    # Naming the Richtlinie is welcome — it tells the reader which rule this
    # number is NOT good enough for. Naming its metre limit is not.
    assert "OIB-Richtlinie 2" in blob
    for threshold in ("40 m", "40m", "Höchstlänge", "höchstens 40"):
        assert threshold not in blob, f"threshold {threshold!r} reached a reader"


def test_every_answer_carries_its_provenance_method_and_sources(house: SpatialModel) -> None:
    for answer, method in (
        (ci.door_graph(house), "doorGraph()"),
        (ci.egress_path(house, BEDROOM), f"egressPath({BEDROOM})"),
        (ci.reachable_from(house, BEDROOM), f"reachableFrom({BEDROOM})"),
    ):
        assert answer.method == method
        assert answer.provenance == "computed"  # this export has no space boundaries
        assert answer.caveat
        # Every id in `from_` must name something in this model, or the audit
        # trail points at nothing.
        assert BEDROOM in answer.from_
        for global_id in answer.from_:
            assert house.file.by_guid(global_id) is not None

"""The skill may only teach calls that can actually be made.

This suite exists because of a real defect. `ifc-spatial-reasoning` shipped a
section on drawing that read

    `view: "section"` zeigt Profile und Überstände, `plan` die Anordnung,
    `elevation` eine Fassade

and `ifc_measure` has never had a `view` parameter — `draw` produces a floor
plan and nothing else. It also ended its worked chain with „dann erst der
Überstand und das Prisma", at a time when neither `overhang` nor
`light_incidence` was on the tool surface at all.

A skill is instructions the model believes. A wrong one is worse than a missing
one: the model spends a turn calling something that does not exist, reads back
an error it cannot fix, and either gives up or invents the number — which is
precisely the failure („Überstand/Raum-% im IFC nicht messbar") the whole
package was built to remove.

So every identifier the prose names is pinned against the enums in
`measure_register`. When an operator is renamed or dropped, this goes red here
rather than in front of an architect.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.agents.bim.measure_register import DISTANCE_MODES
from aiq_agent.agents.bim.measure_register import KINDS
from aiq_agent.agents.bim.measure_register import MEASURES
from aiq_agent.agents.bim.measure_register import RELATIONS
from aiq_agent.agents.bim.measure_register import ROOM_KINDS
from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS

SKILL = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "aiq_agent"
    / "skills"
    / "builtin"
    / "bim"
    / "ifc-spatial-reasoning"
    / "SKILL.md"
)

#: Everything `_ifc_measure` accepts. Anything the skill tells the model to pass
#: has to be in here, or the model is being taught a parameter that is dropped.
PARAMETERS = {
    "operation",
    "global_id",
    "other_global_id",
    "relation",
    "measure",
    "mode",
    "ifc_type",
    "name_contains",
    "storey",
    "kind",
    "room_kind",
    "model_name",
    "limit",
    "angle_deg",
    "swivel_deg",
}


@pytest.fixture(scope="module")
def text() -> str:
    return SKILL.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def backticked(text: str) -> set[str]:
    """Every `identifier` in the prose, as one flat set.

    Backticks are the skill's own convention for "this is a literal you type",
    which makes them the exact set that must resolve. Prose in backticks (a
    sentence, a phrase with spaces) is not an identifier and is filtered out.
    """
    return {
        token
        for token in re.findall(r"`([^`\n]+)`", text)
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token)
    }


def test_every_operation_the_skill_names_exists(backticked: set[str]) -> None:
    named = backticked & (VALID_OPERATIONS | {"ifc_measure"})
    # A skill that names no operations is not teaching this tool at all.
    assert len(named) >= 6, named


def test_no_backticked_identifier_is_an_invention(backticked: set[str], text: str) -> None:
    """The assertion that would have caught the `view` defect.

    Every bare identifier has to be an operation, a parameter, or a value of one
    of the enums. `view` was none of those.
    """
    known = (
        VALID_OPERATIONS
        | PARAMETERS
        | set(RELATIONS)
        | set(MEASURES)
        | set(DISTANCE_MODES)
        | set(KINDS)
        | set(ROOM_KINDS)
        | {
            # The answer envelope's own field names, which the skill teaches the
            # model to read and report.
            "ifc_measure",
            "provenance",
            "declared",
            "computed",
            "inferred",
            "decidable",
            "caveat",
            "because",
            "tolerance",
            "missing",
            "unit",
            "value",
            "method",
            "from",
            "FEHLT",
        }
    )
    unknown = sorted(token for token in backticked if token not in known)
    assert not unknown, (
        f"{SKILL.name} names {unknown}, which `ifc_measure` does not accept. "
        "Either add it to the tool or stop teaching it."
    )


#: `parameter: "value"` as the skill writes a call.
#:
#: Lowercase left side and ASCII quotes on the right, which is what separates a
#: call from German prose: every parameter `ifc_measure` takes is snake_case,
#: every German noun is capitalised, and the skill quotes prose with „…" rather
#: than "…". So `Ergebnis: „keine Treffer"` is a sentence and `view: "section"`
#: is a call — which is the distinction that has to hold, not a general one.
CALL = re.compile(r'\b([a-z][a-z0-9_]*):\s*"([^"\n]+)"')


def written_calls(text: str) -> list[tuple[str, str]]:
    return CALL.findall(text)


def test_dotted_and_valued_forms_resolve_too(text: str) -> None:
    """`operation: "draw"`, `relation: "opensTo"`, `measure: "floorArea"`.

    The quoted form is how the skill actually shows a call, so BOTH halves are
    checked: the name against the tool's signature, and — where the parameter is
    an enum — the value against that enum.

    Checking the name is the half that matters. The defect this suite was
    written for was `view: "section"`, and `view` is not a bare identifier; it
    only ever appeared as the left side of a call. A test that validated values
    and shrugged at unknown names would have passed on it.
    """
    enums = {
        "operation": VALID_OPERATIONS,
        "relation": set(RELATIONS),
        "measure": set(MEASURES),
        "mode": set(DISTANCE_MODES),
        "kind": set(KINDS),
        "room_kind": set(ROOM_KINDS),
    }
    calls = written_calls(text)
    assert len(calls) >= 3, "the skill stopped showing concrete calls"
    for parameter, value in calls:
        assert parameter in PARAMETERS, (
            f'{SKILL.name} shows `{parameter}: "{value}"`, and `ifc_measure` has no '
            f"`{parameter}` parameter — the call would be made with it silently dropped."
        )
        allowed = enums.get(parameter)
        if allowed is not None:
            assert value in allowed, f'{parameter}: "{value}" is not one of {sorted(allowed)}'


def test_the_check_actually_catches_the_defect_it_was_written_for() -> None:
    """The guard on the guard.

    Asserting that a green suite would have caught a bug it never ran against is
    a claim, not a test. So the removed sentence is fed back through the same
    two checks, and both have to reject it — otherwise this file is decoration.
    """
    removed = '`view: "section"` zeigt Profile und Überstände, `plan` die Anordnung.'

    parameters = [name for name, _ in written_calls(removed)]
    assert parameters == ["view"]
    assert "view" not in PARAMETERS

    # And it is not rescued by being a known enum value somewhere else.
    everything = (
        VALID_OPERATIONS | PARAMETERS | set(RELATIONS) | set(MEASURES) | set(DISTANCE_MODES)
    )
    assert "view" not in everything and "section" not in everything


def test_the_skill_does_not_promise_a_section_or_an_elevation(text: str) -> None:
    """The specific regression.

    `draw` calls `ifcopenshell.draw` with `auto_floorplan`. `auto_section` and
    `auto_elevation` exist in that API and are not exposed here on purpose:
    both need hidden-line removal, which ran past ten minutes on a
    four-room sample house — long enough that an agent tool offering it would
    hang a conversation rather than answer one.

    Until that changes the skill has to say a plan is all there is, and has to
    point at `overhang` for the thing an architect would have wanted a section
    for.
    """
    assert "Grundriss" in text
    assert "Schnitt und Ansicht gibt es **nicht**" in text
    assert "overhang" in text


def test_the_light_incidence_angles_are_taught_as_law_not_as_geometry(text: str) -> None:
    """The boundary the whole design rests on.

    `light_incidence` refuses without `angle_deg` instead of defaulting to 45,
    because 45° is a fact about OIB 3 and not about the building. If the skill
    ever teaches the model that the tool knows the angle, the refusal becomes an
    unexplained error instead of a designed one.
    """
    assert "angle_deg" in text and "swivel_deg" in text
    assert "Bestimmung" in text
    assert "45 und 30" in text
    # And the verdict stays with the rulebook: a cut prism enlarges the required
    # light-entry area, it does not ban the window.
    assert "vergrößert die\nerforderliche Lichteintrittsfläche" in text.replace("**", "")


def test_the_three_provenances_are_all_present_and_distinct(text: str) -> None:
    for word in ("deklariert", "Gemessen", "Vermutlich"):
        assert word in text, word

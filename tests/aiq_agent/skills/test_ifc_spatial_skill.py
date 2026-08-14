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

The skill now also routes between the two halves of the BIM surface — the
question „which of `ifc_query` and `ifc_measure` answers this" is the first
decision it teaches — so `register`'s operation vocabulary is pinned here too,
and the routing table's rows are checked to attribute each operation to the tool
that actually has it. A table that offers `light_incidence` under `ifc_query` is
the same class of defect as `view: "section"`: a call that cannot be made.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_agent.agents.bim.measure_register import DISTANCE_MODES
from aiq_agent.agents.bim.measure_register import ENVELOPE_ASPECTS
from aiq_agent.agents.bim.measure_register import FIRE_ASPECTS
from aiq_agent.agents.bim.measure_register import KINDS
from aiq_agent.agents.bim.measure_register import MEASURES
from aiq_agent.agents.bim.measure_register import PROFILE_KINDS
from aiq_agent.agents.bim.measure_register import RELATIONS
from aiq_agent.agents.bim.measure_register import ROOM_KINDS
from aiq_agent.agents.bim.measure_register import VALID_OPERATIONS
from aiq_agent.agents.bim.measure_register import VIEW_MODES
from aiq_agent.agents.bim.register import VALID_OPERATIONS as QUERY_OPERATIONS

#: The two tool names the skill is allowed to name, and the operations each one
#: really has. `ifc_measure` is this skill's subject; `ifc_query` is the sibling
#: it routes to, and routing a caller to an operation the sibling does not have
#: wastes the same turn as inventing one here.
TOOL_OPERATIONS: dict[str, set[str]] = {
    "ifc_measure": set(VALID_OPERATIONS),
    "ifc_query": set(QUERY_OPERATIONS),
}
EVERY_OPERATION = TOOL_OPERATIONS["ifc_measure"] | TOOL_OPERATIONS["ifc_query"]

#: Every spelling `kind` accepts, assembled ONCE.
#:
#: `kind` is one field over four vocabularies and this union had already drifted
#: twice — first missing `ENVELOPE_ASPECTS`, so the skill's real
#: `kind: "thermalEnvelope"` failed here as an invention, then missing
#: `PROFILE_KINDS`, so `kind: "expensive"` did the same when `element_profile`
#: arrived. Both times the drift read as a bug in the SKILL, which is the
#: expensive direction: the obvious fix is to delete the line the skill was right
#: to write. It was assembled by hand in two places; now it is assembled here,
#: and `test_the_kind_union_still_covers_the_schema` fails if a fifth vocabulary
#: is added to the tool without reaching this constant.
EVERY_KIND = set(KINDS) | set(FIRE_ASPECTS) | set(ENVELOPE_ASPECTS) | set(PROFILE_KINDS)

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
    "when",
}


def test_the_parameter_list_is_the_tool_s_own_signature() -> None:
    """This set was hand-written, and a hand-written mirror drifts.

    It is the reference every „is this an invention" assertion below resolves
    against, so a parameter added to the tool and forgotten here makes the skill
    UNABLE to teach it: the first `when: "…"` written into the prose would fail
    as an invention when it is a real field of a real call. `model_name` is the
    one addition — `_ifc_measure` resolves the model before `_build_call` ever
    sees the arguments, so it is not in that signature.
    """
    import inspect

    from aiq_agent.agents.bim.measure_register import _build_call

    assert PARAMETERS == set(inspect.signature(_build_call).parameters) | {"model_name"}


def test_the_kind_union_still_covers_the_schema() -> None:
    """`EVERY_KIND` is the same set the model is handed on the `kind` field.

    The sibling of the assertion above, for the one field that carries four
    vocabularies. `_ALL_KINDS` is what builds the `Literal` in `IfcMeasureInput`,
    so it IS the set of spellings the tool accepts; if a fifth vocabulary is
    added there and not here, this fails by name instead of surfacing three
    tests later as „the skill invented `kind: <the new value>`" — a message that
    points at the skill for being right.
    """
    from aiq_agent.agents.bim.measure_register import _ALL_KINDS

    assert EVERY_KIND == set(_ALL_KINDS)


def _card_field_names() -> set[str]:
    """Field and literal names of the Grid cards this skill is allowed to emit.

    The skill teaches the hand-off from a measurement to a card — every answer
    ends with a `Bezug:` line naming exactly the elements the number came from,
    and those are the ids to highlight in the viewer. That teaching names card
    fields, which are not `ifc_measure` parameters and would otherwise read as
    inventions.

    Read from the card MODELS rather than written out, so a renamed card field
    fails here the same way a renamed operator does.
    """
    from aiq_agent.cards import models as card_models

    names: set[str] = set()
    for card in ("IfcViewerCard", "IfcHighlight", "IfcElementCard", "IfcScheduleCard"):
        model = getattr(card_models, card, None)
        if model is None:
            continue
        names |= set(getattr(model, "model_fields", {}))
        literal = getattr(model, "model_fields", {}).get("type")
        for value in getattr(getattr(literal, "annotation", None), "__args__", ()):
            if isinstance(value, str):
                names.add(value)
    # The verdict vocabulary, which the skill constrains rather than merely names.
    return names | {"pass", "fail", "warning", "info"}


_CARD_FIELDS = _card_field_names()


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
    return {token for token in re.findall(r"`([^`\n]+)`", text) if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token)}


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
        EVERY_OPERATION
        | PARAMETERS
        | set(RELATIONS)
        | set(MEASURES)
        | set(DISTANCE_MODES)
        | EVERY_KIND
        | set(ROOM_KINDS)
        | set(TOOL_OPERATIONS)
        | {
            # The answer envelope's own field names, which the skill teaches the
            # model to read and report.
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
            # Keys of the dict `measure/extent` returns (`operators.extent`),
            # which the skill warns are the axis-aligned box and not the
            # element's own length and thickness.
            "width",
            "depth",
            "height",
            "centroid",
            # Keys of what `envelope/compactness` returns. `volume` is here
            # because the skill has to name it to say WHICH volume it is: the
            # net one, summed from the room solids. A gross volume is larger by
            # the whole construction build-up, and an OIB 6 calculation names
            # which of the two it wants.
            "volume",
            "envelopeArea",
            # A key of what `clearance` returns, and the skill has to name it:
            # it is the number `distance('min')` would have given, carried
            # BESIDE the clear one so the size of the difference is a fact in
            # the same answer rather than a second call away.
            "boxGap",
        }
        | _CARD_FIELDS
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
        # The union, because the skill writes calls for BOTH tools; which of the
        # two an `operation` belongs to is checked line by line in
        # `test_the_routing_table_puts_each_operation_under_its_own_tool`.
        "operation": EVERY_OPERATION,
        "relation": set(RELATIONS),
        "measure": set(MEASURES),
        # `mode` is operation-scoped: distance senses on `distance`, plan
        # framing on `view`. The union is the honest check here — a per-line
        # operation lookup is what `test_the_routing_table_puts_each_operation
        # _under_its_own_tool` already does.
        "mode": set(DISTANCE_MODES) | set(VIEW_MODES),
        # `kind` carries FOUR vocabularies, for the same reason `mode` carries
        # two: the spatial role on `find_elements`/`survey`, the OIB 2 aspect on
        # `fire`, the OIB 6 aspect on `envelope`, and the expensive-measure
        # opt-in on `element_profile`. See `EVERY_KIND` for why the union is
        # assembled once rather than retyped here.
        "kind": EVERY_KIND,
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


def test_the_routing_table_puts_each_operation_under_its_own_tool(text: str) -> None:
    """„Which of the two tools" is the first thing the skill teaches.

    Getting it wrong is the same defect as `view: "section"` wearing different
    clothes: `ifc_query` with `operation: "light_incidence"` is a call that
    cannot be made, and the model would burn the turn discovering it.

    Only lines that name exactly ONE of the two tools are checked — a line
    naming both is contrasting them, and a line naming neither is prose about an
    operation whose tool was established earlier.
    """
    checked = 0
    for line in text.splitlines():
        named = [tool for tool in TOOL_OPERATIONS if tool in line]
        if len(named) != 1:
            continue
        tool = named[0]
        bare = {token for token in re.findall(r"`([^`\n]+)`", line) if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token)}
        written = {value for parameter, value in written_calls(line) if parameter == "operation"}
        for candidate in (bare | written) & EVERY_OPERATION:
            checked += 1
            assert candidate in TOOL_OPERATIONS[tool], (
                f"{SKILL.name} offers `{candidate}` on the same line as `{tool}`, which has no such "
                f"operation. It belongs to {sorted(t for t, ops in TOOL_OPERATIONS.items() if candidate in ops)}."
            )
    # A routing section that stopped naming operations next to their tool is not
    # routing anything, and this test would pass vacuously.
    assert checked >= 8, f"only {checked} operations were attributed to a tool"


def test_the_description_survives_the_level_one_catalog_intact(text: str) -> None:
    """The description IS the trigger, and it is rendered as ONE bullet line.

    `SkillRuntime.prompt_block` writes `- \\`{name}\\`: {description}` per skill,
    so a description carrying a newline (a blank line inside the folded YAML
    scalar) breaks out of its own bullet and the rest of it reads as loose
    system-prompt text. `parse_skill_md` caps the length at 1024; there is no
    further budget trimming in this substrate, so the whole thing is paid for on
    every turn of every agent that resolves the skill — which is the reason to
    check that it is spent on triggering and not on prose.
    """
    from aiq_agent.skills.models import MAX_DESCRIPTION_CHARS
    from aiq_agent.skills.models import parse_skill_md
    from aiq_agent.skills.runtime import SkillRuntime

    skill = parse_skill_md(text, expected_dir_name="ifc-spatial-reasoning")
    assert "\n" not in skill.description
    assert len(skill.description) <= MAX_DESCRIPTION_CHARS

    block = SkillRuntime((skill,)).prompt_block() or ""
    assert f"- `{skill.name}`: {skill.description}" in block.splitlines()

    # Both tool names belong in the trigger text: the moment the model is about
    # to reach for one of them is the moment it has to load this.
    for tool in TOOL_OPERATIONS:
        assert tool in skill.description, tool


def test_the_check_actually_catches_the_defect_it_was_written_for() -> None:
    """The guard on the guard.

    Asserting that a green suite would have caught a bug it never ran against is
    a claim, not a test. So the removed sentence is fed back through the same
    two checks, and both have to reject it — otherwise this file is decoration.
    """
    removed = '`view: "section"` zeigt Profile und Überstände, `plan` die Anordnung.'

    parameters = [name for name, _ in written_calls(removed)]
    assert parameters == ["view"]
    # `view` is now a real OPERATION — it renders a plan the model can see — so
    # the original "this word appears nowhere" assertion no longer holds, and
    # keeping it would have been wrong rather than strict. The defect was never
    # the word: it was `view` used as a PARAMETER of `draw`, and a parameter
    # `ifc_measure` does not take is silently dropped from the call. That is
    # still precisely what this rejects.
    assert "view" not in PARAMETERS
    assert "view" in VALID_OPERATIONS, "the operation exists — only the parameter never did"

    # And the VALUE is not rescued by being a known enum entry somewhere else.
    everything = VALID_OPERATIONS | PARAMETERS | set(RELATIONS) | set(MEASURES) | set(DISTANCE_MODES)
    assert "section" not in everything


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
    # Whitespace-collapsed: pinning the line break rather than the claim is
    # the brittleness that already broke this suite once when a paragraph
    # rewrapped.
    flat = " ".join(text.split())
    assert "Schnitt und Ansicht gibt es **nicht**" in flat
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
    # light-entry area, it does not ban the window. Asserted on the words with
    # whitespace collapsed, not on the file's line breaks: a claim that survives
    # only until someone reflows a paragraph is pinning the wrapping, not the
    # claim.
    flowed = " ".join(text.replace("**", "").split())
    assert "vergrößert die erforderliche Lichteintrittsfläche" in flowed
    assert "es verbietet das Fenster nicht" in flowed


def test_the_three_provenances_are_all_present_and_distinct(text: str) -> None:
    for word in ("deklariert", "Gemessen", "Vermutlich"):
        assert word in text, word


def test_the_clear_width_hedge_survives(text: str) -> None:
    """`clearWidth` is a Rohbaulichte, and the skill must keep saying so.

    This is the escape-door step of an OIB 2 check, and the error is in the
    unsafe direction: the finished lichte Durchgangsbreite is measured between
    the fitted Zargenfalze and is smaller than the aperture the operator
    measures, so a door reported at its Rohbaulichte reads as wide enough when
    the built one is not.

    Pinned here because nothing else pins it. The rest of this suite compares
    IDENTIFIERS against `measure_register`'s enums, so the entire hedge could be
    deleted — the caveat, the percentage and the instruction not to call the
    number a Durchgangsbreite — and every test in the repo would stay green
    while the skill quietly started teaching a compliant-looking answer.

    Asserted on words with whitespace collapsed, not on line breaks, so a
    reflowed paragraph does not read as a removed warning.
    """
    flowed = " ".join(text.replace("**", "").split())
    # The operator's own result, named for what it is.
    assert "Rohbaulichte" in flowed
    # The size of the gap, and its direction. Both matter: a warning that the
    # number is "approximate" would not stop anyone reporting it as compliant.
    assert "15–25 % kleiner" in flowed
    assert "zu schmale" in flowed
    # And the instruction that keeps the wrong noun off the answer.
    assert "nie „lichte Durchgangsbreite" in flowed

"""Parity guard: the SEEDED platform skills must parse the way the runtime reads them.

A seeded standard skill (``frontends/ui/drizzle/00XX_*_standard_skill.sql``) is
a row of SQL text on one side of the stack and a :class:`Skill` on the other,
and nothing in between type-checks it. Its ``metadata`` is a jsonb blob whose
reserved keys only this package understands: ``grid-cards`` names card types
from :mod:`aiq_agent.cards`, ``grid-agents`` names agents from the resolver,
``grid-hidden`` is a boolean-ish token.

Every one of those couplings fails SILENTLY in production. A renamed card type
leaves the seed naming a card that no longer exists, and the BFF-served path is
deliberately LENIENT — it logs and drops the bad entry so one stale name cannot
delete a tenant's whole skill (see ``_validate_grid_cards``). Which is right at
runtime and useless as a warning: the skill keeps working, minus the shapes it
was seeded to inline, and nobody hears about it. Same for a mistyped
``grid-hidden``, which drops to "visible" and puts a house skill back on the
live line.

So the seeds are re-validated here in STRICT mode, the way an in-repo SKILL.md
is, and the parsed metadata is compared against what the runtime would actually
read back. This is a filesystem test with no database, for the same reason
``frontends/ui/tests/db/migrations-journal.test.ts`` is: the failure it catches
is a bookkeeping mismatch, visible long before anything connects.
"""

from __future__ import annotations

import hashlib
import json
import re

import pytest

from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.skills.models import MAX_DESCRIPTION_CHARS
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import _validate_metadata
from aiq_agent.skills.models import preferred_cards
from aiq_agent.skills.models import skill_hidden
from aiq_agent.skills.models import split_metadata_list
from aiq_agent.skills.resolver import KNOWN_AGENTS
from tests.aiq_agent.skills.seeded_skill_rows import DRIZZLE_DIR
from tests.aiq_agent.skills.seeded_skill_rows import REPO_ROOT
from tests.aiq_agent.skills.seeded_skill_rows import SEEDS
from tests.aiq_agent.skills.seeded_skill_rows import effective_row as _effective_row

SEED_IDS = [tag for tag, _ in SEEDS]


def test_the_seeds_are_found_at_all():
    """A parser that silently matches nothing would make every test below vacuous."""
    assert {row["name"] for _, row in SEEDS} >= {"piloti-voice", "piloti-cards"}


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_metadata_passes_strict_validation(tag: str, row: dict[str, str]):
    """The lenient BFF path would drop a bad key and say nothing; this says it.

    ``strict=True`` is what an in-repo SKILL.md gets. A seed is authored in this
    repo and reviewed here too, so it earns the same treatment — an unknown card
    type or a ``grid-hidden: maybe`` is an authoring error, not tenant data.
    """
    metadata = json.loads(row["metadata"])
    assert _validate_metadata(metadata, strict=True) == metadata


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_row_loads_as_a_skill(tag: str, row: dict[str, str]):
    """Name, description and body must satisfy the same model the runtime builds."""
    skill = Skill(
        name=row["name"],
        description=row["description"],
        body=row["body"],
        metadata=json.loads(row["metadata"]),
        origin="platform",
        standard=row["delivery"] == "standard",
    )
    assert skill.body.strip(), f"{tag} seeds an empty body"
    assert 0 < len(skill.description) <= MAX_DESCRIPTION_CHARS


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_grid_cards_survive_the_read_path(tag: str, row: dict[str, str]):
    """Every named card type still exists, so nothing is dropped on read.

    ``preferred_cards`` filters against the live catalog, so a card renamed in
    ``src/aiq_agent/cards`` would quietly shorten this list — and the skill would
    go on running, minus the shapes it was seeded to inline. Comparing against
    the raw metadata is what turns that into a failing test.
    """
    metadata = json.loads(row["metadata"])
    declared = split_metadata_list(metadata.get("grid-cards", ""))
    assert preferred_cards(metadata) == tuple(declared)
    assert set(declared) <= model_facing_card_types()


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_grid_agents_are_agents_the_resolver_knows(tag: str, row: dict[str, str]):
    """An unknown agent name is logged and ignored at resolve time — never here."""
    metadata = json.loads(row["metadata"])
    assert set(split_metadata_list(metadata.get("grid-agents", ""))) <= KNOWN_AGENTS


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_a_standard_seed_is_published_and_hidden(tag: str, row: dict[str, str]):
    """``delivery: 'standard'`` is only fleet policy once ``published`` is true.

    And a standard skill applies to EVERY answer, which is precisely the case
    ``grid-hidden`` exists for: without it the live line announces the same
    activation under every turn. Both are properties of the tier rather than of
    these two rows, so they are asserted for whatever standard seed comes next.
    """
    if row["delivery"] != "standard":
        pytest.skip(f"{tag} is not a standard-delivery seed")
    assert row["published"].lower() == "true"
    assert skill_hidden(json.loads(row["metadata"]))


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_every_seed_has_a_matching_down_migration(tag: str, row: dict[str, str]):
    """The rollback must name the same skill, and only touch the system seed.

    ``created_by = 'system'`` is the guard that keeps a down-migration from
    discarding a row the platform owner has since edited — the same reason the
    forward seed is ``ON CONFLICT DO NOTHING``.
    """
    down = DRIZZLE_DIR / f"{tag}.down.sql"
    assert down.exists(), f"{tag} seeds a row with no .down.sql to remove it"
    text = down.read_text(encoding="utf-8")
    assert f"'{row['name']}'" in text
    assert "'system'" in text


def test_the_generic_card_seed_inlines_only_generic_cards():
    """``piloti-cards`` pays for its shapes on EVERY turn, so the list stays short.

    The five are the ones that fire on an ordinary answer. ``norm_chain`` and
    ``typed_table`` are taught in the body but deliberately NOT inlined — they
    are the two most expensive and the two narrowest, so they are left to a
    ``describe_card`` round-trip on the turns they actually fire. Pinned here
    because widening the list is invisible in review and permanent in cost.
    """
    row = next(row for _, row in SEEDS if row["name"] == "piloti-cards")
    assert preferred_cards(json.loads(row["metadata"])) == (
        "verdict_header",
        "condition_tree",
        "key_takeaways",
        "callout",
        "follow_ups",
    )


def test_the_generic_card_seed_carries_the_craft_the_tool_no_longer_states():
    """The craft moved OUT of ``_CARD_DOCTRINE`` and has to have landed here.

    ``emit_card``'s description is paid on every turn whether or not a card is
    emitted, so it holds the tool's contract — which trigger takes which card,
    when to emit none, where a card lands — and the judgement moved into this
    skill, which is applied on every answering turn anyway and can be edited
    without a deploy.

    The move is only safe if both halves hold. Deleting a paragraph from the
    description and forgetting to write its replacement here would cost nothing
    visible in review and would quietly take the judgement out of the product,
    so the two are asserted against each other rather than separately.
    """
    from aiq_agent.cards.register import _CARD_DOCTRINE

    body = next(row for _, row in SEEDS if row["name"] == "piloti-cards")["body"]

    # What a follow-up set has to be: anchored to this answer, and four
    # different moves rather than one question four times.
    assert "Anschlussfragen" in body
    # When a takeaway block is earned, and the one-callout rule.
    assert "Kernaussagen" in body
    assert "Hinweis" in body
    # The conflict this skill exists to settle: the ruling is either the card's
    # value or the lede's sentence, never both in the same words.
    assert "Urteilskarte" in body

    # And the description is no longer carrying them.
    assert "GENERIC ones" not in _CARD_DOCTRINE
    assert "NAME something" not in _CARD_DOCTRINE


#: Surfaces the seeds are asserted against. Answer shape is taught on three
#: prompts and the split between them is what these last tests pin; the deep
#: agent module is read for the second delivery channel it opens.
SHALLOW_PROMPT = REPO_ROOT / "src/aiq_agent/agents/shallow_researcher/prompts/researcher.j2"
DEEP_WRITER_PROMPT = REPO_ROOT / "src/aiq_agent/agents/deep_researcher/prompts/writer.j2"
DEEP_AGENT = REPO_ROOT / "src/aiq_agent/agents/deep_researcher/agent.py"


def _answer_shape_section() -> str:
    prompt = SHALLOW_PROMPT.read_text(encoding="utf-8")
    match = re.search(r"<answer_shape>.*?</answer_shape>", prompt, re.DOTALL)
    assert match is not None, "the researcher prompt no longer has an <answer_shape> section"
    return match.group(0)


def _agents_with_a_delivery_surface() -> set[str]:
    """Agents that can actually be handed a resolved skill, read from the code.

    Two channels exist and they are different by necessity. The chat researcher
    resolves per turn inside a live request, so it names the agent at the
    ``SkillResolver`` call site. Deep research runs in a Dask worker with no
    request to read an organization off, so it resolves per RUN through
    ``resolve_served_skills`` and carries the tenant on its own state; its name
    is a module constant, imported here so that renaming or removing it fails
    this test rather than silently shrinking the set.
    """
    from aiq_agent.agents.deep_researcher.agent import SKILL_AGENT as DEEP_SKILL_AGENT

    agents = {
        agent
        for path in (REPO_ROOT / "src").rglob("*.py")
        for agent in re.findall(r'SkillResolver\(agent="([a-z_]+)"\)', path.read_text(encoding="utf-8"))
    }
    if "resolve_served_skills(" in DEEP_AGENT.read_text(encoding="utf-8"):
        agents.add(DEEP_SKILL_AGENT)
    return agents


def _unwrapped(text: str) -> str:
    """``text`` with its hard wraps flattened to single spaces.

    The bodies are wrapped at roughly 80 columns, so a substring assertion that
    quotes a whole sentence would otherwise also be asserting where the seed
    happens to break the line — and a reflow that changes nothing a reader sees
    would fail as if a rule had been deleted.
    """
    return re.sub(r"\s+", " ", text)


def _guard_hashes(tag: str) -> list[str]:
    """The md5 literals a migration guards on, in the order they appear."""
    sql = (DRIZZLE_DIR / f"{tag}.sql").read_text(encoding="utf-8")
    return re.findall(r"md5\([^)]*\)\s*=\s*'([0-9a-f]{32})'", sql)


def test_the_voice_seed_carries_the_answer_shape_craft_the_prompt_no_longer_states():
    """The craft moved OUT of ``<answer_shape>`` and has to have landed here.

    Same split as the cards (3f8c8e4a), for the same reason: the researcher
    prompt is paid on every turn and holds what must be true for the answer to
    be usable — the three turn types, the prose, the sources section, the one
    confidence line. How the answer READS is judgement, and it belongs in a row
    a platform owner rewrites without a deploy.

    Asserted against each other rather than separately. Deleting a paragraph
    from the prompt and forgetting to write its replacement into the seed costs
    nothing visible in review and would quietly take the craft out of the
    product; so would writing it into the seed and leaving the English standing
    in the prompt, which is the duplication this split removed.
    """
    section = _answer_shape_section()
    body = _effective_row("piloti-voice")["body"]

    # The order the reasoning is checked in, and where a caveat may NOT sit.
    assert "Danach der Nachweis, zuletzt die Vorbehalte" in body
    assert "Ein Vorbehalt" in body and "mitten im Absatz" in body
    # A class is named the way the Richtlinie names it, because it gets copied.
    assert "REI 90" in body and "GK 4" in body
    assert "Einreichung ab" in body
    # Headings are earned, and never open the answer.
    assert "Überschriften erst" in body
    assert "nie als erste Zeile" in body

    # And the prompt is no longer carrying any of it.
    assert "Lead with the answer" not in section
    assert "Length follows the question" not in section
    assert "Ziviltechniker" not in section
    assert "REI 90" not in section
    assert "never open with one" not in section

    # What the prompt keeps is the routing — which turn type this applies to —
    # and a pointer, in the `<cards>` idiom: read it there, not here.
    assert "RESEARCH turn" in section
    assert "conversational or off-topic turn" in section
    assert "writing skill active for this turn" in section


#: Every migration that writes a ``piloti-voice`` body, oldest first. Spelled out
#: rather than globbed so that extending the chain is a deliberate edit here as
#: well as in ``frontends/ui/drizzle`` — a link added without one is a link whose
#: guard nothing checks.
VOICE_CHAIN = (
    "0053_piloti_voice_standard_skill",
    "0055_piloti_voice_answer_shape",
    "0057_piloti_voice_hard_cases",
)


def test_every_voice_update_is_guarded_on_the_body_it_replaces():
    """Each link may only overwrite a row still identical to the one before it.

    ``0053`` is a SEED: its ``ON CONFLICT DO NOTHING`` protects a platform
    owner's edits from a re-run, which also means editing the text inside it
    changes nothing in any database that has already applied it. So every new
    body ships as its own migration, and the guard is the only test that
    actually separates an untouched row from an edited one — ``created_by`` does
    not, because the dashboard's update path patches ``body`` and never touches
    it.

    Pinning the hashes here is what keeps the chain honest: editing any literal
    in place silently turns a guard into a condition that matches nothing and
    the update into a no-op that ships green.
    """
    rows = {tag: row for tag, row in SEEDS if row["name"] == "piloti-voice"}
    assert tuple(rows) == VOICE_CHAIN, "a piloti-voice migration is missing from the chain"

    for previous, current in zip(VOICE_CHAIN, VOICE_CHAIN[1:], strict=False):
        before = rows[previous]["body"]
        after = rows[current]["body"]
        assert before != after, f"{current} must actually change the body it inherits"

        assert _guard_hashes(current) == [hashlib.md5(before.encode("utf-8")).hexdigest()], (
            f"{current} does not guard on the body {previous} wrote"
        )

        down = (DRIZZLE_DIR / f"{current}.down.sql").read_text(encoding="utf-8")
        assert re.findall(r"md5\([^)]*\)\s*=\s*'([0-9a-f]{32})'", down) == [
            hashlib.md5(after.encode("utf-8")).hexdigest()
        ], f"{current}.down.sql does not guard on the body it wrote"
        # A rollback that restores a body but leaves the L1 line promising rules
        # the body no longer states has only half-rolled back.
        assert before in down
        assert rows[previous]["description"] in down


def test_the_voice_seed_teaches_the_three_cases_a_shape_rule_does_not_settle():
    """``0057``: what to do when the question is wrong, half-open, or full of numbers.

    Answer shape says where the ruling goes. It does not say what to do when the
    ruling contradicts the asker, when half the question has no answer, or how a
    number is spelled on the way out — and all three are ordinary here. Each is
    a habit rather than a fact, which is why they live in the one body that is
    forced on every answering turn instead of in a prompt branch.

    Pinned rule by rule. A body that keeps the headings and loses the rule under
    one of them reads fine in a dashboard diff and quietly stops teaching it.
    """
    body = _unwrapped(_effective_row("piloti-voice")["body"])

    # 1. The premise is wrong. The correction LEADS, because it is the answer;
    # it is a statement about the Richtlinie and never about the asker; it
    # carries its Fundstelle; and nothing softens it first.
    assert "## Wenn die Frage von einer falschen Annahme ausgeht" in body
    assert "Die Berichtigung ist die Antwort und steht im ersten Satz" in body
    assert "entlang der Richtlinie, nicht entlang der Person" in body
    assert "Die Fundstelle steht" in body
    assert 'kein „gute Frage"' in body
    # The one thing that makes a correction useful rather than merely right:
    # where the wrong number came from.
    assert "woher der genannte Wert stammt" in body
    # And the warmth rule, which allows half a sentence of appreciation, now
    # says where that half sentence may NOT go. Without this the two rules read
    # as contradicting each other.
    assert "nie als Polster vor" in body

    # 2. Only half the question is answerable. „einmal" is per PART; the firm
    # half is answered with no hedging at all; the open half is named together
    # with the place it gets settled.
    assert "## Wenn nur die Hälfte beantwortbar ist" in body
    assert "gilt pro Teil, nicht pro Antwort" in body
    assert "in voller Schärfe, ohne jede Abschwächung" in body
    assert "wo er entschieden wird: in der Bautechnikverordnung des Landes" in body

    # 3. How a number looks inside a sentence.
    assert "## Zahlen im Satz" in body
    assert "Dezimalkomma" in body
    assert "Tausenderpunkt" in body
    assert "geschütztes Leerzeichen (U+00A0)" in body
    assert "≤ und ≥ als Zeichen" in body
    assert "EI₂ 30-C" in body

    # The Fehlanzeige row names the genre's worst turn — answering out of the
    # wrong body of law — instead of being given a worked pair it does not need.
    assert "nie ersatzweise aus einem anderen Regelwerk beantwortet" in body


def test_the_notation_rule_and_the_prompt_formatting_rule_stay_on_their_own_questions():
    """``<formatting>`` decides math mode; the voice decides how the digits look.

    They are one keystroke apart in subject and would be easy to merge by
    accident, and merging them the wrong way is expensive: ``<formatting>`` is
    English and universal (the renderer supports KaTeX, so use it for formulas
    and not for measurements), while the notation rule is German-Austrian and is
    craft a platform owner may rewrite. Asserted against each other so that a
    second copy of either in the other's home fails here rather than drifting.
    """
    prompt = SHALLOW_PROMPT.read_text(encoding="utf-8")
    match = re.search(r"<formatting>.*?</formatting>", prompt, re.DOTALL)
    assert match is not None, "the researcher prompt no longer has a <formatting> section"
    formatting = match.group(0)
    body = _unwrapped(_effective_row("piloti-voice")["body"])

    # The prompt keeps the rendering question, all of it.
    assert "KaTeX" in formatting
    assert "math mode" in formatting
    # And states none of the German notation the body now owns.
    assert "Dezimalkomma" not in formatting
    assert "Tausenderpunkt" not in formatting

    # The body states none of the rendering question, and hands it back in one
    # clause rather than repeating it.
    assert "KaTeX" not in body
    assert "$" not in body
    assert body.count("Formelsatz") == 1
    assert "eine andere Frage und anderswo geregelt" in body

    # Where they touch the same example they must agree, not merely coexist.
    assert "1.200 m²" in formatting
    assert "1.200 m²" in body


def test_the_voice_carries_the_certainty_split_the_confidence_line_cannot():
    """One marker per turn is CONTRACT; two certainties in one answer is craft.

    ``[CONFIDENCE:…]`` is a single value for the whole turn and the output
    contract says so twice, so an answer whose OIB half is settled and whose
    Landesrecht half is not has exactly one line to spend and must spend it on
    the weaker half. That makes the prose the only place the distinction can
    live, which is a fact about the contract and therefore has to be asserted
    against it — a contract that grew a second marker would leave the body
    telling the writer something false.
    """
    prompt = SHALLOW_PROMPT.read_text(encoding="utf-8")
    body = _unwrapped(_effective_row("piloti-voice")["body"])

    assert "Exactly one confidence line" in prompt
    assert "exactly ONE confidence marker" in prompt

    assert "[CONFIDENCE:…]" in body
    assert "ein Wert für den ganzen Zug" in body
    assert "nur in der Prosa" in body


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_grid_agents_all_have_a_surface_that_delivers_the_skill(tag: str, row: dict[str, str]):
    """Knowing an agent's name is not the same as being able to reach it.

    ``test_seeded_grid_agents_are_agents_the_resolver_knows`` checks the
    vocabulary; this checks the plumbing behind each word, which is the failure
    that actually happened. ``piloti-voice`` and ``piloti-cards`` named
    ``deep_researcher`` from the day they were seeded, and for that whole time
    the name was inert: one agent built a ``SkillRuntime`` and the deep pipeline
    resolved builtin skill FILES out of its sandbox instead, so the two rows
    carrying the house voice and the card judgement never reached the surface
    that writes the LONGEST answers. Nothing failed, nothing logged, and the
    metadata went on claiming otherwise.

    Both surfaces are read from the code rather than listed here, so deleting a
    channel fails this test instead of quietly reinstating that state.
    """
    delivering = _agents_with_a_delivery_surface()
    assert delivering == KNOWN_AGENTS, "an agent the resolver knows has nowhere to deliver a skill"
    metadata = json.loads(row["metadata"])
    assert set(split_metadata_list(metadata.get("grid-agents", ""))) <= delivering


def test_the_card_scope_migration_changes_only_the_scope():
    """``0056`` withdraws one claim; it must not carry a prose edit with it.

    The whole row is restated there — the same reason ``0055`` restates one —
    so that the last ``INSERT`` on disk is the row a database ends up with and
    ``_effective_row`` keeps meaning something. The cost of that pattern is a
    second copy of 2,600 tokens of German that a careless edit could silently
    diverge, on a migration whose ``ON CONFLICT`` clause writes back only
    ``metadata`` — so a body changed there would ship as a diff reviewers read
    and no database ever applies. Byte-identity is the only thing that keeps the
    restatement honest.
    """
    seeded = next(row for tag, row in SEEDS if tag.startswith("0054_"))
    rescoped = next(row for tag, row in SEEDS if tag.startswith("0056_"))

    assert rescoped["name"] == seeded["name"] == "piloti-cards"
    assert rescoped["body"] == seeded["body"]
    assert rescoped["description"] == seeded["description"]
    assert rescoped["delivery"] == seeded["delivery"]
    assert rescoped["published"] == seeded["published"]

    before = json.loads(seeded["metadata"])
    after = json.loads(rescoped["metadata"])
    assert set(split_metadata_list(before["grid-agents"])) == {"shallow_researcher", "deep_researcher"}
    assert set(split_metadata_list(after["grid-agents"])) == {"shallow_researcher"}
    # Everything else about the row is 0054's, including the five inlined shapes.
    assert {k: v for k, v in after.items() if k != "grid-agents"} == {
        k: v for k, v in before.items() if k != "grid-agents"
    }

    # The guard is the SCOPE, not a body hash: an owner who rewrote the prose has
    # not thereby chosen an agent scope, and the deep claim is false in their row
    # too. An owner who chose a scope HAS decided, and this may not overwrite it.
    forward = (DRIZZLE_DIR / "0056_piloti_cards_chat_scope.sql").read_text(encoding="utf-8")
    assert "\"metadata\" ->> 'grid-agents' = 'shallow_researcher,deep_researcher'" in forward
    assert not _guard_hashes("0056_piloti_cards_chat_scope")


def test_the_two_cards_the_doctrine_redirects_to_are_reachable_without_a_round_trip():
    """``0061``: `typed_table` and `process_map` join the inlined shapes.

    ``grid-cards`` is read twice and only the first reading is obvious. It is
    the author's card PREFERENCE, and — because ``_preferred_cards_block``
    appends ``render_card_details()`` for exactly those types — it also decides
    which SHAPES are in context at the moment the model would emit. The five
    inlined since 0054 did not include either card the doctrine spends its words
    redirecting TO: ``catalog``'s trigger table sends "rows that are all true at
    once" to ``typed_table`` and this very body works the GK 4 case through to
    it, while ``process_map`` is the card the „wie läuft das ab" transcript was
    supposed to produce. Both were a ``describe_card`` round trip away while
    ``condition_tree``'s full shape sat already rendered — and the observed
    answer took the condition_tree.

    Asserted through ``preferred_cards`` rather than on the JSON text, because
    the read path is what the runtime uses and a name it silently drops would
    leave this passing over a list that inlines nothing.
    """
    row = _effective_row("piloti-cards")
    inlined = preferred_cards(json.loads(row["metadata"]))

    assert "typed_table" in inlined
    assert "process_map" in inlined
    # The five that were already there are still there, in their order: this
    # migration adds, it does not re-curate.
    assert [c for c in inlined if c not in {"typed_table", "process_map"}] == [
        "verdict_header",
        "condition_tree",
        "key_takeaways",
        "callout",
        "follow_ups",
    ]
    # And they resolve to real shapes — an inlined name the catalog has since
    # renamed costs the turn the shape without costing it the token budget.
    detail = render_card_details(inlined)
    assert '"typed_table"' in detail and '"process_map"' in detail


def test_the_reachable_shapes_migration_changes_only_the_card_list():
    """``0061`` restates the whole row and writes back ``metadata`` alone.

    Same pattern and same hazard as ``0056``: the last ``INSERT`` on disk has to
    be the row a fresh database ends up with, so the body is restated — and its
    ``ON CONFLICT`` writes only ``metadata``, so a body edited here would ship as
    a diff reviewers read and no database ever applies. Byte-identity against
    ``0060`` is the only thing that keeps the restatement honest.

    The guard is 0060's BODY hash rather than the metadata it changes, unlike
    0056. Reason: an owner who has rewritten the prose owns the whole row, card
    preferences included, and a preference list naming shapes their body no
    longer discusses is worse than leaving their row alone. ``created_by`` is not
    a guard anywhere in this chain — the dashboard patches ``body`` and never
    touches it, so an edited row still reads ``system``.
    """
    previous = next(row for tag, row in SEEDS if tag.startswith("0060_"))
    current = next(row for tag, row in SEEDS if tag.startswith("0061_"))

    assert current["name"] == previous["name"] == "piloti-cards"
    assert current["body"] == previous["body"]
    assert current["description"] == previous["description"]
    assert current["delivery"] == previous["delivery"]
    assert current["published"] == previous["published"]

    before = json.loads(previous["metadata"])
    after = json.loads(current["metadata"])
    assert {k: v for k, v in after.items() if k != "grid-cards"} == {
        k: v for k, v in before.items() if k != "grid-cards"
    }
    assert set(split_metadata_list(after["grid-cards"])) - set(split_metadata_list(before["grid-cards"])) == {
        "typed_table",
        "process_map",
    }

    forward = (DRIZZLE_DIR / "0061_piloti_cards_reachable_shapes.sql").read_text(encoding="utf-8")
    body_hash = hashlib.md5(previous["body"].encode("utf-8")).hexdigest()
    assert _guard_hashes("0061_piloti_cards_reachable_shapes") == [body_hash]
    assert '"created_by"' not in forward.split("ON CONFLICT")[1]
    # Only metadata is written back. `body`/`description` in the SET clause would
    # make this a body migration that belongs in CARD_CHAIN instead.
    conflict = forward.split("ON CONFLICT")[1]
    assert '"metadata" = EXCLUDED."metadata"' in conflict
    assert '"body" = EXCLUDED' not in conflict
    assert '"description" = EXCLUDED' not in conflict
    # Re-running must be a NO-OP, not an idempotent write: without this clause
    # every replay bumps `updated_at` on a row it did not change.
    assert 'IS DISTINCT FROM EXCLUDED."metadata"' in conflict

    down = (DRIZZLE_DIR / "0061_piloti_cards_reachable_shapes.down.sql").read_text(encoding="utf-8")
    # Both directions gate on the SAME body hash, because neither touches the
    # body: a row whose prose was edited through the dashboard is left alone
    # going forward and coming back.
    assert re.findall(r"md5\([^)]*\)\s*=\s*'([0-9a-f]{32})'", down) == [body_hash]
    # And the rollback restores 0060's exact list, gated on the one 0061 wrote,
    # so an owner who has since re-chosen their cards keeps them.
    assert f"'\"{before['grid-cards']}\"'" in down
    assert after["grid-cards"] in down


def test_the_card_skill_is_not_promised_to_a_surface_that_emits_no_cards():
    """Why ``piloti-cards`` went the OTHER way from ``piloti-voice``.

    Both rows named both agents and only one of those claims was worth making
    true. The voice teaches how a sentence lands and the deep writer writes
    sentences. Cards are a tool call, and the deep writer has no card tool: its
    tool set is ``think`` and ``get_verified_sources``, and a deep job's cards
    are built afterwards by a separate pass over the finished report — a pass
    with no skill runtime, which ``cards/prompt.py`` says in so many words while
    explaining why it re-expressed the craft instead of loading this body.

    Delivering it anyway would hand a surface with no ``emit_card`` an
    instruction to emit cards, plus the ``grid-cards`` shapes to call it with.
    Pinned against the tool set rather than asserted in prose, so that building a
    card channel into deep research is what reopens the question.
    """
    from aiq_agent.agents.deep_researcher.custom_middleware import SourceRegistryMiddleware
    from aiq_agent.agents.deep_researcher.factory import build_deep_research_tool_set

    tool_set = build_deep_research_tool_set(
        [],
        source_registry_middleware=SourceRegistryMiddleware(source_tool_names=set()),
        max_concurrent_source_tool_calls=1,
        max_source_tool_batch_size=1,
    )
    assert "emit_card" not in {tool.name for tool in tool_set.writer_tools}

    metadata = json.loads(_effective_row("piloti-cards")["metadata"])
    assert "deep_researcher" not in split_metadata_list(metadata["grid-agents"])
    # And the voice, which the writer CAN act on, still names it.
    voice = json.loads(_effective_row("piloti-voice")["metadata"])
    assert "deep_researcher" in split_metadata_list(voice["grid-agents"])


def test_the_deep_writer_keeps_its_own_lead_as_the_floor_under_the_voice():
    """The THIRD copy of "answer first" survives the voice arriving, and says why.

    It used to be load-bearing because nothing else reached this agent. Now
    ``piloti-voice`` does — ``DeepResearcherAgent._build_skill_runtime`` resolves
    the organization's skills per run and renders them into the writer's prompt —
    and the paragraph is load-bearing for the opposite reason: resolution
    degrades to nothing on an anonymous run, an unset
    ``GRID_INTERNAL_API_TOKEN``, or a BFF that does not answer, because a
    research report must still be produced when the voice cannot be fetched.

    So it is still not a duplicate to be tidied away — it is the floor under a
    skill that may not arrive — and the reason is pinned next to it so the next
    reader deduplicating these three surfaces deletes the one that can be
    replaced rather than the one that cannot.
    """
    writer = DEEP_WRITER_PROMPT.read_text(encoding="utf-8")
    assert "- Open with the answer." in writer
    assert "must still leave with the right answer" in writer
    assert "must still be produced when the voice cannot be fetched" in writer

    # And the voice, when it does resolve, arrives as its own required skill
    # rather than as a second copy of this paragraph.
    assert "{{ skills_block }}" in writer
    assert "Active skills (required for this turn)" in writer


#: Every migration that writes a ``piloti-cards`` BODY, oldest first. ``0056`` is
#: absent on purpose: it rewrites only ``metadata`` and restates the body
#: byte-for-byte (pinned by ``test_the_card_scope_migration_changes_only_the_scope``),
#: so it guards on the scope it changes rather than on a hash. Spelled out for
#: the same reason ``VOICE_CHAIN`` is — a link added without a guard is a link
#: whose guard nothing checks.
CARD_CHAIN = (
    "0054_piloti_cards_standard_skill",
    "0058_piloti_cards_derivation_and_process",
    "0059_piloti_cards_the_recognised_card",
    "0060_piloti_cards_dossier_and_change",
)


def test_every_card_update_is_guarded_on_the_body_it_replaces():
    """The cards chain gets the guard the voice chain has, for the same reason.

    ``0054`` is a SEED whose ``ON CONFLICT`` protects a platform owner's edits
    from a re-run, which also means editing its text changes nothing in a
    database that has applied it. So every new body ships as its own migration
    and the md5 is the only thing that separates an untouched row from an edited
    one — ``created_by`` does not, because the dashboard's update path patches
    ``body`` and never touches it.

    The chain was unguarded here while ``piloti-voice``'s was pinned, so ``0058``
    shipped with nothing checking that its hash still matched the body it claimed
    to replace. Editing any literal in place silently turns a guard into a
    condition that matches nothing and the update into a no-op that ships green.
    """
    rows = {tag: row for tag, row in SEEDS if row["name"] == "piloti-cards" and tag in CARD_CHAIN}
    assert tuple(rows) == CARD_CHAIN, "a piloti-cards body migration is missing from the chain"

    for previous, current in zip(CARD_CHAIN, CARD_CHAIN[1:], strict=False):
        before = rows[previous]["body"]
        after = rows[current]["body"]
        assert before != after, f"{current} must actually change the body it inherits"

        assert _guard_hashes(current) == [hashlib.md5(before.encode("utf-8")).hexdigest()], (
            f"{current} does not guard on the body {previous} wrote"
        )

        down = (DRIZZLE_DIR / f"{current}.down.sql").read_text(encoding="utf-8")
        assert re.findall(r"md5\([^)]*\)\s*=\s*'([0-9a-f]{32})'", down) == [
            hashlib.md5(after.encode("utf-8")).hexdigest()
        ], f"{current}.down.sql does not guard on the body it wrote"
        # A rollback that restores a body but leaves the L1 line promising a
        # section the body no longer carries has only half-rolled back.
        assert before in down
        assert rows[previous]["description"] in down


def test_the_card_seed_names_the_failure_of_recognising_a_card_and_not_emitting_it():
    """``0059``: the observed fault, written down where the craft lives.

    „Wie läuft das Baubewilligungsverfahren in Wien ab?" is almost word for word
    the ``process_map`` trigger, and it came back as a numbered prose list with
    no card. Asked about it two turns later the model named the right card and
    built a good one immediately — so the vocabulary, the trigger and the shape
    were all reaching it, and what was missing was the instruction that a
    recognised card gets emitted.

    Nine of this body's sections answered "is this card deserved?" and none
    answered "you have decided it is". The new one does, SECOND rather than
    last, because the reader of a long body applies its opening. Pinned rule by
    rule: a body that keeps the heading and loses the naming rule under it reads
    fine in a dashboard diff and quietly stops teaching it.
    """
    body = _unwrapped(_effective_row("piloti-cards")["body"])

    # The fault named as a fault, and the rule that answers it.
    assert "## Die erkannte Karte, die nicht kommt" in body
    assert "Wenn Sie die Karte benennen können, emittieren Sie sie" in body
    assert "Der Auslöser ist bereits die Entscheidung" in body
    # The two excuses it forecloses: prose is faster, and the shape would have
    # to be looked up — the second being the cost this repo deliberately kept
    # rather than inlining every shape on every turn.
    assert "nie, weil die Prosa schneller fertig ist" in body
    assert "billiger als die Karte, die nicht kommt" in body
    # The field case as the Schlecht example, so the rule is anchored to the
    # turn that produced it rather than to an invented one.
    assert "Wie läuft das Baubewilligungsverfahren in Wien ab?" in body
    assert "Fertigstellungsanzeige" in body

    # It is the SECOND section — an instruction to emit, placed after nine
    # sections of "only when it is earned", is read as the tenth qualification.
    headings = [line for line in _effective_row("piloti-cards")["body"].splitlines() if line.startswith("## ")]
    assert headings[0] == "## Die erkannte Karte, die nicht kommt"

    # follow_ups is the counter-evidence the section had to account for: its
    # shape is already inlined, so nothing but the wording kept it off the
    # answer. The set is now the regular close, and the question is which.
    assert "das ist der Regelfall, nicht die Kür" in body
    assert "Zu entscheiden ist nicht ob, sondern welche" in body

    # The volume rule is calibration now, not a warning: the same two, said as a
    # budget. The zero cases stay, because they are the honest ones.
    assert "## Das Kartenbudget einer Antwort" in body
    assert "es ist zum Ausgeben da" in body
    assert "keine ist richtig, wenn die Antwort ein Satz ist" in body
    assert "## Wie viele Karten zu viele sind" not in body


def test_the_card_seed_keeps_every_honesty_rule_the_rebalance_could_have_softened():
    """More cards must never be bought with more invented numbers.

    A rewrite whose whole purpose is to make cards MORE likely is the one edit
    most likely to file an honesty rule down on the way past — and a card is the
    part that gets screenshotted into an Einreichung, so a wrong figure on one
    outlives every sentence around it. Each rule is asserted on the body 0059
    ships, not on the one it inherited.
    """
    body = _unwrapped(_effective_row("piloti-cards")["body"])

    # `calculation` has no result field: the renderer computes from the operands.
    assert "Eingangswerte, nicht das Ergebnis" in body
    assert "Fehlt ein Wert, lassen Sie ihn leer" in body
    assert "Eine geschätzte Zahl, damit die Rechnung aufgeht, ist schlechter als gar keine Karte" in body
    # Provenance and tolerance are copied from `ifc_measure`, never inferred.
    assert "Übernehmen Sie **Herkunft und Toleranz** genau so" in body
    # `process_map` never guesses where the reader stands.
    assert "nur, wenn das Gespräch ihn hergibt" in body
    assert "Ohne Angabe wird nichts markiert" in body
    # And the deletion test that keeps a card from carrying the answer.
    assert "Löschen Sie gedanklich alle Karten" in body


#: cl100k_base tokens for the whole inlined-shape block, measured at 2,157 when
#: 0061 widened the list from five types to seven (1,199 + 265 for
#: ``typed_table`` + 693 for ``process_map``). A CEILING with room for one more
#: ordinary shape, not a pin on today's number.
MAX_INLINED_SHAPE_TOKENS = 2_500


def test_widening_the_inlined_shapes_stayed_a_priced_decision():
    """``grid-cards`` may only grow against a measurement, and this is it.

    This assertion used to run the other way. It held the list at five and said
    so in those words: ``process_map``'s shape costs +693 cl100k tokens on EVERY
    turn this skill loads — every answering turn, since it is standard delivery
    — to save one ``describe_card`` call on the minority of turns that ask about
    a Verfahren, and ``follow_ups`` proves inlining does not cause emission,
    being in the list already and missing from the same answer.

    What changed is not the price but what the price buys. ``follow_ups`` shows
    inlining is not SUFFICIENT for emission; the transcript that widened the list
    shows the other direction, where an answer took ``condition_tree`` — whose
    shape was rendered and in front of it — over the ``typed_table`` the doctrine
    and the body below both redirect it to, which was a round trip away. Inlining
    is not what makes a card get emitted; it is what stops the already-chosen
    card from being the more expensive of two. That is a narrower claim and it is
    the one the field evidence actually supports.

    So the escape hatch the old assertion left open ("widening has to argue with
    a measurement") was taken, and this now guards the same thing from the other
    side: the block is priced, and it may not creep past a stated ceiling
    unmeasured. The words answering the cost of a lookup stay too
    (``test_looking_a_shape_up_is_not_framed_as_a_cost``) — the round trip is
    still what every card outside this list costs.
    """
    metadata = json.loads(_effective_row("piloti-cards")["metadata"])
    inlined = preferred_cards(metadata)

    # The list is a SET of ordinary answer shapes, not the catalog. `calculation`
    # stayed out: it fires on a narrower answer than any of the seven and its
    # shape is among the most expensive.
    assert "calculation" not in inlined
    assert len(inlined) < 10, "grid-cards is becoming the catalog; that is what describe_card is for"

    tiktoken = pytest.importorskip("tiktoken")
    encoding = tiktoken.get_encoding("cl100k_base")
    cost = len(encoding.encode(render_card_details(inlined)))
    assert cost <= MAX_INLINED_SHAPE_TOKENS, (
        f"the inlined card shapes cost {cost} cl100k tokens, over the {MAX_INLINED_SHAPE_TOKENS} "
        "ceiling. Every turn that delivers this standard skill pays it whether or not a card is "
        "emitted. Re-measure and decide rather than letting the list widen because nothing objected."
    )


def test_the_card_seed_carries_the_craft_for_the_three_dossier_types():
    """``0060``: the paragraph half of the rule a new card type owes.

    A new type owes a trigger line to the always-on tool description and a
    paragraph to this skill, and the paragraph is the half that costs nothing
    visible to omit — the trigger is what makes the card emit at all, so it never
    gets forgotten. ``document_checklist``, ``deadline_timeline`` and
    ``change_impact`` shipped their triggers first; this is the other half.

    Named in German, like every other card in this body, because the skill is
    German prose and calls a thing what a reader would call it. Backticks are
    reserved for what the model literally writes.
    """
    from aiq_agent.cards.register import _CARD_DOCTRINE

    body = _unwrapped(_effective_row("piloti-cards")["body"])

    # The tool carries the triggers ...
    for card_type in ("document_checklist", "deadline_timeline", "change_impact"):
        assert card_type in _CARD_DOCTRINE

    # ... and the skill carries what no trigger line has room to say.
    # A Unterlagenliste is a list of STATES, and the card totals them — so a
    # guessed status corrupts the tally and not just its own row.
    assert "## Unterlagenliste: Zustände, nicht Namen" in body
    assert "Setzen Sie `status` ausschließlich dort, wo das Gespräch es hergegeben hat" in body
    assert "verfälscht daher nicht nur seine Zeile, sondern auch die Bilanz" in body
    # One Frist is a Hinweis; several make the ORDER the answer. Never a date,
    # and never a Frist without the event its clock starts from.
    assert "## Fristenlauf: die Reihenfolge ist die Auskunft" in body
    assert "Eine einzelne Frist ist ein Hinweis" in body
    assert "niemals als Datum" in body
    assert "lassen Sie die Frist weg, statt sie ohne Anker hinzuschreiben" in body
    # Order, not duration — the charter's anti-goal D.1 in the model's own words.
    assert "zeichnet die Reihenfolge, nicht die Dauer" in body
    # A consequence without a Fundstelle cannot be acted on, so it is left out;
    # and "unverändert" is half the answer rather than a wasted row.
    assert "## Auswirkung einer Änderung: was ein Wechsel kostet" in body
    assert "ohne Fundstelle lassen Sie sie weg" in body
    assert 'scheuen Sie „unverändert" nicht' in body
    assert "Den Ausgangswert setzen Sie nur, wenn das Gespräch ihn hergegeben hat" in body

    # German names, not wire type values — the convention this body follows.
    for wire_name in ("`condition_tree`", "`typed_table`", "`callout`", "`document_checklist`"):
        assert wire_name not in body


def test_the_bedingungsbaum_vorfrage_sits_with_the_selection_guidance():
    """``0060``: a DISCRIMINATOR, so it joins the section that already discriminates.

    This one prevents a wrong card rather than encouraging a right one, which is
    why it was taken at full strength while a frequency argument elsewhere in the
    same batch was tempered. The defect it names is specific and observed: three
    branches marked active at once read as a decision that was never taken, which
    is worse than no card — the model must mark none when it does not know.

    Placed as a ``###`` inside „Bedingungsbaum, typisierte Tabelle, Vergleich"
    rather than as a fourth ``##``, because a per-card heading would file a
    selection rule under one of the two cards it chooses between.
    """
    raw = _effective_row("piloti-cards")["body"]
    body = _unwrapped(raw)

    assert "### Die Vorfrage zum Bedingungsbaum: kann mehr als eine Zeile gelten?" in body
    assert "**Kann mehr als eine Zeile gleichzeitig zutreffen?**" in body
    assert "Wenn ja, ist es nie ein Baum" in body
    # The observed defect, and the honest alternative to guessing.
    assert "sehen aus wie eine getroffene Entscheidung, obwohl keine getroffen wurde" in body
    assert '„ich weiß es nicht" ist eine Auskunft, geraten ist keine' in body
    # The worked case, which is a typisierte Tabelle and not a tree.
    assert "Feuerwiderstand tragender Bauteile in GK 4" in body
    assert "gelten alle drei zugleich" in body

    # It nests under the selection section, and does not open a new top-level one.
    headings = [line for line in raw.splitlines() if line.startswith("## ") or line.startswith("### ")]
    vorfrage = headings.index("### Die Vorfrage zum Bedingungsbaum: kann mehr als eine Zeile gelten?")
    assert headings[vorfrage - 1] == "## Bedingungsbaum, typisierte Tabelle, Vergleich"


def test_the_closing_calibration_stays_the_last_word_of_the_body():
    """New card paragraphs go BEFORE the budget section, never after it.

    „Das Kartenbudget einer Antwort" is the body's calibration and it works by
    being read last. Appending a new card's paragraph after it would leave the
    body ending on "here is another card you could emit", which is the drift this
    whole line of work exists to keep out — the product owner's reading is that
    emission is already fine.
    """
    headings = [line for line in _effective_row("piloti-cards")["body"].splitlines() if line.startswith("## ")]
    assert headings[-1] == "## Das Kartenbudget einer Antwort"


def test_every_card_type_with_a_trigger_has_its_craft_in_the_seed():
    """A new card type owes a trigger line to the tool and a paragraph to the skill.

    This is the rule commit ``3f8c8e4a`` established and the one a new card type
    is most likely to half-follow: the trigger line is what makes the card get
    emitted at all, so it never gets forgotten, while the paragraph saying when
    the card actually EARNS its place costs nothing visible to omit.

    Asserted for the two shapes added after the split, because they are the first
    types to go through it — ``calculation`` and ``process_map``. Both are named
    by their German subject rather than their type name: the skill is German
    prose and calls a thing what a reader would call it.
    """
    from aiq_agent.cards.register import _CARD_DOCTRINE

    # The LAST seed naming this skill is the current body — `SEEDS` is in
    # migration order and a later guarded DO UPDATE supersedes an earlier row.
    # Taking the first match would assert against the body 0054 shipped and pass
    # for text nobody ships any more.
    body = [row for _, row in SEEDS if row["name"] == "piloti-cards"][-1]["body"]

    # The tool carries the triggers ...
    assert "calculation" in _CARD_DOCTRINE
    assert "process_map" in _CARD_DOCTRINE

    # ... and the skill carries what neither trigger line has room to say.
    # The honesty property of `calculation`: there is no result field, because a
    # stated result that disagrees with its own operands is the worst artefact
    # this product can make.
    assert "Rechenweg" in body
    assert "Eingangswerte, nicht das Ergebnis" in body
    # The factor in „2 x Steigung + Auftritt" belongs to the Bestimmung, not to a
    # measurement — the one modelling decision a writer gets wrong unprompted.
    assert "Der Faktor gehört der" in body
    # `process_map` fails the other way: a row of bare station names is the
    # numbered list it replaced, with a frame drawn round it.
    assert "Verfahrensablauf" in body
    assert "nummerierte Liste" in body
    # And never guessing where the project stands.
    assert "nur, wenn das Gespräch ihn hergibt" in body

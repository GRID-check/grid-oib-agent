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
from pathlib import Path

import pytest

from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.skills.models import MAX_DESCRIPTION_CHARS
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import _validate_metadata
from aiq_agent.skills.models import preferred_cards
from aiq_agent.skills.models import skill_hidden
from aiq_agent.skills.models import split_metadata_list
from aiq_agent.skills.resolver import KNOWN_AGENTS

REPO_ROOT = Path(__file__).resolve().parents[3]
DRIZZLE_DIR = REPO_ROOT / "frontends" / "ui" / "drizzle"

#: The columns the seeds insert, in the order they insert them. Parsing is
#: anchored on this rather than on each file's formatting so a seed that adds a
#: column fails loudly here instead of being read with everything shifted by one.
SEED_COLUMNS = (
    "name",
    "description",
    "body",
    "metadata",
    "published",
    "delivery",
    "created_by",
    "created_by_email",
)

_INSERT_RE = re.compile(
    r'INSERT INTO "platform_skills"\s*\((?P<columns>[^)]*)\)\s*VALUES\s*\(',
    re.IGNORECASE,
)


def _strip_line_comments(sql: str) -> str:
    """Drop ``--`` comments, leaving string literals (which may contain ``--``) intact."""
    out: list[str] = []
    in_string = False
    i = 0
    while i < len(sql):
        char = sql[i]
        if in_string:
            if char == "'":
                # '' is an escaped quote, not the end of the literal.
                if sql[i + 1 : i + 2] == "'":
                    out.append("''")
                    i += 2
                    continue
                in_string = False
            out.append(char)
            i += 1
            continue
        if char == "'":
            in_string = True
            out.append(char)
            i += 1
            continue
        if sql.startswith("--", i):
            i = sql.find("\n", i)
            if i == -1:
                break
            continue
        out.append(char)
        i += 1
    return "".join(out)


def _split_values(sql: str, start: int) -> list[str]:
    """Split the VALUES tuple opening at ``start`` into its top-level items."""
    items: list[str] = []
    current: list[str] = []
    depth = 0
    in_string = False
    i = start
    while i < len(sql):
        char = sql[i]
        if in_string:
            if char == "'":
                if sql[i + 1 : i + 2] == "'":
                    current.append("''")
                    i += 2
                    continue
                in_string = False
            current.append(char)
            i += 1
            continue
        if char == "'":
            in_string = True
            current.append(char)
        elif char == "(":
            depth += 1
            current.append(char)
        elif char == ")":
            if depth == 0:
                items.append("".join(current))
                return [item.strip() for item in items]
            depth -= 1
            current.append(char)
        elif char == "," and depth == 0:
            items.append("".join(current))
            current = []
        else:
            current.append(char)
        i += 1
    raise AssertionError("unterminated VALUES tuple in a platform_skills seed")


def _unquote(literal: str) -> str:
    """The Python value of one SQL literal from a seed's VALUES tuple."""
    value = literal.removesuffix("::jsonb").strip()
    if value.upper() == "NULL":
        return ""
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def _seeded_skills() -> list[tuple[str, dict[str, str]]]:
    """Every ``platform_skills`` seed on disk, as (migration tag, column map)."""
    seeds: list[tuple[str, dict[str, str]]] = []
    for path in sorted(DRIZZLE_DIR.glob("*.sql")):
        if path.name.endswith(".down.sql"):
            continue
        sql = _strip_line_comments(path.read_text(encoding="utf-8"))
        match = _INSERT_RE.search(sql)
        if match is None:
            continue
        columns = [name.strip().strip('"') for name in match.group("columns").split(",")]
        assert tuple(columns) == SEED_COLUMNS, f"{path.name} inserts unexpected columns: {columns}"
        values = _split_values(sql, match.end())
        assert len(values) == len(columns), f"{path.name} has {len(values)} values for {len(columns)} columns"
        seeds.append((path.stem, {name: _unquote(value) for name, value in zip(columns, values, strict=True)}))
    return seeds


SEEDS = _seeded_skills()
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


def _effective_row(name: str) -> dict[str, str]:
    """The row a database ENDS UP with, not the one it was first given.

    ``SEEDS`` is every ``INSERT`` on disk in migration order, and a skill may be
    seeded once and updated later (``0053`` then ``0055`` for ``piloti-voice``).
    Asserting against the first match would test text no live database has held
    since the update shipped, which is the precise failure the update migration
    exists to avoid.
    """
    rows = [row for _, row in SEEDS if row["name"] == name]
    assert rows, f"no seed inserts {name!r}"
    return rows[-1]


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

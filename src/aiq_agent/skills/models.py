"""Skill model and STRICT SKILL.md parsing for the GRID skills substrate.

The agentskills.io format contract:
- ``name``: 1-64 chars, lowercase a-z/0-9/hyphens, no leading/trailing/
  consecutive hyphens; for filesystem skills it must match the parent dir name.
- ``description``: 1-1024 chars, non-empty.
- ``license``: optional free-form string.
- ``compatibility``: optional, at most 500 chars.
- ``metadata``: map of strings; reserved GRID keys are validated
  (``grid-cards`` must name known, non-system Grid card types; ``grid-title``
  is a short human display name).
- ``allowed-tools``: optional free-form string (tool-level allowlist).
- Body: markdown; <500 lines recommended, not enforced.

Unlike deepagents' warn-and-continue scan, GRID's own substrate validates
strictly: an invalid SKILL.md is an error, never a silent skip.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from typing import Literal

import yaml
from pydantic import BaseModel

logger = logging.getLogger(__name__)

#: Frontmatter block at the very start of a SKILL.md file.
FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---(?:\r?\n|$)", re.DOTALL)

#: 1-64 lowercase a-z/0-9 hyphen-separated labels, no leading/trailing/
#: consecutive hyphens.
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_NAME_CHARS = 64
MAX_DESCRIPTION_CHARS = 1024
MAX_COMPATIBILITY_CHARS = 500

#: Reserved GRID metadata keys. ``grid-agents`` is a comma-separated agent
#: name list (absent = all agents). ``grid-cards`` is a comma-separated list of
#: preferred Grid output card types.
#:
#: A skill says nothing about WHEN a JOB runs or WHAT it produces.
#: ``grid-execution`` and ``grid-schedulable`` used to live here; scheduling is
#: a property of a JOB now (a prompt on a timer, with a skill optionally
#: attached), so the output kind is the job's ``output`` column and there is no
#: schedulability marker at all. Both keys are simply unreserved: a stored org
#: row or an old SKILL.md still carrying one keeps it as an ordinary free-form
#: metadata entry, and nothing reads it.
#:
#: ``grid-auto-invoke`` is a different question: whether the model may pick
#: this skill from the L1 catalog unprompted. Slash invocation and jobs still
#: attach it when the flag is off. Absent means on, matching today's behaviour.
GRID_METADATA_KEYS = frozenset(
    {"grid-agents", "grid-cards", "grid-title", "grid-hidden", "grid-auto-invoke", "grid-catalog"}
)

#: ``grid-cards`` — the card types a skill would LIKE its answers rendered as.
#:
#: A preference, not a contract: it costs nothing until the skill is activated,
#: at which point ``SkillRuntime`` appends a short block naming these types to
#: the skill body. Values are card ``type`` literals from the ``GridCard``
#: union, minus ``SYSTEM_CARD_TYPES`` — a system card is emitted by a tool on a
#: sanctioned path, so naming one here would be asking the model to fabricate
#: something it must never produce.
GRID_CARDS_KEY = "grid-cards"

#: ``grid-title`` — the skill's HUMAN name, for a reader rather than a parser.
#:
#: ``name`` is an id: lowercase, hyphenated, unique, and stable enough to be
#: typed after a slash. It is not a label — "ifc-spatial-analysis" is what the
#: resolver matches on, not what belongs in a sentence a user reads while the
#: agent works. Nothing else in the model carries a display string:
#: ``description`` is a full paragraph written for the MODEL's benefit.
#:
#: Deliberately optional and deliberately NOT synthesised from the id. An
#: absent title is absent, and the surface that renders it decides how to
#: degrade (the frontend already owns that decision for every other optional
#: field). Title-casing the id here would manufacture a name nobody wrote and
#: make a missing one indistinguishable from a real one.
#:
#: One value, no per-locale variants: a skill is authored in one language by
#: one tenant, and a translation table in frontmatter would be a second
#: catalog to keep in sync with nothing to keep it honest.
GRID_TITLE_KEY = "grid-title"

#: A title is a label, not a sentence. Long enough for "IFC-Raumanalyse
#: (Fluchtwege)", short enough that no surface has to truncate it.
MAX_TITLE_CHARS = 60

#: ``grid-hidden`` — keep this skill's activation OUT OF THE NOISY LIVE LINE.
#:
#: A boolean-ish flag. Some skills apply on every single answer — a house voice
#: is the type case — so announcing "„piloti-voice" wird angewendet" live under
#: every turn is pure noise, the phantom "web search" mistake in a new costume.
#:
#: Hidden means "not in the live one-liner by default", NEVER "concealed". The
#: activation event STILL fires and STILL records; it is merely routed to the
#: technical channel instead of the live one (see :mod:`aiq_agent.skills.events`),
#: so it stays out of the running line but remains in the recorded trace and in
#: ``skills_activated`` — the disclosure names it like any other skill, and a
#: reader who turns on the "reasoning" preference surfaces it. This is doctrine,
#: not a nicety: a product built on traceable sourcing must not have a class of
#: instruction it declines to admit ran (see agent-skills.md, activation
#: transparency).
#:
#: A property of the SKILL, keyed off metadata rather than a name list in the
#: runtime, for the same reason ``standard`` is: the platform owner sets it on a
#: row and it takes effect with no deploy.
GRID_HIDDEN_KEY = "grid-hidden"

#: ``grid-auto-invoke`` — whether the model may pick this skill from L1.
#:
#: On (the default, and the absent key): the one-line description sits in the
#: catalog the model reads every turn, and it may call ``use_skill`` unprompted.
#: Off: the skill is still resolved, still in the ``/`` picker, still attachable
#: to a job, still loadable when forced. It is merely invisible to the model
#: until a person or a job names it.
#:
#: This is not scheduling. A skill still says nothing about when a job fires.
#: It is catalog membership, the same object as the author's "Agent may pick
#: this" switch.
GRID_AUTO_INVOKE_KEY = "grid-auto-invoke"

#: Case-insensitive truthy tokens that mark a skill hidden. Anything else —
#: including the recognised falsy tokens, an empty string, and any unrecognised
#: word — reads as visible, because visible is the safe default: forgetting the
#: flag under-suppresses (a line too many) rather than swallowing a skill's
#: activation from the live line without anyone asking.
#:
#: Auto-invoke reuses the same token set with the opposite default: absent
#: means on, and only a recognised falsy token stores the opt-out.
_HIDDEN_TRUE = frozenset({"true", "1", "yes"})
_HIDDEN_FALSE = frozenset({"false", "0", "no"})

#: Anything that looks like an XML/HTML tag.
#:
#: NOT an agentskills.io rule — the open format says nothing about tags. It is a
#: GRID prompt-safety rule: ``name`` and ``description`` are interpolated into an
#: agent's system prompt (``SkillRuntime.prompt_block``), where a stray tag can
#: close a structural element the prompt opened and let skill text land in a
#: position it was never meant to occupy. The body is NOT checked — it is
#: markdown delivered through a tool result, and restricting its content would
#: break legitimate skills that document HTML.
#:
#: Anthropic's platform additionally forbids the words "anthropic"/"claude" in a
#: name. That rule governs skills uploaded to their Skills API; this product is
#: LLM-agnostic and never uploads there, so enforcing it here would only reject
#: names a tenant may legitimately want.
XML_TAG_RE = re.compile(r"<[^>]+>")


class SkillValidationError(ValueError):
    """A SKILL.md (or BFF skill payload) violates the agentskills.io contract."""


class Skill(BaseModel):
    """A validated skill in the GRID substrate.

    Attributes:
        name: Lowercase hyphenated skill id (1-64 chars).
        description: One-line summary shown to the model (progressive
            disclosure level 1).
        body: The full markdown instructions (level 2, loaded via
            ``use_skill``).
        metadata: Reserved GRID keys + free-form extra keys.
        origin: ``platform`` for builtin files, ``org`` for BFF-served rows.
        standard: Fleet standard equipment — a published ``delivery: standard``
            platform row. The organization made no decision about it and cannot
            switch it off, so it is applied on every run that resolves it (see
            ``SkillRuntime``) rather than waiting to be chosen.
        collection: Mid-level collection dir name for builtin files
            (research|synthesis); ``None`` for org rows.
        license: Optional license string.
        compatibility: Optional compatibility note (<=500 chars).
        allowed_tools: Optional tool allowlist string.
    """

    name: str
    description: str
    body: str
    metadata: dict[str, str] = {}
    origin: Literal["platform", "org"] = "platform"
    standard: bool = False
    collection: str | None = None
    license: str | None = None
    compatibility: str | None = None
    allowed_tools: str | None = None


def _validate_name(name: Any, expected_dir_name: str | None) -> str:
    if not isinstance(name, str) or not name.strip():
        raise SkillValidationError("Skill 'name' must be a non-empty string")
    name = name.strip()
    if len(name) > MAX_NAME_CHARS:
        raise SkillValidationError(f"Skill name {name!r} exceeds {MAX_NAME_CHARS} characters: {len(name)}")
    if not NAME_RE.match(name):
        raise SkillValidationError(
            f"Skill name {name!r} must be lowercase a-z/0-9 hyphen-separated (no leading/trailing/consecutive hyphens)"
        )
    if XML_TAG_RE.search(name):
        raise SkillValidationError(f"Skill name {name!r} must not contain XML tags")
    if expected_dir_name is not None and name != expected_dir_name:
        raise SkillValidationError(f"Skill name {name!r} does not match its directory name {expected_dir_name!r}")
    return name


def _validate_description(description: Any) -> str:
    if not isinstance(description, str) or not description.strip():
        raise SkillValidationError("Skill 'description' must be a non-empty string")
    description = description.strip()
    if len(description) > MAX_DESCRIPTION_CHARS:
        raise SkillValidationError(f"Skill description exceeds {MAX_DESCRIPTION_CHARS} characters: {len(description)}")
    if XML_TAG_RE.search(description):
        raise SkillValidationError("Skill 'description' must not contain XML tags")
    return description


def _pop_allowed_tools(payload: dict[str, Any]) -> str | None:
    """Read the tool allowlist under either spelling.

    SKILL.md frontmatter spells it ``allowed-tools`` (the Agent Skills spec);
    the BFF row and this module's own field spell it ``allowed_tools``. Reading
    only the underscore form meant a hand-written SKILL.md declaring
    ``allowed-tools`` had its allowlist silently dropped — a permission
    narrowing that vanishes is worse than one that errors, so both spellings
    are accepted and the hyphenated one wins where a file sets both.
    """
    hyphenated = payload.pop("allowed-tools", None)
    underscored = payload.pop("allowed_tools", None)
    value = hyphenated if hyphenated is not None else underscored
    return value if isinstance(value, str) else None


def split_metadata_list(raw: str) -> list[str]:
    """Split a reserved comma-list value: trimmed, empties dropped, order kept.

    Deduplicated because these lists are read as sets of preferences, and a name
    repeated in the frontmatter should not be repeated back at the model.
    """
    seen: set[str] = set()
    out: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _validate_grid_cards(value: str, *, strict: bool) -> str | None:
    """Validate ``grid-cards`` against the model-facing card catalog.

    Returns the value to store, or ``None`` when nothing usable is left and the
    key should be dropped entirely.

    Two tolerances, matching how the two sources of skills fail. A SKILL.md is
    authored in this repo and reviewed, so a name that no longer exists is a
    typo we want to hear about at parse time (``strict``). A BFF-served org row
    is tenant data arriving over the wire, where one stale name must not delete
    the whole skill from the toolbox — so the bad entries are logged and dropped
    and the rest of the row survives, exactly as the resolver treats an unknown
    ``grid-agents`` name.

    A SYSTEM card is rejected on both paths and never merely downgraded: it is
    emitted by a tool on a sanctioned path, and telling the model to produce one
    would be inviting it to fabricate a card the product treats as trustworthy.
    """
    from aiq_agent.cards.catalog import model_facing_card_types

    known = model_facing_card_types()
    names = split_metadata_list(value)
    unknown = [name for name in names if name not in known]
    if unknown and strict:
        raise SkillValidationError(
            f"Skill metadata {GRID_CARDS_KEY} names unknown or system card type(s) {unknown}; allowed: {sorted(known)}"
        )
    if unknown:
        logger.warning(
            "Dropping unknown or system card type(s) from %s: %s (known: %s)",
            GRID_CARDS_KEY,
            unknown,
            sorted(known),
        )
    kept = [name for name in names if name in known]
    return ",".join(kept) if kept else None


def _validate_grid_title(value: str, *, strict: bool) -> str | None:
    """Validate ``grid-title``; return the value to store, or ``None`` to drop it.

    Same two tolerances as :func:`_validate_grid_cards`, for the same reason: a
    SKILL.md is reviewed in this repo, so a title that is empty, over-long or
    carries markup is an authoring error we want at parse time; a BFF-served
    org row is tenant data over the wire, where a bad title must cost the
    tenant its title and not its whole skill.

    Tags are rejected on both paths because a title is interpolated into the
    same prompt-adjacent and user-facing surfaces ``name`` is — see
    :data:`XML_TAG_RE`.
    """
    title = value.strip()
    if not title:
        if strict:
            raise SkillValidationError(f"Skill metadata {GRID_TITLE_KEY} must not be empty")
        logger.warning("Dropping empty %s", GRID_TITLE_KEY)
        return None
    if len(title) > MAX_TITLE_CHARS:
        if strict:
            raise SkillValidationError(
                f"Skill metadata {GRID_TITLE_KEY} exceeds {MAX_TITLE_CHARS} characters: {len(title)}"
            )
        logger.warning("Dropping over-long %s (%d characters)", GRID_TITLE_KEY, len(title))
        return None
    if XML_TAG_RE.search(title):
        if strict:
            raise SkillValidationError(f"Skill metadata {GRID_TITLE_KEY} must not contain XML tags")
        logger.warning("Dropping %s containing XML tags", GRID_TITLE_KEY)
        return None
    return title


def _validate_grid_hidden(value: str, *, strict: bool) -> str | None:
    """Validate ``grid-hidden``; return canonical ``"true"`` to store, or ``None`` to drop.

    Same two tolerances as :func:`_validate_grid_title`, for the same reason: a
    SKILL.md is reviewed in this repo, so ``grid-hidden: maybe`` is an authoring
    typo we want at parse time (``strict``); a BFF-served org row is tenant data
    over the wire, where a garbage flag must cost the tenant the flag and not
    the whole skill (``lenient``).

    A truthy token normalises to the canonical ``"true"``. The recognised falsy
    tokens and an empty string drop the key entirely, because visible is the
    default and an absent key already reads as visible — storing ``"false"``
    would be a second spelling of "nothing" for every reader to special-case.
    A bad flag costs the flag, never the skill or the turn.
    """
    token = value.strip().lower()
    if token in _HIDDEN_TRUE:
        return "true"
    if token in _HIDDEN_FALSE or not token:
        return None
    if strict:
        raise SkillValidationError(
            f"Skill metadata {GRID_HIDDEN_KEY} must be a boolean-ish value "
            f"(one of {sorted(_HIDDEN_TRUE | _HIDDEN_FALSE)}); got {value!r}"
        )
    logger.warning("Dropping unrecognised %s value %r", GRID_HIDDEN_KEY, value)
    return None


def _validate_grid_auto_invoke(value: str, *, strict: bool) -> str | None:
    """Validate ``grid-auto-invoke``; return canonical ``"false"`` or ``None``.

    On is the default, so a truthy token and an empty string drop the key —
    storing ``"true"`` would be a second spelling of "nothing" for every reader
    to special-case. A recognised falsy token stores ``"false"``, because that
    is the opt-out: absent already means on.

    Same two tolerances as :func:`_validate_grid_hidden`. A garbage flag on a
    reviewed SKILL.md is an authoring error; on an org row it costs the flag
    (and so reads as on) rather than the skill.
    """
    token = value.strip().lower()
    if token in _HIDDEN_FALSE:
        return "false"
    if token in _HIDDEN_TRUE or not token:
        return None
    if strict:
        raise SkillValidationError(
            f"Skill metadata {GRID_AUTO_INVOKE_KEY} must be a boolean-ish value "
            f"(one of {sorted(_HIDDEN_TRUE | _HIDDEN_FALSE)}); got {value!r}"
        )
    logger.warning("Dropping unrecognised %s value %r", GRID_AUTO_INVOKE_KEY, value)
    return None


def _stringify_metadata_value(key: str, value: Any) -> str:
    """GRID metadata is strings. YAML and JSON both have native booleans.

    An unquoted ``grid-hidden: true`` is a YAML bool. Rejecting it used to take
    down every builtin when one file used that spelling. Coerce, then validate.
    Integers follow for the same reason (``grid-hidden: 1``). Nested types stay
    an error — those are not a spelling of a flag.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    raise SkillValidationError(f"Skill metadata key {key!r} must map a string to a string")


def _validate_metadata(metadata: Any, *, strict: bool = True) -> dict[str, str]:
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise SkillValidationError("Skill 'metadata' must be a mapping of strings")
    validated: dict[str, str] = {}
    for key, value in metadata.items():
        if not isinstance(key, str):
            raise SkillValidationError(f"Skill metadata key {key!r} must map a string to a string")
        value = _stringify_metadata_value(key, value)
        if key == GRID_CARDS_KEY:
            cards = _validate_grid_cards(value, strict=strict)
            if cards is None:
                continue
            validated[key] = cards
            continue
        if key == GRID_TITLE_KEY:
            title = _validate_grid_title(value, strict=strict)
            if title is None:
                continue
            validated[key] = title
            continue
        if key == GRID_HIDDEN_KEY:
            hidden = _validate_grid_hidden(value, strict=strict)
            if hidden is None:
                continue
            validated[key] = hidden
            continue
        if key == GRID_AUTO_INVOKE_KEY:
            auto_invoke = _validate_grid_auto_invoke(value, strict=strict)
            if auto_invoke is None:
                continue
            validated[key] = auto_invoke
            continue
        validated[key] = value
    return validated


def preferred_cards(metadata: dict[str, str]) -> tuple[str, ...]:
    """The card types a skill prefers, in author order; ``()`` when unset.

    Filtered against the catalog on read as well as on write: a skill snapshot
    persisted before a card type was retired would otherwise name a card the
    renderer no longer has.
    """
    from aiq_agent.cards.catalog import model_facing_card_types

    raw = metadata.get(GRID_CARDS_KEY)
    if not raw:
        return ()
    known = model_facing_card_types()
    return tuple(name for name in split_metadata_list(raw) if name in known)


def skill_title(skill: Skill) -> str | None:
    """The skill's human display name, or ``None`` when the author gave none.

    ``None`` is a real answer, not a failure: see :data:`GRID_TITLE_KEY` for
    why no title is ever synthesised from the id here.
    """
    title = skill.metadata.get(GRID_TITLE_KEY)
    return title if title else None


def skill_hidden(metadata: dict[str, str]) -> bool:
    """Whether this skill's live activation line is suppressed by default.

    ``True`` routes the activation to the technical channel instead of the live
    one (see :mod:`aiq_agent.skills.events`), keeping it out of the noisy live
    line while the event still fires and still records. Hidden is never
    concealed: the disclosure still names the skill and a reader who turns on
    the "reasoning" preference surfaces it — see :data:`GRID_HIDDEN_KEY`.

    Read as tolerantly as it is written: the value stored is the canonical
    ``"true"``, but an un-revalidated snapshot may carry any truthy token, so an
    absent or unrecognised value reads as visible — the fail-open default.
    """
    return metadata.get(GRID_HIDDEN_KEY, "").strip().lower() in _HIDDEN_TRUE


def skill_auto_invoke(metadata: dict[str, str]) -> bool:
    """Whether the model may pick this skill from the L1 catalog unprompted.

    Absent or unrecognised reads as on: that is today's behaviour, and
    forgetting the flag must not silently hide a skill from every turn. Only a
    recognised falsy token opts out. Slash invocation, jobs, and a forced
    standard skill still attach it either way — see :data:`GRID_AUTO_INVOKE_KEY`.
    """
    token = metadata.get(GRID_AUTO_INVOKE_KEY, "").strip().lower()
    if not token:
        return True
    if token in _HIDDEN_FALSE:
        return False
    return True


def build_skill_from_payload(
    payload: dict[str, Any],
    *,
    origin: Literal["platform", "org"] = "platform",
    collection: str | None = None,
    standard: bool = False,
) -> Skill:
    """Build + validate a :class:`Skill` from parsed data (YAML frontmatter or BFF row).

    Raises :class:`SkillValidationError` on any contract violation — the shared
    strict path for both builtin files and org rows.

    The one deliberate softening is ``origin="org"``: a tenant row's reserved
    comma-lists are validated leniently (unknown entries logged and dropped)
    rather than taking the whole skill down. Everything structural still errors.
    """
    payload = dict(payload)
    name = _validate_name(payload.get("name"), expected_dir_name=None)
    description = _validate_description(payload.get("description"))
    metadata = _validate_metadata(payload.get("metadata"), strict=origin != "org")
    body = payload.get("body")
    if not isinstance(body, str):
        raise SkillValidationError(f"Skill {name!r} body must be a string")
    compatibility = payload.get("compatibility")
    if compatibility is not None and (
        not isinstance(compatibility, str) or len(compatibility) > MAX_COMPATIBILITY_CHARS
    ):
        raise SkillValidationError(
            f"Skill {name!r} compatibility must be a string of at most {MAX_COMPATIBILITY_CHARS} characters"
        )
    license_ = payload.get("license")
    allowed_tools = _pop_allowed_tools(payload)
    return Skill(
        name=name,
        description=description,
        body=body,
        metadata=metadata,
        origin=origin,
        standard=standard,
        collection=collection,
        license=license_ if isinstance(license_, str) else None,
        compatibility=compatibility,
        allowed_tools=allowed_tools,
    )


def parse_skill_md(
    text: str,
    expected_dir_name: str | None = None,
    *,
    origin: Literal["platform", "org"] = "platform",
    collection: str | None = None,
    standard: bool = False,
) -> Skill:
    """Parse a SKILL.md document into a validated :class:`Skill`.

    HARD-fails (raises :class:`SkillValidationError`) on malformed frontmatter,
    invalid YAML, or any field violating the agentskills.io contract — the
    substrate validates strictly, unlike deepagents' warn-and-continue scan.
    """
    match = FRONTMATTER_RE.match(text)
    if match is None:
        raise SkillValidationError("SKILL.md must start with a `---` YAML frontmatter block")
    try:
        raw = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise SkillValidationError(f"Invalid YAML frontmatter: {exc}") from exc
    if not isinstance(raw, dict):
        raise SkillValidationError("SKILL.md frontmatter must be a YAML mapping")

    payload = dict(raw)
    name = _validate_name(payload.pop("name", None), expected_dir_name)
    description = _validate_description(payload.pop("description", None))
    metadata = _validate_metadata(payload.pop("metadata", None))
    compatibility = payload.pop("compatibility", None)
    if compatibility is not None and (
        not isinstance(compatibility, str) or len(compatibility) > MAX_COMPATIBILITY_CHARS
    ):
        raise SkillValidationError(
            f"Skill {name!r} compatibility must be a string of at most {MAX_COMPATIBILITY_CHARS} characters"
        )
    license_ = payload.pop("license", None)
    allowed_tools = _pop_allowed_tools(payload)
    body = text[match.end() :].strip()
    return Skill(
        name=name,
        description=description,
        body=body,
        metadata=metadata,
        origin=origin,
        collection=collection,
        license=license_ if isinstance(license_, str) else None,
        compatibility=compatibility,
        allowed_tools=allowed_tools,
    )

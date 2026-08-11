"""Skill model and STRICT SKILL.md parsing for the GRID skills substrate.

The agentskills.io format contract:
- ``name``: 1-64 chars, lowercase a-z/0-9/hyphens, no leading/trailing/
  consecutive hyphens; for filesystem skills it must match the parent dir name.
- ``description``: 1-1024 chars, non-empty.
- ``license``: optional free-form string.
- ``compatibility``: optional, at most 500 chars.
- ``metadata``: map of strings; reserved GRID keys are validated
  (``grid-execution`` must be ``chat`` | ``deep-research``; ``grid-cards`` must
  name known, non-system Grid card types).
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
#: name list (absent = all agents). ``grid-schedulable`` is a schedulability
#: marker. ``grid-execution`` selects the execution mode. ``grid-cards`` is a
#: comma-separated list of preferred Grid output card types.
GRID_METADATA_KEYS = frozenset({"grid-execution", "grid-schedulable", "grid-agents", "grid-cards"})
GRID_EXECUTION_VALUES = frozenset({"chat", "deep-research"})

#: ``grid-cards`` — the card types a skill would LIKE its answers rendered as.
#:
#: A preference, not a contract: it costs nothing until the skill is activated,
#: at which point ``SkillRuntime`` appends a short block naming these types to
#: the skill body. Values are card ``type`` literals from the ``GridCard``
#: union, minus ``SYSTEM_CARD_TYPES`` — a system card is emitted by a tool on a
#: sanctioned path, so naming one here would be asking the model to fabricate
#: something it must never produce.
GRID_CARDS_KEY = "grid-cards"

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


def _validate_metadata(metadata: Any, *, strict: bool = True) -> dict[str, str]:
    if metadata is None:
        return {}
    if not isinstance(metadata, dict):
        raise SkillValidationError("Skill 'metadata' must be a mapping of strings")
    validated: dict[str, str] = {}
    for key, value in metadata.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise SkillValidationError(f"Skill metadata key {key!r} must map a string to a string")
        if key == "grid-execution" and value not in GRID_EXECUTION_VALUES:
            raise SkillValidationError(
                f"Skill metadata grid-execution must be one of {sorted(GRID_EXECUTION_VALUES)}, got {value!r}"
            )
        if key == GRID_CARDS_KEY:
            cards = _validate_grid_cards(value, strict=strict)
            if cards is None:
                continue
            validated[key] = cards
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


def build_skill_from_payload(
    payload: dict[str, Any],
    *,
    origin: Literal["platform", "org"] = "platform",
    collection: str | None = None,
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

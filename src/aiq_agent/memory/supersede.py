"""Which memory entry a new finding makes wrong, decided (ADR-0064, use 7).

Memory rots when a correction lands beside the entry it corrects and both stay
live: a later turn reads either. The single writer (``createProjectMemoryItem``
in the BFF) retires an entry when the writer quotes it as ``supersedes``, or
when the two are worded closely enough for its polarity split to see the
contradiction. What it cannot see is a correction worded differently from the
entry it corrects, with no quote: „Das Grundstück liegt in St. Pölten" against
„Das Projekt liegt in Wien" shares no word (``project-memory-design.md`` §3.2
names it as outstanding).

That is a yes/no per pair — does this finding make that entry wrong — which
the decision model answers for each entry of the digest in parallel. A
confident yes fills the ``supersedes`` quote the writer was already asked to
fill, through the same API field, so nothing reaches the writer by a second
path (ADR-0055) and the writer's own rules still hold: an unresolvable quote
is ignored, and a pinned, user-confirmed or user-authored entry is never
retired by an agent. A quote the writer supplied itself wins; no decision, no
quote, as before.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

#: One rendered digest line: ``- [tags] "content"`` (the BFF's
#: ``formatBoundedDigest``, which escapes backslashes and quotes).
DIGEST_ENTRY_RE = re.compile(r'^\s*-\s*\[([^\]]*)\]\s*"(.*)"\s*$')
#: The technical-record slot: ``status:decision:memory_supersede``.
SLOT = "memory_supersede"
#: At or above this p(replaces) the entry is quoted as superseded. Measured
#: 2026-09-26 over two runs on a twelve-entry memory and sixteen findings
#: (``tests/fixtures/decisions/memory_supersede.yaml``): the eight corrections
#: named the right entry at 0.88-0.97 once the criteria say that Projekt and
#: Grundstück name the same location (without it, „Das Grundstück liegt in
#: St. Pölten" against „Das Projekt liegt in Wien" scored 0.79-0.81); no other
#: pair above 0.41.
REPLACES_THRESHOLD = 0.8
#: How many entries are asked about; the digest is bounded at 6 000
#: characters upstream, which is about this many one-sentence entries.
MAX_ENTRIES = 40

_REPLACES = (
    "Does the new finding make the existing memory entry wrong or outdated, so that the entry should be retired?"
)
_REPLACES_TRUE = (
    "Both are about the same property of the project (its location, a count, a material, a use, a date, an "
    "open question) and the new finding states a different value or settles it, so the entry no longer holds. "
    "The same property is often named with different words: Projekt, Grundstück, Standort and Bauplatz all "
    "name where the project is."
)
_REPLACES_FALSE = (
    "The new finding adds a detail, restates the entry, or is about a different property of the project; the "
    "entry still holds."
)


def digest_entries(memory_digest: str | None) -> list[str]:
    """The project-scoped entries of a digest, as the writer stored them (unescaped)."""
    entries: list[str] = []
    for line in (memory_digest or "").splitlines():
        match = DIGEST_ENTRY_RE.match(line)
        if not match or "org-wide" in match.group(1):
            continue
        content = re.sub(r"\\(.)", r"\1", match.group(2)).strip()
        if content and content not in entries:
            entries.append(content)
    return entries[:MAX_ENTRIES]


async def decided_supersedes(content: str, memory_digest: str | None, *, organization_id: str | None) -> str | None:
    """The entry ``content`` makes wrong, verbatim, or ``None`` (none, unsure, or no decision)."""
    entries = [entry for entry in digest_entries(memory_digest) if entry != content.strip()]
    if not content.strip() or not entries:
        return None
    from aiq_agent.common.decisions import decide_many
    from aiq_agent.common.decisions import noul

    decided = await decide_many(
        [{"new_finding": content.strip(), "existing_entry": entry} for entry in entries],
        {"replaces": noul(_REPLACES, true=_REPLACES_TRUE, false=_REPLACES_FALSE)},
        slot=SLOT,
        organization_id=organization_id,
    )
    scored = [
        (p, entry) for d, entry in zip(decided, entries) if d is not None and (p := d.noul("replaces")) is not None
    ]
    if not scored:
        return None
    p, entry = max(scored, key=lambda pair: pair[0])
    if p < REPLACES_THRESHOLD:
        return None
    logger.info("Decided that a new memory finding supersedes an entry (p=%.2f)", p)
    return entry


async def supersedes_for(
    content: str, supplied: str | None, memory_digest: str | None, *, organization_id: str | None
) -> str | None:
    """The quote to send: the writer's own when it gave one, else the decided one."""
    if supplied and supplied.strip():
        return supplied.strip()
    try:
        return await decided_supersedes(content, memory_digest, organization_id=organization_id)
    except Exception as exc:  # noqa: BLE001 — a missed retirement is how memory behaved before
        logger.warning("Supersede decision failed: %s", type(exc).__name__)
        return None

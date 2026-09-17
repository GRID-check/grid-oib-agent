"""Strip leaked DeepSeek DSML tool-call blocks from a visible answer.

Some models occasionally emit their tool-call machinery as *literal text* in the
final answer instead of as a real tool invocation. DeepSeek does this with DSML
blocks delimited by fullwidth vertical bars (``U+FF5C`` ``｜``), e.g.::

    <｜DSML｜invoke name="emit_card">
    <｜DSML｜parameter name="card_json" string="true">{"type": "summary", ...}

When that happens the card never reaches the registry (no tool actually ran) and
the raw markup pollutes the rendered answer. This module:

1. detects well-formed DSML tool-call blocks (guarded by the DSML marker so
   ordinary prose is never touched),
2. salvages any ``emit_card`` invocation whose ``card_json`` parses, feeding it
   to the conversation card registry the way the real ``emit_card`` tool does,
3. strips the machinery from the visible answer, leaving surrounding prose intact.

Everything is fail-soft: a malformed or unparseable block is left untouched (for
salvage) but still stripped from the visible text when it is well-formed markup.
"""

from __future__ import annotations

import json
import logging
import re

from aiq_agent.cards.catalog import ENVELOPE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)

# Fullwidth vertical bar (U+FF5C) — the DSML delimiter. A DSML tag looks like
# ``<｜DSML｜...>`` (open) or ``</｜DSML｜...>`` (close).
_BAR = "｜"
_DSML_MARKER = f"<{_BAR}DSML{_BAR}"

# An opening or closing DSML tag, e.g. ``<｜DSML｜invoke name="emit_card">`` or
# ``</｜DSML｜invoke>``.
_DSML_TAG_RE = re.compile(rf"</?{_BAR}DSML{_BAR}[^>]*>")

# The start of a leaked tool-call region: a ``tool_calls`` wrapper or an
# ``invoke`` opener.
_REGION_START_RE = re.compile(rf"<{_BAR}DSML{_BAR}(?:tool_calls>|invoke\b)")

# An ``emit_card`` invoke whose ``card_json`` parameter opener we can locate; the
# JSON object itself is extracted by brace-balancing immediately after.
_EMIT_CARD_PARAM_RE = re.compile(
    rf"<{_BAR}DSML{_BAR}invoke name=\"emit_card\">.*?"
    rf"<{_BAR}DSML{_BAR}parameter name=\"card_json\"[^>]*>",
    re.DOTALL,
)


def _string_step(ch: str, escaped: bool) -> tuple[bool, bool]:
    """One character inside a JSON string literal: ``(still_in_string, escaped)``."""
    if escaped:
        return True, False
    if ch == "\\":
        return True, True
    return ch != '"', False


def _extract_balanced_json(text: str, start: int) -> tuple[str | None, int]:
    """Return the brace-balanced JSON object starting at ``text[start]``.

    ``start`` must point at ``{``. Returns ``(json_substring, end_index)`` where
    ``end_index`` is exclusive, or ``(None, start)`` when no balanced object is
    found. String literals (and their escapes) are respected so braces inside
    strings do not throw off the depth count.
    """
    if start >= len(text) or text[start] != "{":
        return None, start
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            in_string, escaped = _string_step(ch, escaped)
            continue
        if ch == '"':
            in_string = True
            continue
        depth += (ch == "{") - (ch == "}")
        if depth == 0:
            return text[start : i + 1], i + 1
    return None, start


def _dsml_token_end(region: str, i: int) -> int | None:
    """Where the DSML token (tag or JSON payload) starting at ``i`` ends, or None if there is none."""
    if region[i] == "<":
        match = _DSML_TAG_RE.match(region, i)
        return match.end() if match else None
    if region[i] == "{":
        _, end = _extract_balanced_json(region, i)
        return end if end > i else None
    return None


def _consume_dsml_region(region: str) -> int:
    """Return the length of the leading run of DSML machinery in ``region``.

    Consumes DSML tags, brace-balanced JSON payloads, and whitespace, stopping at
    the first character that belongs to none of those (i.e. normal prose). This
    is what lets us strip only the well-formed machinery and preserve any text
    that follows it.
    """
    i = 0
    # Position just past the last DSML token (tag or JSON payload). Whitespace
    # after the final token belongs to any following prose, not to the region,
    # so we never consume past ``last_end``.
    last_end = 0
    while i < len(region):
        if region[i].isspace():
            i += 1
            continue
        end = _dsml_token_end(region, i)
        if end is None:
            break
        i = last_end = end
    return last_end


def _salvage_card(card_json: str) -> None:
    """Validate and register one card the way the real ``emit_card`` tool does.

    Mirrors ``aiq_agent.cards.register.emit_card``: parse → validate against the
    shared adapter → reject system-only card types → push into the active
    conversation card registry. Fail-soft.
    """
    try:
        # strict=False for the same reason emit_card parses with it: a raw
        # newline inside a string is a multi-line mermaid source, not bad JSON.
        payload = json.loads(card_json, strict=False)
        if not isinstance(payload, dict):
            return
        validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
        if validated.get("type") in SYSTEM_CARD_TYPES | ENVELOPE_CARD_TYPES:
            # System cards are emitted only by their owning tool on a sanctioned
            # path, and envelope shapes are answer-envelope fields, not cards —
            # never salvage either from leaked model text.
            return
        registry = get_card_registry()
        if registry is None:
            return
        registry.add(validated)
        logger.info("Salvaged leaked DSML emit_card '%s'", validated.get("type"))
    except Exception:  # noqa: BLE001 — salvage is best-effort
        logger.warning("Failed to salvage leaked DSML card", exc_info=True)


def strip_and_salvage_dsml_tool_calls(content: str) -> str:
    """Strip leaked DSML tool-call machinery and salvage any ``emit_card`` block.

    Conservative: if the DSML marker is absent the content is returned unchanged,
    so ordinary prose (including text that merely discusses tool calls) is never
    touched. Only the well-formed DSML region is removed; text before and after
    it is preserved.
    """
    if not content or _DSML_MARKER not in content:
        return content

    start_match = _REGION_START_RE.search(content)
    if not start_match:
        return content

    region_start = start_match.start()
    region = content[region_start:]

    # Salvage every emit_card invocation before we discard the markup.
    for param_match in _EMIT_CARD_PARAM_RE.finditer(region):
        card_json, _ = _extract_balanced_json(region, param_match.end())
        if card_json:
            _salvage_card(card_json)

    consumed = _consume_dsml_region(region)
    if consumed <= 0:
        return content

    head = content[:region_start]
    tail = region[consumed:]
    stripped = (head.rstrip() + tail).rstrip()
    return stripped

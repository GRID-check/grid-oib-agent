"""The fan-out JSON is for the Herleitung and the registry, never for the model.

Every rendered grounding block ends in ``## Trace-Lanes`` and one line of JSON
that the frontend groups sources by. It travelled in every ``ToolMessage`` too,
so the model re-read a thousand tokens of ``{"lanes": …}`` per search on every
later call of the turn, and again from the history on the next turn. These
tests pin the one helper that takes the line out and leaves everything the
model does read — the passages, the ``Citation:`` keys, the ``## Gliederung``
trailer — byte-for-byte where it was.
"""

from __future__ import annotations

from aiq_agent.common.grounding_block import TRACE_LANES_MARKER
from aiq_agent.common.grounding_block import strip_trace_lanes

_BLOCK = (
    "Found 1 relevant document(s):\n"
    "\n"
    "--- Result 1 ---\n"
    "Source: OIB-Richtlinie 2, Ausgabe Mai 2023\n"
    "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3\n"
    "\n"
    "Diese Richtlinie gilt für …\n"
    "\n"
    "## Trace-Lanes\n"
    '{"lanes": [{"key": "baurecht_oib", "sources": [{"name": "oib-rl_2_ausgabe_mai_2023.pdf"}]}]}\n'
    "\n"
    "## Gliederung\n"
    "- Punkt 0: Vorbemerkungen (S. 3)\n"
    "\n"
    "Einen gelisteten Punkt öffnest du mit `read_passage(document=…, punkt=…)`.\n"
)


def test_the_lanes_line_goes_and_the_rest_stays():
    stripped = strip_trace_lanes(_BLOCK)

    assert TRACE_LANES_MARKER not in stripped
    assert '"lanes"' not in stripped
    assert "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3" in stripped
    assert "Diese Richtlinie gilt für …" in stripped
    assert "## Gliederung\n- Punkt 0: Vorbemerkungen (S. 3)" in stripped


def test_the_trailer_still_follows_the_passages_after_one_blank_line():
    stripped = strip_trace_lanes(_BLOCK)

    assert "Diese Richtlinie gilt für …\n\n## Gliederung" in stripped


def test_a_block_that_ends_in_the_lanes_keeps_its_passages():
    without_trailer = _BLOCK.split("\n## Gliederung", 1)[0] + "\n"

    stripped = strip_trace_lanes(without_trailer)

    assert stripped.endswith("Diese Richtlinie gilt für …\n")
    assert TRACE_LANES_MARKER not in stripped


def test_text_without_the_marker_is_returned_unchanged():
    text = "No passage matched query='x'. Retry once with a shorter topic query."
    assert strip_trace_lanes(text) is text


def test_it_is_idempotent():
    once = strip_trace_lanes(_BLOCK)
    assert strip_trace_lanes(once) == once

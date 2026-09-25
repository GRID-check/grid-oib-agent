"""The answer's one repair: a misremembered quotation corrected in place.

The repair used to rewrite the WHOLE answer when verification failed: a second
frontier call with the full history, up to two retrievals, 10-25 s, and an
answer adopted if it verified better. With the prose streaming (ADR-0066), the
reader had read the answer by then, and an adopted rewrite swapped every byte
of it. ADR-0067 narrows the repair to the one failure where one buys the
reader something, and to the one place it happened:

* A citation whose source line did not resolve gets no repair. The settled
  snapshot has already dropped it where the reader can see; putting one back
  seconds later is the swap again.
* A quote no passage holds verbatim, when a passage of a source its own
  sentence CITES comes close (``UnverifiedQuote.nearest``), is a quotation the
  model misremembered. A close passage of a source it does not cite is never
  used: the corpus holds near-identical texts per Bundesland, and a patch from
  the wrong one would put that text under this citation. The
  small model is given that passage and the quote and returns the passage's
  own wording for it. Only the text between the quotation marks is replaced,
  so the ``[N]`` markers and the rest of the answer cannot move. The
  correction is kept only when the same verifier accepts it against that
  passage and it stays close to what was quoted; otherwise the quote keeps its
  marker, which is the floor.
* A quote too long to be one, or with no citation in its sentence, is an
  attribution problem, not a wording one, and keeps its marker.

Bounded: at most :data:`MAX_PATCHES` quotes, in parallel, each within
:data:`PATCH_TIMEOUT_S`. A timeout or a provider error costs nothing but the
correction.
"""

from __future__ import annotations

import asyncio
import difflib
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.common import content_to_text
from aiq_agent.common.citation_verification import _QUOTE_MAX_WORDS
from aiq_agent.common.citation_verification import _QUOTED_SPAN_RE
from aiq_agent.common.citation_verification import MIN_QUOTE_LEN
from aiq_agent.common.citation_verification import UnverifiedQuote
from aiq_agent.common.citation_verification import _normalize_for_quote_match
from aiq_agent.common.citation_verification import closeness

logger = logging.getLogger(__name__)

#: How close the quote must come to some stretch of its nearest passage
#: (:func:`closeness`) before it counts as misremembered rather than invented.
#: Below it the model was not quoting that passage, and "correcting" it would
#: put different words in its mouth. Measured on the test fixtures: a quote
#: with two words changed scores 0.82-0.85, an invented one 0.39-0.50.
PATCH_FLOOR = 0.7

#: How similar the corrected wording must stay to what was quoted. A correction
#: that shares less is a different sentence of the passage, not this one.
MIN_SIMILARITY = 0.6

#: At most this many quotes are patched per answer; the rest keep their marker.
MAX_PATCHES = 3

#: Upper bound on one patch call. The answer is final without it.
PATCH_TIMEOUT_S = 8.0

#: The call the pipeline makes: the misquote and its passage in, the passage's
#: own wording out (``None`` when there is none).
QuotePatchFn = Callable[[str, str], Awaitable[str | None]]

_SYSTEM_PROMPT = (
    "You correct ONE quotation against the passage it was taken from. You are given the passage "
    "and the quotation as it was written. Return the passage's own wording that the quotation "
    "renders, copied character for character from the passage: the same sentence or clause, no "
    "more. Do not paraphrase, shorten, translate or add anything. If the passage does not contain "
    "what the quotation says, return exactly NONE. Return only the wording, without quotation marks."
)


def select(quotes: Sequence[UnverifiedQuote]) -> list[UnverifiedQuote]:
    """The flagged quotes this repair may correct, at most :data:`MAX_PATCHES`.

    Misremembered, not unattributed (``reason`` is ``not_verbatim``), with a
    passage of a cited source close enough (``closeness`` ≥ :data:`PATCH_FLOOR`).
    Every flagged quote's closeness is logged, selected or not: it is what
    ``PATCH_FLOOR`` should be read off.
    """
    chosen: list[UnverifiedQuote] = []
    for quote in quotes:
        passage = quote.nearest.chunk_text if quote.nearest is not None else None
        if not passage:
            logger.info("Piloti: unverified quote (%s), no cited passage", quote.reason)
            continue
        score = closeness(quote.quote, passage)
        logger.info("Piloti: unverified quote (%s), closeness %.2f", quote.reason, score)
        if quote.reason == "not_verbatim" and score >= PATCH_FLOOR:
            chosen.append(quote)
    return chosen[:MAX_PATCHES]


#: The quotation-mark pairs a model may wrap its answer in. Only a MATCHED
#: outer pair is removed: a lone mark at an edge is the passage's own wording
#: (``der Bereich „zwischen Brandwänden“``), and stripping it leaves the
#: correction with an unbalanced „.
_OUTER_PAIRS = frozenset(
    {
        ("„", "“"),
        ("„", "”"),
        ("“", "”"),
        ('"', '"'),
        ("'", "'"),
        ("‚", "‘"),
        ("‚", "’"),
        ("‘", "’"),
        ("»", "«"),
        ("«", "»"),
        ("›", "‹"),
        ("‹", "›"),
    }
)


def _unwrapped(text: str) -> str:
    """``text`` without one matched pair of outer quotation marks, when it has one."""
    text = text.strip()
    if len(text) >= 2 and (text[0], text[-1]) in _OUTER_PAIRS:
        return text[1:-1].strip()
    return text


def _reads_back_as_one_quote(corrected: str, span: str) -> bool:
    """Whether ``corrected``, between ``span``'s own marks, is still exactly that one quotation.

    A correction holding the enclosing quote's marks (``„…“`` inside ``„…“``)
    nests them: the verifier would read only the inner phrase, and the patched
    quote would ship without ever being checked again.
    """
    if len(span) < 2:
        return True
    match = _QUOTED_SPAN_RE.fullmatch(f"{span[0]}{corrected}{span[-1]}")
    return match is not None and next((group for group in match.groups() if group is not None), None) == corrected


def accept(original: str, corrected: str | None, passage: str, *, span: str = "") -> str | None:
    """The corrected wording when it holds, else ``None``.

    Holds means: it is in the passage verbatim (normalised as the verifier
    normalises), it is long enough to be verified and short enough to be a
    quotation, it stays close to what was quoted, and, put between the marks
    of ``span`` (the quote as written, marks included), it reads back as that
    one quotation.
    """
    if not corrected:
        return None
    corrected = _unwrapped(corrected)
    if not corrected or corrected.upper() == "NONE":
        return None
    norm = _normalize_for_quote_match(corrected)
    if len(norm) < MIN_QUOTE_LEN or len(corrected.split()) > _QUOTE_MAX_WORDS:
        return None
    if not _reads_back_as_one_quote(corrected, span):
        return None
    # Verbatim, not merely verified: the verifier's fuzzy threshold tolerates
    # OCR noise, and a corrected "2,50 m" against a passage saying "2,10 m"
    # clears it. A correction is copied from the passage or it is not one.
    if norm not in _normalize_for_quote_match(passage):
        return None
    similarity = difflib.SequenceMatcher(None, _normalize_for_quote_match(original), norm).ratio()
    return corrected if similarity >= MIN_SIMILARITY else None


def splice(content: str, patches: Sequence[tuple[UnverifiedQuote, str]]) -> str:
    """``content`` with each quote's inner text replaced, right to left so offsets hold."""
    for quote, corrected in sorted(patches, key=lambda patch: patch[0].start, reverse=True):
        span = content[quote.start : quote.end]
        if quote.quote not in span:
            continue
        content = content[: quote.start] + span.replace(quote.quote, corrected, 1) + content[quote.end :]
    return content


async def patch_quotes(content: str, candidates: Sequence[UnverifiedQuote], patch: QuotePatchFn) -> tuple[str, int]:
    """``(content with the candidates it could correct corrected, how many)``; ``candidates`` from :func:`select`."""
    if not candidates:
        return content, 0

    async def one(quote: UnverifiedQuote) -> str | None:
        passage = quote.nearest.chunk_text or ""  # type: ignore[union-attr]  # select() checked it
        try:
            corrected = await asyncio.wait_for(patch(quote.quote, passage), PATCH_TIMEOUT_S)
        except TimeoutError:
            logger.warning("Piloti: quote patch timed out after %.0fs", PATCH_TIMEOUT_S)
            return None
        except Exception as exc:  # noqa: BLE001 - the marked quote is the floor
            logger.warning("Piloti: quote patch failed: %s", str(exc).split("\n")[0])
            return None
        return accept(quote.quote, corrected, passage, span=quote.span)

    results = await asyncio.gather(*(one(quote) for quote in candidates))
    patches = [(quote, corrected) for quote, corrected in zip(candidates, results, strict=True) if corrected]
    logger.info("Piloti: quote patch corrected %d of %d quote(s)", len(patches), len(candidates))
    return splice(content, patches), len(patches)


def quote_patcher(llm: Any) -> QuotePatchFn:
    """The patch call on ``llm`` (the small card model): no history, no tools."""

    async def patch(quote: str, passage: str) -> str | None:
        response = await llm.ainvoke(
            [
                SystemMessage(content=_SYSTEM_PROMPT),
                HumanMessage(content=f"PASSAGE:\n{passage[:6000]}\n\nQUOTATION AS WRITTEN:\n{quote}"),
            ]
        )
        return content_to_text(getattr(response, "content", response)).strip() or None

    return patch

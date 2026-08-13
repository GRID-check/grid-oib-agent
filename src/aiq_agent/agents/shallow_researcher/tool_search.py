"""Retrieval-based tool narrowing for the shallow researcher.

WHY THIS IS NOT A TOOL
======================
The obvious shape for "tool search" is a ``search_tools`` function the model
calls first. That shape is wrong *here*, and the reason is the budget: this
agent force-synthesizes at ``max_tool_iterations`` (5 in production), and the
Keller failure — five turns spent on model-opening, briefings and a storey
table, cut off before the measurement, answering with a declared value that was
wrong — is a budget failure, not a capability failure. A discovery call costs
one of those five turns, i.e. 20 % of everything the agent will ever do about
the question, *before* it can look at the building. It would deepen exactly the
failure it is sold as fixing.

So the retrieval runs OUTSIDE the tool-call loop. It is a pure, local,
in-process ranking over tool name + description that narrows the bound tool set
around the LLM call. The model never sees it, never calls it, and the graph
gains no node: the turn count with narrowing on is identical to the turn count
with it off.

WHY IT BIASES HARD TOWARD RECALL
================================
A retrieval that hides the one right tool is strictly worse than no retrieval —
it does not cost a turn, it costs the answer, and the agent cannot tell that it
was the narrowing that blinded it. Every ambiguous case therefore resolves to
"return everything":

* no query text, no scoring signal, fewer candidates than ``top_k``,
  a non-positive ``top_k``, or any exception → the FULL tool set;
* ``always_include`` names are pinned in *on top of* the ``top_k`` retrieved
  slots, never counted against them;
* when scores are positive but sparse, the ranking still fills ``top_k`` slots
  from the unmatched tools rather than handing back a smaller set — an extra
  irrelevant schema costs tokens, a missing relevant one costs the turn.

MATCHING
========
Lexical, not embedded: no network call, no model, no new dependency, and no
warm-up. BM25 over folded tokens with mild length normalization (``b`` is low
on purpose — ``ifc_measure``'s description is an order of magnitude longer than
``web_search_tool``'s because it documents twelve operations, and a
length-normalizing scorer would read that density as dilution and rank the
capability-dense tool *below* the generic one).

The corpus is German and English in the same string ("wie hoch ist der Raum
wirklich" sits inside an English paragraph), so tokens are diacritic-folded and
matched with a prefix relation as well as exactly: "Raumhöhe" in the question
reaches "Raumhöhen" in the description, and "Fluchtweg" reaches "Fluchtwege".
Prefix matches score lower than exact ones, and never turn a zero into a
confident hit on their own.
"""

from __future__ import annotations

import logging
import math
import re
import unicodedata
from bisect import bisect_left
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from pydantic import BaseModel
from pydantic import Field

logger = logging.getLogger(__name__)


# Function-group separators used by NAT-qualified tool names, mirroring
# ``data_source_registry._GROUP_SEPARATORS``.
TOOL_NAME_SEPARATORS = ("__", ".")

# BM25 parameters. ``b`` (length normalization) is deliberately far below the
# usual 0.75 — see the module docstring: description length here tracks how many
# operations a tool documents, not how diluted it is.
_BM25_K1 = 1.2
_BM25_B = 0.3

# A query token shorter than this never participates in prefix matching (in
# either direction): three-letter fragments match half the vocabulary and would
# turn the recall bias into "everything scores, nothing is ranked".
_MIN_PREFIX = 5

# Weight of a prefix match relative to an exact one.
_PREFIX_WEIGHT = 0.55

# Tokens shorter than this are dropped entirely.
_MIN_TOKEN = 3

# German + English function words. Not a linguistic stopword list — just the
# words that appear in every OIB question and every tool description alike and
# so carry no ranking signal. IDF would damp them anyway; dropping them keeps
# the prefix scan small.
_STOPWORDS = frozenset(
    {
        # German
        "aber", "alle", "allen", "aller", "alles", "als", "also", "auch", "auf", "aus", "bei", "beim",
        "bin", "bis", "dann", "das", "dass", "dem", "den", "der", "des", "die", "dies", "diese",
        "diesem", "diesen", "dieser", "dieses", "doch", "dort", "durch", "ein", "eine", "einem",
        "einen", "einer", "eines", "fuer", "hat", "hier", "ich", "ihr", "ist", "kann", "man", "mehr",
        "mich", "mir", "mit", "muss", "nach", "nicht", "noch", "nur", "oder", "ohne", "sich", "sie",
        "sind", "soll", "ueber", "und", "vom", "von", "vor", "war", "was", "wenn", "wer", "werden",
        "wie", "wir", "wird", "wo", "zum", "zur",
        # English
        "about", "all", "and", "any", "are", "but", "can", "for", "from", "has", "have", "how",
        "into", "its", "may", "not", "the", "that", "them", "then", "there", "these", "they",
        "this", "was", "were", "what", "when", "where", "which", "who", "will", "with", "would",
        "you", "your",
    }
)  # fmt: skip

_TOKEN_SPLIT = re.compile(r"[^0-9a-z]+")


class ToolSearchSettings(BaseModel):
    """Config for retrieval-based tool narrowing. Off unless asked for.

    Absent from a workflow YAML, this validates to ``enabled=False`` and the
    agent takes the byte-identical unnarrowed path it has always taken.
    """

    enabled: bool = Field(
        default=False,
        description=(
            "Narrow the bound tool set to the tools a local lexical retrieval "
            "ranks against the user's turn. Off by default: on a small tool "
            "set the schemas it saves are not worth the recall it risks."
        ),
    )
    top_k: int = Field(
        default=4,
        description=(
            "How many RETRIEVED tools to bind. `always_include` pins sit on top "
            "of this, not inside it. <= 0 disables narrowing."
        ),
    )
    always_include: list[str] = Field(
        default_factory=list,
        description=(
            "Tool names that are bound on every research turn regardless of "
            "score. Matched on the base name, so a group-qualified variant "
            "(mcp__remember) is pinned by writing `remember`."
        ),
    )


@dataclass(frozen=True)
class ToolSelection:
    """The outcome of one narrowing decision, in tool NAMES only.

    ``narrowed`` is False whenever the full set is returned, whatever the
    reason — the agent uses it to keep the prebuilt full binding instead of
    building an identical narrowed one.
    """

    selected: tuple[str, ...]
    withheld: tuple[str, ...] = ()
    narrowed: bool = False
    reason: str = "full_set"


@dataclass(frozen=True)
class QueryPart:
    """One piece of the retrieval query with its weight.

    The user's current turn is the query; earlier turns are context and are
    worth less. Weight scales that part's contribution to every term it
    contributes, so "und wie hoch ist der" after a turn about the Keller still
    reaches the measurement tool.
    """

    text: str
    weight: float = 1.0


def tool_basename(tool_name: str) -> str:
    """Return the final segment of a (possibly group-qualified) tool name."""
    base = tool_name
    for sep in TOOL_NAME_SEPARATORS:
        if sep in base:
            base = base.rsplit(sep, 1)[-1]
    return base


def _fold(text: str) -> str:
    """Lowercase and strip diacritics so `Raumhöhe` and `Raumhohe` are one term.

    ``ß`` does not decompose under NFKD, so it is folded explicitly — otherwise
    "Grundriss" and "Grundriß" are different terms.
    """
    lowered = text.lower().replace("ß", "ss")
    decomposed = unicodedata.normalize("NFKD", lowered)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _tokenize(text: str) -> list[str]:
    """Fold, split on non-alphanumerics, drop short tokens and function words."""
    return [tok for tok in _TOKEN_SPLIT.split(_fold(text)) if len(tok) >= _MIN_TOKEN and tok not in _STOPWORDS]


def _split_camel_and_symbols(name: str) -> str:
    """Expand a tool/operation identifier into its words.

    ``ifc_measure`` and ``clearHeight`` both have to be reachable from a
    question that spells the words out, so the identifier contributes its parts
    as well as itself.
    """
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return spaced.replace("_", " ").replace("-", " ")


@dataclass
class _Doc:
    """One tool's indexed form."""

    name: str
    term_freq: dict[str, float] = field(default_factory=dict)
    length: float = 0.0


class ToolSearchIndex:
    """A BM25 index over tool name + description, built ONCE per tool set.

    Construction is the only expensive step (a few thousand tokens of tool
    descriptions), and it happens off the hot path — at agent construction, not
    per turn. ``select`` is a handful of dict lookups plus one bisect per query
    token.
    """

    def __init__(self, tools: Sequence[Any]) -> None:
        self._docs: list[_Doc] = []
        doc_freq: Counter[str] = Counter()

        for tool in tools:
            name = str(getattr(tool, "name", "") or "")
            if not name:
                continue
            description = str(getattr(tool, "description", "") or "")
            # The name is indexed three ways — verbatim, split into words, and
            # base-name only — because a question rarely spells a tool the way
            # the registry does, and the name is the single highest-precision
            # field there is.
            name_text = f"{name} {_split_camel_and_symbols(name)} {tool_basename(name)}"
            tokens = _tokenize(name_text) * 3 + _tokenize(description)
            counts = Counter(tokens)
            doc = _Doc(name=name, term_freq={t: float(c) for t, c in counts.items()}, length=float(len(tokens)))
            self._docs.append(doc)
            doc_freq.update(counts.keys())

        self._doc_freq = doc_freq
        self._vocab = sorted(doc_freq)
        total_len = sum(d.length for d in self._docs)
        self._avg_len = (total_len / len(self._docs)) if self._docs else 1.0
        if self._avg_len <= 0:
            self._avg_len = 1.0
        self._n = len(self._docs)

    @property
    def tool_names(self) -> tuple[str, ...]:
        return tuple(d.name for d in self._docs)

    def _idf(self, term: str) -> float:
        df = self._doc_freq.get(term, 0)
        if df <= 0:
            return 0.0
        return math.log(1.0 + (self._n - df + 0.5) / (df + 0.5))

    def _terms_with_prefix(self, prefix: str) -> list[str]:
        """Vocabulary terms starting with ``prefix`` (bisect, not a scan)."""
        start = bisect_left(self._vocab, prefix)
        out: list[str] = []
        for i in range(start, len(self._vocab)):
            term = self._vocab[i]
            if not term.startswith(prefix):
                break
            out.append(term)
        return out

    def _candidate_terms(self, token: str) -> list[tuple[str, float]]:
        """Index terms a query token can match, each with its match weight."""
        candidates: dict[str, float] = {}
        if token in self._doc_freq:
            candidates[token] = 1.0
        if len(token) >= _MIN_PREFIX:
            # Query token is a prefix of an index term: "raumhoh" → "raumhohen".
            for term in self._terms_with_prefix(token):
                if term != token:
                    candidates.setdefault(term, _PREFIX_WEIGHT)
            # Index term is a prefix of the query token: "fluchtwegbreite" in
            # the question reaches "fluchtweg" in the description.
            for cut in range(len(token) - 1, _MIN_PREFIX - 1, -1):
                head = token[:cut]
                if head in self._doc_freq:
                    candidates.setdefault(head, _PREFIX_WEIGHT)
                    break
        return sorted(candidates.items())

    def _score(self, doc: _Doc, weighted_tokens: dict[str, float]) -> float:
        score = 0.0
        norm = _BM25_K1 * (1.0 - _BM25_B + _BM25_B * (doc.length / self._avg_len))
        for token, weight in weighted_tokens.items():
            best = 0.0
            for term, match_weight in self._candidate_terms(token):
                tf = doc.term_freq.get(term)
                if not tf:
                    continue
                contribution = self._idf(term) * (tf * (_BM25_K1 + 1.0)) / (tf + norm)
                best = max(best, contribution * match_weight)
            score += best * weight
        return score

    def select(
        self,
        query_parts: Sequence[QueryPart],
        *,
        top_k: int,
        always_include: Sequence[str] = (),
    ) -> ToolSelection:
        """Rank the indexed tools and return the names to bind.

        Returns the full set (``narrowed=False``) whenever narrowing would be a
        guess rather than a ranking — see the module docstring.
        """
        all_names = self.tool_names
        if not all_names:
            return ToolSelection(selected=(), reason="no_tools")
        if top_k <= 0:
            return ToolSelection(selected=all_names, reason="top_k_disabled")

        pin_names = {str(n).strip() for n in always_include if str(n).strip()}
        pin_bases = {tool_basename(n) for n in pin_names}
        pinned = {doc.name for doc in self._docs if doc.name in pin_names or tool_basename(doc.name) in pin_bases}
        candidates = [doc for doc in self._docs if doc.name not in pinned]
        if len(candidates) <= top_k:
            # Nothing to withhold: every unpinned tool fits in the budget.
            return ToolSelection(selected=all_names, reason="nothing_to_narrow")

        weighted: dict[str, float] = {}
        for part in query_parts:
            for token in _tokenize(part.text):
                weighted[token] = max(weighted.get(token, 0.0), part.weight)
        if not weighted:
            return ToolSelection(selected=all_names, reason="empty_query")

        scored = [(self._score(doc, weighted), idx, doc.name) for idx, doc in enumerate(candidates)]
        if not any(score > 0.0 for score, _, _ in scored):
            # The question said nothing the tool corpus recognizes. Ranking by
            # a table of zeros is picking at random; hand back everything.
            return ToolSelection(selected=all_names, reason="no_signal")

        # Descending score, ties broken by the tool set's own order so the
        # decision is deterministic and a zero-scoring tool that fills the last
        # slot is at least a stable choice.
        scored.sort(key=lambda row: (-row[0], row[1]))
        chosen = {name for _, _, name in scored[:top_k]} | pinned
        selected = tuple(name for name in all_names if name in chosen)
        withheld = tuple(name for name in all_names if name not in chosen)
        if not selected:
            return ToolSelection(selected=all_names, reason="empty_selection")
        return ToolSelection(selected=selected, withheld=withheld, narrowed=bool(withheld), reason="ranked")


def build_query_parts(messages: Sequence[Any], *, context_turns: int = 2) -> list[QueryPart]:
    """Build the retrieval query from the conversation's HUMAN turns.

    The query is the user's current turn at full weight plus up to
    ``context_turns`` earlier human turns at half weight. Two consequences are
    deliberate:

    * Assistant and tool messages are excluded. They are the loop's own output;
      feeding them back would let the first tool the model happened to pick
      re-rank the set in its own favour on iteration two.
    * Because only human turns count, the query string is IDENTICAL on every
      iteration of one run (the loop appends AI and Tool messages only). The
      selection is therefore computed once per run and served from cache for
      the rest of it — no drift, and the cached system prompt cannot go stale
      against a tool list that changed underneath it.
    """
    from langchain_core.messages import HumanMessage

    from aiq_agent.common import content_to_text

    wanted = max(0, context_turns) + 1
    human_texts: list[str] = []
    for msg in reversed(list(messages)):
        if not isinstance(msg, HumanMessage):
            continue
        text = content_to_text(getattr(msg, "content", "") or "")
        if text and text.strip():
            human_texts.append(text)
        if len(human_texts) >= wanted:
            break

    if not human_texts:
        return []
    parts = [QueryPart(text=human_texts[0], weight=1.0)]
    parts.extend(QueryPart(text=text, weight=0.5) for text in human_texts[1 : context_turns + 1])
    return parts

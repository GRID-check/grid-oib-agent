"""The backend's own account of a run's retrieval rounds.

Join the rounds a run ANNOUNCED with the lane hits its tools captured, and the
result is what the Herleitung reads instead of reconstructing the run from step
names: per round what it was asked (query, tools), what it returned (docs with
title/detail/shelf), and what was NEW.

The rule worth knowing before changing anything here is what counts as a
REPEAT: the same passage fetched twice, or a file an earlier round already
OPENED. A search that merely RANKED a document is not work anybody has done
yet, so re-reaching it is not a re-fetch. Both agents produce this shape and
one reader renders it, so the derivation lives here rather than beside either
of them.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from aiq_agent.common.turn_status import LOCATOR_TOOL_BASENAMES
from aiq_agent.common.turn_status import tool_fetches_evidence


def _lane_doc_key(name: str) -> str:
    """Presentation compare for "same document": case- and space-insensitive.

    This is NOT identity (the registry owns that): it answers only whether a
    later round's hit is already on the reader's screen, so the spine does not
    draw the same file twice. The limit is deliberate and worth knowing: it
    compares NAMES, so the same law reached once as an RIS URL and once as a
    knowledge-base filename is two names and stays two docs.
    """
    return (name or "").strip().casefold()


def _hits_by_round(lane_hits: Sequence[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    """Captured hits bucketed by their round stamp, in capture order.

    Unstamped hits (emitted outside a round scope: tests, direct calls) follow
    the most recent stamp — the same fallback the frontend's stream order
    applies, so both readings agree. Hits with no round to follow are left out.
    """
    buckets: dict[int, list[dict[str, Any]]] = {}
    current: int | None = None
    for hit in lane_hits:
        if not isinstance(hit, dict):
            continue
        round_index = hit.get("round")
        if isinstance(round_index, int):
            current = round_index
        elif current is None:
            continue
        else:
            round_index = current
        buckets.setdefault(round_index, []).append(hit)
    return buckets


def _docs_for_round(hits: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The distinct docs one round's hits amount to, in capture order.

    Dedup key is (name, detail): the same file at two pages is two entries a
    reader can tell apart; the identical pair twice is one.
    """
    docs: list[dict[str, Any]] = []
    signatures: set[tuple[str, str]] = set()
    for hit in hits:
        name = str(hit.get("name") or "").strip()
        if not name:
            continue
        detail = str(hit.get("detail") or "").strip()
        signature = (_lane_doc_key(name), detail.casefold())
        if signature in signatures:
            continue
        signatures.add(signature)
        doc: dict[str, Any] = {"name": name}
        for field in ("title", "detail", "shelf"):
            value = hit.get(field)
            if isinstance(value, str) and value.strip():
                doc[field] = value.strip()
        docs.append(doc)
    return docs


def _locus_key(doc: dict[str, Any]) -> tuple[str, str]:
    """Which passage of which file — the pair a repeat is measured against.

    A document with no detail has one locus, the whole file, which is what a
    search hit without a page amounts to.
    """
    return (_lane_doc_key(doc["name"]), str(doc.get("detail") or "").strip().casefold())


def _opened_documents(announced: dict[str, Any], hits: Sequence[dict[str, Any]]) -> set[str]:
    """The document keys this round OPENED, as opposed to merely ranked.

    A locator call reads into the file it names; a search call only lists what
    it found. The distinction is the whole repeat rule: ranking a file nobody
    has opened is not work anybody has done yet.

    Read off the RAW hits rather than the round's wire docs, because the answer
    is per hit: each one carries the tool that produced it (``turn_status``
    stamps it from the scope the tool opened), so a round that searched and
    opened in one batch credits only the documents its locator calls returned.
    That mixed round is why the stamp exists — crediting the whole round marked
    every document the search half merely ranked as already opened.

    Hits with no stamp fall back to the coarser question the announcement can
    answer: was EVERY tool that returned anything a locator? Tools that produce
    no hits (``emit_card``, ``remember``) do not count against it, and a tool
    that records hits without entering the scope (RIS, web, the surfacing
    tools) is correctly not a locator. The fallback under-marks a mixed round,
    which is the safe direction: over-marking is the bug.
    """
    stamped = [hit for hit in hits if isinstance(hit.get("tool"), str) and hit["tool"].strip()]
    if stamped:
        opened = {_lane_doc_key(str(hit.get("name") or "")) for hit in stamped if hit["tool"] in LOCATOR_TOOL_BASENAMES}
        return opened - {""}
    fetchers = [str(tool) for tool in (announced.get("tools") or []) if tool_fetches_evidence(str(tool))]
    if not fetchers or any(tool not in LOCATOR_TOOL_BASENAMES for tool in fetchers):
        return set()
    return {_lane_doc_key(str(hit.get("name") or "")) for hit in hits} - {""}


def _with_repeat_marks(
    docs: Sequence[dict[str, Any]],
    seen_loci: set[tuple[str, str]],
    opened_docs: set[str],
) -> list[dict[str, Any]]:
    """The same docs, each stamped with whether the round re-fetched it.

    One locus — one (document, page/Punkt) pair — is a REPEAT when an earlier
    round already returned that exact pair, or when an earlier round OPENED
    that document at all: going back into a file somebody already read into is
    a re-fetch wherever it lands. A search that merely RANKED a document makes
    nothing a repeat, which is the distinction the reader was losing.

    The mark rides on the doc because the reader sees it per passage: a round
    that re-lists p.12 while newly reading p.60 is one card with one marked
    line, and no document-level verdict can say that.
    """
    return [
        {
            **doc,
            "repeat": _lane_doc_key(doc["name"]) in opened_docs or _locus_key(doc) in seen_loci,
        }
        for doc in docs
    ]


def _new_documents(docs: Sequence[dict[str, Any]]) -> list[str]:
    """The documents this round did work on, in first-seen order.

    A document is new when at least one of its loci is not a repeat: a round
    that reached a passage nobody had reached did work, whatever else it
    re-listed alongside it. Reads the marks :func:`_with_repeat_marks` set, so
    the document verdict and the passage verdicts cannot disagree.
    """
    fresh: dict[str, str] = {}
    for doc in docs:
        if doc["repeat"]:
            continue
        fresh.setdefault(_lane_doc_key(doc["name"]), doc["name"])
    return list(fresh.values())


def _round_entry(
    announced: dict[str, Any],
    docs: list[dict[str, Any]],
    seen_loci: set[tuple[str, str]],
    opened_docs: set[str],
) -> dict[str, Any]:
    """One ledger entry: what the round was, what it returned, what was new.

    Reads the two running sets; :func:`build_retrieval_ledger` advances them
    after, so a round is never measured against itself.
    """
    marked = _with_repeat_marks(docs, seen_loci, opened_docs)
    new_docs = _new_documents(marked)
    entry: dict[str, Any] = {
        "index": announced.get("index"),
        "key": announced.get("key"),
        "tools": list(announced.get("tools") or []),
        "corpora": list(announced.get("corpora") or []),
        "docs": marked,
        "new_docs": new_docs,
        "hits": len(marked),
        "documents": len({_lane_doc_key(doc["name"]) for doc in marked}),
    }
    if announced.get("query"):
        entry["query"] = announced["query"]
    if announced.get("reason"):
        entry["reason"] = announced["reason"]
    return entry


def build_retrieval_ledger(
    announcements: Sequence[dict[str, Any]] | None,
    lane_hits: Sequence[dict[str, Any]] | None,
) -> list[dict[str, Any]] | None:
    """Join announced rounds with captured lane hits: the backend's own account.

    Per round: what it was asked (query, tools), what it returned (docs with
    title/detail/shelf and a per-passage ``repeat`` mark — see
    :func:`_with_repeat_marks`), and what was NEW (``new_docs``: the documents
    with at least one passage that was not a repeat).
    ``hits``/``documents`` are tallies over the same docs, so a renderer never
    counts a second time. Returns None when no round was announced — a direct
    reply has no retrieval to account for, and the wire field stays absent
    rather than null.

    Known exclusion: the answer-repair pass retrieves outside the graph's tool
    node, after this capture has closed, and announces no round — its findings
    are absent by design until a repair round exists. Hits with no round to
    belong to are left out; they stay visible through the steps walk and cards.
    """
    rounds = [a for a in (announcements or []) if isinstance(a, dict)]
    if not rounds:
        return None
    hits_by_round = _hits_by_round(lane_hits or [])
    seen_loci: set[tuple[str, str]] = set()
    opened_docs: set[str] = set()
    entries: list[dict[str, Any]] = []
    for announced in rounds:
        # The raw hits carry the producing tool; `_docs_for_round` copies only
        # name/title/detail/shelf, which is what keeps that in-process field
        # off the wire. `_opened_documents` therefore reads the hits, the entry
        # reads the docs.
        hits = hits_by_round.get(announced.get("index"), [])
        docs = _docs_for_round(hits)
        entries.append(_round_entry(announced, docs, seen_loci, opened_docs))
        opened_docs.update(_opened_documents(announced, hits))
        seen_loci.update(_locus_key(doc) for doc in docs)
    return entries

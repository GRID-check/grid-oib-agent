"""Startup probe: what a chat turn does before its first model call, in milliseconds.

Runs questions through the real agent in ONE process (so the second question
onward is a warm process, the way a worker serves turns) and prints a timeline
per turn, relative to the turn's start:

    HTTP  <start>ms +<duration>ms <host><path>       every async provider call
    SYNC  <phase> <start>ms +<duration>ms <query>     the retriever's embed, lexical and retrieve

Read it for the order of the startup steps (decision, query embedding,
retrieval, rerank, sufficiency verdicts, requery, first ``/responses`` call)
and for which ones wait on which. ``docs/architecture/turn-latency-measured-2026-09.md``
is the write-up it produced.

Needs what a local turn needs (OPENROUTER_API_KEY, the ingested corpus, the
document inventory), and every run costs real model calls. Run it from the
checkout you want to measure. From a ``git worktree`` put a directory holding a
``knowledge_layer`` symlink to the worktree's ``sources/knowledge_layer/src``
first on PYTHONPATH, or the probe measures the main checkout's knowledge layer
(``docs/contributing/gotchas.md``).

    PYTHONPATH=src python scripts/turn_census/startup_probe.py "Wie hoch muss ein Geländer sein?" "…"
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import importlib
import sys
import time
from pathlib import Path
from typing import Any

import httpx

CONFIG = Path(__file__).resolve().parent.parent.parent / "configs" / "config_oib_openrouter.yml"

#: The turn's start, set per question; ``None`` outside a turn.
_T0: list[float | None] = [None]


def _ms(start: float) -> tuple[float, float]:
    origin = _T0[0] or start
    return 1000 * (start - origin), 1000 * (time.perf_counter() - start)


def _patch_http() -> None:
    send = httpx.AsyncClient.send

    async def timed_send(self: httpx.AsyncClient, request: httpx.Request, *args: Any, **kwargs: Any) -> Any:
        start = time.perf_counter()
        try:
            return await send(self, request, *args, **kwargs)
        finally:
            if _T0[0] is not None:
                at, took = _ms(start)
                print(f"HTTP {at:7.0f}ms +{took:5.0f}ms {request.url.host}{request.url.path}", file=sys.stderr)

    httpx.AsyncClient.send = timed_send  # type: ignore[method-assign]


def _patch_retriever() -> None:
    retriever = importlib.import_module("knowledge_layer.llamaindex.adapter").LlamaIndexRetriever

    def timed(phase: str, method: Any) -> Any:
        @functools.wraps(method)
        def wrapper(self: Any, *args: Any, **kwargs: Any) -> Any:
            start = time.perf_counter()
            try:
                return method(self, *args, **kwargs)
            finally:
                if _T0[0] is not None:
                    at, took = _ms(start)
                    query = str(args[0] if args else kwargs.get("query", ""))[:40]
                    print(f"SYNC {phase:8s} {at:7.0f}ms +{took:5.0f}ms {query!r}", file=sys.stderr)

        return wrapper

    retriever._retrieve_sync = timed("retrieve", retriever._retrieve_sync)
    retriever._embed_query_cached = timed("embed", retriever._embed_query_cached)
    retriever._hybrid_lexical_boost = timed("lexical", retriever._hybrid_lexical_boost)


async def _run(config: Path, questions: list[str]) -> None:
    from nat.runtime.loader import load_workflow

    async with load_workflow(str(config)) as session_manager:
        for question in questions:
            async with session_manager.session() as session:
                _T0[0] = time.perf_counter()
                print(f"TURN START {question}", file=sys.stderr)
                async with session.run(question) as runner:
                    async for _ in runner.result_stream():
                        pass
                print(f"TURN END {1000 * (time.perf_counter() - _T0[0]):.0f}ms", file=sys.stderr)
                _T0[0] = None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("questions", nargs="+", help="asked in order, in one process")
    parser.add_argument("--config", type=Path, default=CONFIG)
    args = parser.parse_args()
    _patch_http()
    _patch_retriever()
    asyncio.run(_run(args.config, args.questions))


if __name__ == "__main__":
    main()

"""The quote check reads every cited passage: it runs in a worker thread, never on the event loop."""

from __future__ import annotations

import asyncio
import threading

from aiq_agent.agents.piloti import answer_pipeline


def test_the_verification_of_a_finished_answer_runs_off_the_loop(monkeypatch):
    threads: list[threading.Thread] = []
    real = answer_pipeline._verify

    def recording(content, registry):
        threads.append(threading.current_thread())
        return real(content, registry)

    monkeypatch.setattr(answer_pipeline, "_verify", recording)
    registry = answer_pipeline.SourceRegistry()

    async def run() -> threading.Thread:
        await answer_pipeline._verify_with_quote_patch("Text.", registry, None)
        return threading.current_thread()

    loop_thread = asyncio.run(run())
    assert threads and all(thread is not loop_thread for thread in threads)

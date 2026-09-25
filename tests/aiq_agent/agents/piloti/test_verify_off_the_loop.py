"""The quote check reads every cited passage: it runs in a worker thread, never on the event loop."""

from __future__ import annotations

import asyncio
import threading

from aiq_agent.agents.piloti import answer_pipeline


def test_the_verification_of_a_finished_answer_runs_off_the_loop(monkeypatch):
    threads: list[threading.Thread] = []
    real = answer_pipeline._verify

    def recording(content, registry, **kwargs):
        threads.append(threading.current_thread())
        return real(content, registry, **kwargs)

    monkeypatch.setattr(answer_pipeline, "_verify", recording)
    registry = answer_pipeline.SourceRegistry()

    async def run() -> threading.Thread:
        await answer_pipeline._verify_with_quote_patch("Text.", registry, None)
        return threading.current_thread()

    loop_thread = asyncio.run(run())
    assert threads and all(thread is not loop_thread for thread in threads)


def test_only_a_patch_about_to_run_asks_for_the_nearest_passage(monkeypatch):
    # The search over every cited page is read only by the patch's select:
    # the settle, a repair-off turn and the pass after a patch skip it.
    asked: list[bool] = []
    real = answer_pipeline._verify

    def recording(content, registry, *, with_nearest=False):
        asked.append(with_nearest)
        return real(content, registry, with_nearest=with_nearest)

    monkeypatch.setattr(answer_pipeline, "_verify", recording)
    registry = answer_pipeline.SourceRegistry()
    asyncio.run(answer_pipeline._verify_with_quote_patch("Text.", registry, None))
    answer_pipeline.settle_streamed_citations("Text.", "", registry)

    assert asked == [False]

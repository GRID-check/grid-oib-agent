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
    from tests.aiq_agent.agents.piloti.test_settle_streamed import SOURCES
    from tests.aiq_agent.agents.piloti.test_settle_streamed import _registry

    asked: list[bool] = []
    real = answer_pipeline._verify

    def recording(content, registry, *, with_nearest=False):
        asked.append(with_nearest)
        return real(content, registry, with_nearest=with_nearest)

    monkeypatch.setattr(answer_pipeline, "_verify", recording)

    assert answer_pipeline.settle_streamed_citations("Fluchtweg 40 m [1].", SOURCES, _registry()) is not None
    assert asked == [False]  # the settle

    asked.clear()
    asyncio.run(answer_pipeline._verify_with_quote_patch("Fluchtweg 40 m [1].\n\n" + SOURCES, _registry(), None))
    assert asked == [False]  # the repair is off

    async def patch(quotes, registry):  # a patch that lands nothing still forces the second pass
        return {}

    asked.clear()
    misquote = "Es gilt „ein Satz, den keine Quelle enthält“ [1].\n\n" + SOURCES
    asyncio.run(answer_pipeline._verify_with_quote_patch(misquote, _registry(), patch))
    assert asked[0] is True and all(flag is False for flag in asked[1:])

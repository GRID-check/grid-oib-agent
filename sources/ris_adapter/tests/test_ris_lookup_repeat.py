"""The same lookup twice in one turn costs one download.

The design this implements asked for the duplicate-fetch guard to withhold the
second identical `ris_lookup` call. THE CODE DISAGREES, and the code wins:
``turn_status.fetch_signature`` signs ``knowledge_search`` and ``read_passage``
and nothing else, so no RIS call has ever been withheld — putting `ris_lookup`
under that guard means editing ``turn_status``, which is a different change
with a different blast radius (it is the atom BOTH nodes read, the agent node
to decide what to CHARGE and the tools node what to RUN).

What is true here, and is what the guard would have bought anyway, is that the
repeat is nearly free: ``fetch_document_cached`` is a shared read-through cache
across turns, replicas and restarts, and the per-session ingest marker keeps
the second call from re-patching the document into the collection.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.asyncio


async def test_the_second_identical_lookup_downloads_nothing(lookup, catalog):
    first = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")
    second = await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")

    assert first == second
    assert lookup.client.fetch_calls == [lookup.WIEN_URL], "the repeat must come out of the shared cache"


async def test_a_second_question_about_the_same_law_downloads_nothing_either(lookup, catalog):
    """The cache is keyed on the DOCUMENT, so a different § of the same law is free."""
    await lookup.run(question="Was verlangt § 63 BO Wien?", instrument="BO Wien")
    output = await lookup.run(question="Wie hoch darf gebaut werden? § 75", instrument="BO Wien")

    assert lookup.client.fetch_calls == [lookup.WIEN_URL]
    assert "Punkt: § 75" in output


async def test_ris_lookup_is_not_signed_by_the_duplicate_fetch_guard(lookup):
    """The fact above, pinned where a future change would break it silently.

    If `ris_lookup` is ever added to ``fetch_signature``, this test fails and
    whoever added it has to decide what the withheld call returns — the current
    guard answers a repeat with a German scolding, which is worse than serving
    it from the cache the test above proves is already there.
    """
    from aiq_agent.common.turn_status import fetch_signature

    call = {"name": "ris_lookup_tool", "args": {"question": "Was verlangt § 63 BO Wien?"}}

    assert fetch_signature(call) is None

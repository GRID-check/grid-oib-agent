"""``ris_lookup`` — ONE RIS tool that hands back citable passages.

The three tools it replaces on the chat surface (``ris_search``,
``ris_fetch_document``, ``ris_catalog_lookup``) are a sequence the model had to
run by hand: search, pick a document number, fetch the ENTIRE document, then
find the paragraph inside 40 000 characters. Three charged calls, and the blob
at the end carried no ``Citation:`` key and no ``Punkt:``, so
``_parse_knowledge_layer`` never saw it and the answer cited a URL instead of a
paragraph.

This package takes the QUESTION and returns passages in the knowledge layer's
own grounding grammar, so everything downstream — the citation parser, the
lanes, the Herleitung, ``verify_citations`` — treats RIS the way it treats the
corpus. The sequence lives inside, one module per stage, each with the bound it
enforces stated at the top of it:

    address.py    §/Art/Abs, the named law, the Bundesland and where it came
                  from. Pure, deterministic, no I/O and no LLM.
    candidates.py which documents to consider — the norm registry first, a
                  planned live RIS search second (cap 3).
    fetch.py      downloading them, in parallel, through the shared cache (cap 2).
    grammar.py    the consolidated-text paragraph grammar: §§, Absätze, headings,
                  and the Absatz-boundary cut.
    picker.py     the one LLM call, over § HEADINGS only, when no § was named.
    extract.py    which §§ answer the question — deterministic, else the picker
                  (cap 6 across 2 documents).
    passages.py   a selected § as the thing a reader cites: Kurztitel, Punkt,
                  Citation key, score.
    render.py     the grounding block those passages become.
    miss.py       what the tool says when it found nothing. Never empty.
    ingest.py     the full text into the session collection, so `read_passage`
                  can reopen the rest of the law.
    telemetry.py  the per-round ledger and the `retrieve.ris_lookup` span.
    tool.py       the config, the description, and the orchestration.

The three old tools stay registered and stay bound to DEEP RESEARCH, which has
a different budget shape; they are simply no longer the chat surface's way in.

This package has its own ``nat.plugins`` entry point rather than riding in on
``ris_adapter.register``: it hard-imports the knowledge layer for the passage
bound and the lane fan-out, and a deployment that lacks the knowledge layer
must lose THIS tool only, not ``ris_search`` and ``ris_fetch_document`` with it.
"""

from ris_adapter.lookup.tool import RisLookupToolConfig
from ris_adapter.lookup.tool import ris_lookup

__all__ = ["RisLookupToolConfig", "ris_lookup"]

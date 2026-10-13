"""Which extraction logic read a file: the version a job is stamped with.

A file that failed ``deterministic`` (empty, encrypted, unparseable, too many
unreadable pages; ``aiq_agent.knowledge.ingest_failures``) fails the same way
every time the same reader reads the same bytes, so the BFF stops offering to
read it again (``frontends/ui/src/lib/documents/retry-policy.ts``). Two things
lift that: new bytes, or a reader newer than the one that failed. This constant
is how the BFF can tell the second.

THE BUMP RULE. Raise it in the change that alters what a file READS AS: a new
or fixed extractor or parser (PDF text, tables, OCR routing, office, images),
a changed unreadable-page threshold, a new fallback that rescues files that
used to fail. Do not raise it for a change to chunking, summaries, tags,
embeddings or retrieval: those never turn a failure into a success, and a bump
re-offers every deterministic failure in every office for nothing.

Format: ``YYYY.MM.N`` (the release month, then a counter within it), compared
as numbers, part by part. ``CURRENT_INGEST_READER_VERSION`` in
``retry-policy.ts`` mirrors it: the BFF compares a row's stored version against
it without asking the backend. ``test_ingest_failure_prefix_parity.py`` fails
when the two disagree, so raise both in one commit.
"""

INGEST_READER_VERSION = "2026.10.1"

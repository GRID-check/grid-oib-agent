# Quote-verification calibration harness

Calibrates the three `TUNABLE` constants in
`src/aiq_agent/common/citation_verification.py`:

| constant | current | what it controls |
| --- | --- | --- |
| `QUOTE_MATCH_THRESHOLD` | `0.90` | fraction of a quoted span that must be found in a retrieved passage |
| `MIN_QUOTE_LEN` | `20` | shortest normalized span that is checked at all |
| `_QUOTE_MAX_ELIDED_GAP` | `6` | characters of passage text a verified quote may silently skip |

When a span fails, the answer gets `[nicht wörtlich in der Quelle belegt]`
appended to the sentence and its surfaced confidence is capped to `low`. The
expensive error is therefore the **false positive** — a genuine verbatim quote
publicly accused of fabrication.

Findings are written up in `docs/architecture/quote-verification-calibration-2026-07.md`
once a full run has been interpreted. Until that file exists, this harness ships
as a tool without a verdict — run it yourself with the commands below.

## Run it

```bash
# full grid — nine gap values (~25-30 min on four cores)
PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration

# coarse gap grid (~10 min) — use this for smoke checks
PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration --quick

# smallest useful run (~2 min)
PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration --quick --max-sentences 4

# force the synthetic fallback corpus (no PDFs needed)
PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration --synthetic

# dump the whole grid for further analysis
PYTHONPATH=src:. .venv/bin/python -m calibration.quote_verification.run_calibration --json /tmp/grid.json
```

`--jobs N` sets the worker-process count (default: CPU count). `--max-sentences 0`
removes the sentence-pool cap entirely — accurate but roughly three times slower.
Runtime is dominated by `difflib` alignment inside `_quote_coverage`, which is
quadratic in quote length; long normative sentences are the expensive ones.

It is **not** part of the default `pytest` run: `tool.pytest.ini_options`
`testpaths` is `["tests", "sources/**/tests"]`, and this directory is under
neither. Nothing here is imported by shipped code. It stays out of CI unless a
workflow invokes the module explicitly.

## What it does

1. **Corpus** (`corpus.py`) — extracts real passages from the OIB Richtlinien
   PDFs in `data/oib` with `pdfplumber`, checking first that the files are real
   PDFs and not Git-LFS pointer stubs. The extracted bodies keep the mechanical
   artifacts a live retrieval carries — above all the hyphenated line wraps
   (`gegeneinan-\nder`) that justified PDF paragraphs always produce. If the
   corpus is missing, a hand-written German building-regulation fallback is used
   and the run prints `corpus provenance : synthetic`.
2. **Cases** (`cases.py`) — builds labelled answer/registry pairs:
   * `verify` — genuine verbatim quotes, plus each mechanical noise class alone
     and in combination (line-wrap hyphens, whitespace, `„…“`/`»…«`/`"…"` mark
     swaps, NFKC-normalizable characters, casing, `> ` blockquote, ellipses,
     `ß`→`ss`, en-dash, soft hyphens, chunk-side OCR damage).
   * `flag` — adjacent-clause splices (parameterised by how many characters are
     elided), lopsided splices, scattered splices, paraphrases anchored on real
     retrieved text, wholesale fabrications, short fabricated fragments
     straddling `MIN_QUOTE_LEN`, and *meaning-inverting micro-elisions* — real
     sentences with `nicht` / `kein` / `nur` deleted, which are short enough to
     hide inside the absolute elision budget.
   * `attribution` — a real sentence from a *different* retrieved document.
     Scored separately: whole-registry matching cannot express this, so it is a
     scope limit, not a threshold to tune.
   * `grey` — single dropped words. Reported, never counted.
3. **Sweep** (`sweep.py`) — calls the real `verify_quoted_spans`. Because
   `threshold` and `min_quote_len` are applied *after* coverage is computed, the
   harness runs the real function once per gap value with `threshold=1.01,
   min_quote_len=0` (which makes it return every span with its coverage) and
   then replays the two post-hoc predicates arithmetically.
   `verify_replay_matches_real` re-runs the real function at the current
   constants and asserts the replay agrees case-for-case; a disagreement exits
   non-zero.

## Re-running it against real transcripts

The false-negative numbers here are the weak half — they depend on how a model
actually fabricates, which only transcripts can tell us. When transcripts exist:

1. Export, per turn, the answer text and the `chunk_text` of every
   knowledge-layer source in the registry.
2. Have a human label each quoted span `verify` or `flag`.
3. Add a loader beside `corpus.load_passages` that yields `Passage` objects from
   the transcript chunks, and a `build_cases` branch (or a separate builder)
   that emits one `Case` per labelled span with `registry=REGISTRY_CLEAN`.
   Nothing else changes — `sweep.py` and `run_calibration.py` are agnostic to
   where cases come from.
4. Re-run. Compare the false-positive numbers against the mechanical ones here:
   if they diverge, the corpus is missing a noise class and `perturbations.py`
   needs it added.

Keep the mechanical corpus in the run either way. It is the regression guard
that says whether a normalization change (a new NFKC step, a different
hyphen-join rule) made honest quotes safer or more fragile, independently of
whatever the transcripts happen to contain.

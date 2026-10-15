# Qdrant migration gates, measured (2026-10-13)

The move to Qdrant waited on the gates in
[`qdrant-retrieval-design.md` §10](qdrant-retrieval-design.md#10-spike-gates-before-anything-is-built);
it was then made in one change, with no flag and no dual period (ADR-0113).
The `AIQ_VECTOR_BACKEND` and `AIQ_CHROMA_*` settings below describe how each
path was measured at the time; none of them exists any more. This page records the first run of the instrument built for them,
`task be:eval:qdrant-parity`, what it found, the two defects it found and fixed
in the Qdrant path, the answer suite run for G1, and what is still not
measured.

**Verdict for the flip:** G1b and G2 pass on this corpus. G6 does not pass at
its own 1-point bound, which keeps `dense` at 3072-d. The one ranked-retrieval
regression this run found (`§` lookups, below) is closed on the merged code by
the `paragraph_refs` channel ([re-run](#re-run-on-the-merged-code)). G1 (the
answer suite) passes: through the real agent, Qdrant held every expectation
the pre-migration baseline held, at the same seconds and reasoning tokens
([G1](#g1-answer-quality-pass)). G3, G4 and G5 are not measured here.

## What was measured, and how

Both paths read **one corpus with one set of vectors**:

- **Corpus.** The 39 OIB 2023 PDFs, downloaded from oib.or.at (both
  "Gesamtfassung" archives), cut by the production Punkt chunker into 2,534
  chunks. 1,330 of them pass production's base filter
  (`chunking != page`, `exclude_file_names`).
- **Vectors.** Every chunk embedded once with `openai/text-embedding-3-large`
  (3,072-d) through `make_embed_model` (OpenRouter, ZDR-pinned), as
  `MetadataMode.EMBED` text with ingestion's excluded keys. That was 2,534
  chunks plus 105 queries, about 0.93 M tokens (~$0.12). The vectors are cached
  under `frontends/benchmarks/oib_retrieval/.cache/qdrant_parity/`, so later
  runs embed nothing.
- **Chroma path.** The vectors went into embedded `chromadb` 1.5.9 through
  LlamaIndex's `ChromaVectorStore`. The chunk text was mirrored into
  `ChunkTextStore` on a throwaway PostgreSQL 16 cluster, which is the
  production German channel (`to_tsvector('german')`, `ts_rank_cd`). Reads go
  through `LlamaIndexRetriever._retrieve_sync` with
  `AIQ_VECTOR_BACKEND=chroma`: dense, the `$contains` passes, the Postgres
  mirror, then RRF in Python.
- **Qdrant path.** The same Chroma collection was copied by
  `qdrant/backfill.py` into the production collection shape (`schema.py`:
  dense plus server BM25 with `BM25_OPTIONS`, TurboQuant 4-bit, strict mode)
  on Qdrant 1.19.2. Reads go through the same `_retrieve_sync` with
  `AIQ_VECTOR_BACKEND=qdrant`, which makes one `hybrid_search` Query API call.
- **Labels.** The labels are the harness's own. The Punkt golden set has 46
  answerable questions, German and English, graded by `(file, page)`. The
  overview golden set has 30 questions in three cohorts, labelled by file. New
  in this change: 23 lexical hard cases
  (`fixtures/qdrant_lexical_hard_cases.json`), each a query plus a regex oracle
  over the chunk text. They cover `§` references, dotted Punkt numbers,
  ALLCAPS codes, compounds, and ß and umlaut spellings.
- **Depth.** Each path's retrieval was asked for 60 chunks
  (`rerank_candidates`, the pool the cross-encoder sees) with the production
  base filter.
- **Machine.** Intel Xeon @ 2.30 GHz, 4 CPUs, Python 3.14. Qdrant was a single
  local node in Docker over REST on localhost, Chroma embedded in-process, and
  Postgres local over TCP. Nothing crossed a network.

Raw results: `results.json` and `report.md` under `--out` (default
`frontends/benchmarks/oib_retrieval/results/qdrant_parity/`, gitignored).

## Results (final run, both fixes applied)

### G1b lexical: pass

German golden questions, units, base filter, lexical channel alone:

| channel | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR |
|---|---|---|---|---|---|
| Postgres `german` FTS (production mirror) | 0.521 | 0.646 | 0.854 | 0.461 | 0.414 |
| SQLite fallback analyzer | 0.896 | 1.000 | 1.000 | 0.673 | 0.565 |
| **Qdrant BM25** (`language: german`, `ascii_folding`) | 0.979 | 0.979 | 0.979 | 0.842 | 0.802 |

The 21 gating hard cases (`compound_only` excluded), chunk oracle:

| channel | mean P@10 | mean R-precision | mean MRR |
|---|---|---|---|
| Postgres | 0.619 | 0.539 | 0.714 |
| Qdrant BM25 | 0.643 | 0.566 | 0.683 |

Per kind:

- **ALLCAPS codes.** Qdrant ≥ Postgres everywhere. `EI2 30-C` R-precision is
  0.96 against 0.52, and `A2-s1,d0` is 0.75 against 0.
- **Compounds and ß/umlaut.** Identical on both.
  - `Fussboden`, `Aussenwand`, `Strasse` and `Geschoss` find the ß spellings on
    both.
  - `Gebaeudeklasse` (the digraph spelling) finds nothing on either; it is the
    known gap of both German configs.
  - Neither channel splits closed compounds: `compound_only` recall is 0 on
    both, so a search for „Verfahren“ does not reach „Nachweisverfahren“. This
    is measured, and the gate does not count it.
- **Digit-only queries.** `§ 8`, `5.1.1` and `Punkt 4.2.1` get nothing from
  either lexical channel. Both now apply the same rule: with no selective
  alphabetic term left, the channel stays silent. Unpriced BM25 had served
  `5.1.1` (P@10 1.0); this is the price of the second fix below.

Exact mode passes. For all 33 phrases tried, Chroma `$regex` and Qdrant
`find_text` (scroll plus Python `re` over `browse.phrase_pattern`) return
**identical chunk sets**. Mismatches: 0.

Q3, whether the phrase index alone could serve exact mode: **no**. With the
fixed tokenizer it equals the regex on codes and numbers (`REI 90`,
`EI2 30-C`, `Punkt 4.2.1`, `Gebäudeklasse 5`, `mindestens 2,00 m`). It misses
everything the regex finds inside a word: `Geschoss` 88 of 255,
`barrierefrei` 26 of 165, `Gebaeudeklasse` 0 of 91. It over-matches `§ 8`
(234 against 9), because `§` is no token. So `find_text` keeps the regex over a
scroll, which is what slice 1 built. The Postgres mirror is not needed for
exact mode.

### Hybrid: the full per-collection retrieval (context for G1)

Punkt golden, units, depth 60:

| path | set | recall@10 | recall@16 | recall@60 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| Chroma | all (46) | 0.989 | 1.000 | 1.000 | 0.782 | 0.725 |
| Qdrant | all (46) | 0.978 | 0.989 | 1.000 | 0.848 | 0.810 |
| Chroma | de (24) | 1.000 | 1.000 | 1.000 | 0.801 | 0.751 |
| Qdrant | de (24) | 0.979 | 0.979 | 1.000 | 0.888 | 0.856 |
| Chroma | en (22) | 0.977 | 1.000 | 1.000 | 0.761 | 0.697 |
| Qdrant | en (22) | 0.977 | 1.000 | 1.000 | 0.804 | 0.760 |

Overview golden, files:

| path | cohort | recall@16 | recall in the 60-chunk pool | MRR |
|---|---|---|---|---|
| Chroma | overview | 0.950 | 0.983 | 0.632 |
| Qdrant | overview | 0.850 | 0.983 | 0.692 |
| Chroma | exact-id | 0.900 | 0.900 | 0.528 |
| Qdrant | exact-id | 0.800 | 0.800 | 0.487 |
| Chroma | paraphrase | 1.000 | 1.000 | 0.750 |
| Qdrant | paraphrase | 1.000 | 1.000 | 0.900 |

Hard cases through the full retrieval, mean R-precision: Chroma 0.543,
Qdrant 0.554.

How to read these tables:

- **The pool is what the reranker sees.** Both paths put every labelled unit
  of the Punkt golden set into the 60-chunk pool (recall@60 1.000), and the
  same overview files (0.983).
- **Qdrant ranks higher.** MRR and nDCG@10 are higher on every golden subset.
- **Overview recall@16.** The 0.85 against 0.95 is ordering inside the pool,
  not a miss. It comes from two questions: `ov-rl1` has three expected files
  and two of them sit past file rank 16; `ov-rl6` has one of three past it.
- **Exact-id has one real pool miss.** `ex-filename-rl5` (the bare file name
  `oib-rl_5_ausgabe_mai_2023.pdf`) is at file rank 12 on Chroma and outside
  Qdrant's 60-chunk pool. Neither lexical channel fires on that query, so it
  is the dense ranking alone. The likely cause, not yet measured, is TurboQuant
  4-bit with default oversampling: in the G6 table, `q3072` loses top-rank
  hits that float `f3072` keeps.
- **`§` lookups regressed** (closed since: [re-run](#re-run-on-the-merged-code)). „§ 8“ has P@10 0.50 /
  R-precision 0.44 on Chroma and 0 / 0 on Qdrant. Chroma's `$contains "§ 8"`
  restricts the dense ranking to the literal string. In Qdrant `§` is no token
  under any text-index tokenizer that handles the rest of the corpus well
  (`whitespace` keeps it, but breaks „OIB-Richtlinie“ and „90,“). So the
  phrase channel can only restrict to chunks with a standalone 8. In this
  corpus `§` appears only in front-matter boilerplate, which is why the golden
  sets do not move. Office documents (Bescheide citing „§ 3 Abs. 2“) are where
  it will matter.
- **Hybrid fusion lowers MRR on these questions.** Dense alone has an MRR of
  0.890 (G6 table), Qdrant hybrid 0.810 and Chroma hybrid 0.725. Equal-weight
  RRF demotes the dense channel's top hit for natural-language questions. The
  RRF weights the design reserves (`weights: [1, 1]`) are the knob, and tuning
  them is a separate decision from the flip. Measured since: weighting dense
  costs the hard cases more than it gains
  ([ranking sweep](#ranking-sweep-2026-10-13)).

### G2 latency: pass (this machine only)

The store call per collection, embedding excluded (the query vector is
pre-cached in the retriever's LRU), timed over 5 passes of 76 questions after
one warm-up pass. The Qdrant path's time includes its term-frequency counts
(cached per collection size) and the cosine lookup.

| path | n | p50 | p95 | p99 | mean |
|---|---|---|---|---|---|
| Chroma (embedded, plus Postgres mirror) | 380 | 58.3 ms | 88.9 ms | 120.2 ms | 59.6 ms |
| Qdrant (one node, REST, localhost) | 380 | 19.9 ms | 34.3 ms | 64.7 ms | 22.0 ms |

The p95 of 34 ms is well under the 230 ms bound. This is a single local node
with no network hop, no concurrent load and a 2.5k-point collection. The gate
as written is measured on Langfuse `retrieve.knowledge_search` in a deployed
environment; this number only says the store itself is not the risk.

### G6 dimension: fail at the 1-point bound

Dense channel only, Punkt golden (46 questions):

| variant | recall@1 | recall@3 | recall@5 | recall@16 | nDCG@10 | MRR |
|---|---|---|---|---|---|---|
| exact cosine, 3072 | 0.739 | 0.935 | 0.935 | 1.000 | 0.907 | 0.890 |
| exact cosine, 1024 (truncated + renormalised) | 0.707 | 0.913 | 0.924 | 1.000 | 0.894 | 0.879 |
| Qdrant HNSW, 3072 float | 0.739 | 0.935 | 0.935 | 1.000 | 0.907 | 0.890 |
| Qdrant HNSW, 3072 TurboQuant 4-bit | 0.717 | 0.935 | 0.935 | 1.000 | 0.898 | 0.879 |
| Qdrant HNSW, 1024 float | 0.707 | 0.913 | 0.924 | 1.000 | 0.894 | 0.879 |
| Qdrant HNSW, 1024 TurboQuant 4-bit | 0.707 | 0.913 | 0.924 | 1.000 | 0.890 | 0.872 |

Recall@16 saturates at 1.000 for every variant, so it cannot see a drop. The
harness therefore judges G6 at recall@1, @5 and @16:

- **1024 against 3072, exact.** −3.3 points at recall@1 and −1.1 at recall@5.
- **The same, both under TurboQuant.** −1.1 at both.

**Read the size of that honestly.** With 46 questions, one question's top hit
is worth about 2 points of recall@1. The measured drop is one or two
questions, and this set cannot resolve a 1-point bound either way. The gate as
written does not pass, so `dense` stays 3072-d. Re-measuring needs a larger
labelled set. TurboQuant 4-bit on 3072 costs one top-1 question against float
(0.717 against 0.739). Its oversampling and rescoring are worth measuring
before calling quantization free.

Run to run, Qdrant's HNSW and TurboQuant numbers moved by one question at
recall@1 between index builds (0.707 to 0.728 for `q3072` across the runs this
change made). The exact-cosine rows do not move.

### G1, G3, G4, G5

| gate | state |
|---|---|
| G1 answer quality | **Pass**, measured by the answer suite through the real agent, below: [G1](#g1-answer-quality-pass). |
| G3 isolation | Covered by the knowledge-layer property test (`test_isolation_property_random_scope_sets` in `sources/knowledge_layer/tests/test_qdrant_store.py`). This harness does not re-run it. |
| G4 operations | Ops drills: snapshot and restore to SeaweedFS, a pod killed mid-ingest, node replacement. Not measured. |
| G5 memory | Pod metrics during a production-size backfill. Not measured. |

## Defects found and fixed in the Qdrant path

1. **The text index dropped every number.** `schema.py` built the `text`
   payload index with the `multilingual` tokenizer, which discards digit
   tokens. The phrase „REI 90“ matched every REI class (66 chunks against 46).
   „5.1.1“ and „§ 8“ matched nothing. „Punkt 4.2.1“ matched every chunk
   containing „Punkt“ (423 against 8).
   - *Effect.* Both the exact-term channel of `hybrid_search` and its
     selectivity pricing worked on the wrong set.
   - *Fix.* The `word` tokenizer (`schema.TEXT_INDEX`), which the review of
     the slice reached independently. `§` is no token under any tokenizer, so
     `§` references go through the `paragraph_refs` keyword field
     (`search.exact_term`). A collection built with the old tokenizer is
     reported at ERROR by `ensure_payload_indexes` and repaired by copying it
     into a new `_vN` and switching the alias (`scripts/qdrant_rebuild.py`),
     not rebuilt in place under running writers.
   - *Pinned by.* `test_phrase_matching_keeps_the_numbers_in_a_term` and
     `test_a_text_index_built_with_another_tokenizer_is_reported_loudly`
     (`test_qdrant_store.py`), and `test_the_phrase_index_keeps_numbers_and_codes`
     (`test_qdrant_parity_harness.py`).
2. **BM25 was sent unpriced.** The Postgres mirror drops query terms that are
   absent from the collection or on more than 25% of it, and stays silent
   without an alphabetic survivor. Qdrant BM25 received the raw question.
   - *Effect.* For identifier-shaped queries („OIB-RL 2“, „§ 3 OIB-RL 6“, a
     file name) BM25 ranked whole Richtlinien on a digit or on „Ausgabe Mai
     2023“, and RRF promoted that over the dense hits: exact-id MRR was 0.281
     against Chroma's 0.528.
   - *Fix.* `_qdrant_lexical_inputs` prices the BM25 terms with the same
     `german_text.select_terms`, on counts from the text index, cached per
     collection size like the Chroma path's `$contains` pricing.
   - *Results.* exact-id MRR 0.281 → 0.487; overview 0.642 → 0.692; golden
     MRR 0.802 → 0.810.
   - *Cost.* Hard-case R-precision 0.564 → 0.554, still above Chroma's 0.543,
     because a bare „5.1.1“ no longer reaches BM25.
   - *Pinned by.* `test_bm25_terms_are_priced_like_the_german_mirror`
     (`test_qdrant_adapter.py`).

Before and after, Qdrant path only. The first column is the schema as slice 1
shipped it:

| measure | before | tokenizer fixed | both fixed | Chroma |
|---|---|---|---|---|
| golden MRR | 0.802 | 0.792 | 0.810 | 0.725 |
| golden nDCG@10 | 0.840 | 0.832 | 0.848 | 0.782 |
| exact-id MRR | 0.281 | 0.298 | 0.487 | 0.528 |
| overview MRR | 0.642 | 0.633 | 0.692 | 0.632 |
| hard cases R-precision (hybrid) | 0.564 | 0.570 | 0.554 | 0.543 |
| phrase index extra matches, „REI 90“ | 20 | 0 | 0 | — |
| p95 store call | 20.7 ms | 27.1 ms | 34.3 ms | 62.5–88.9 ms |

The p95 rose with the pricing's count calls (one per new term; recurring
terms are cached) and with run-to-run machine noise. Chroma's own p95 moved
between 62 and 89 ms across the same runs.

## Open, before the flip

1. ~~Ranked `§` lookups~~: closed. The review's hardening added the keyword
   channel proposed here (`paragraph_refs`, matched by `search.exact_term`),
   and the re-run below measures it.
2. **G6 resolution.** A larger labelled set before 1024-d is reconsidered.
3. ~~TurboQuant oversampling and rescoring~~: measured, rejected. Rescoring
   at oversampling 1 to 3 improves nothing and does not recover
   `ex-filename-rl5`; BM25 fed the pieces of the file name did that
   ([ranking sweep](#ranking-sweep-2026-10-13)).
4. ~~**G1**~~: measured, pass ([G1](#g1-answer-quality-pass)), on the code
   before the ranking change; its Qdrant side is re-run on the merged code.
   **G4** and **G5** remain, as ops drills.
5. ~~Cross-project grouped search sends unpriced BM25 and no exact terms~~:
   closed. `search_grouped` takes its lexical inputs from the same
   `_qdrant_lexical_inputs` as a single-collection search: BM25 terms priced
   by `select_terms` and the selective exact terms („§ 8“, „REI 90“) run as
   their channels, both on document frequencies counted over the union of the
   searched scopes, the corpus its IDF is already computed over. Its RRF ties
   are ordered by cosine before grouping, so a tie no longer decides which
   project leads. Pinned against a real Qdrant with three projects
   (`test_grouped_search_prices_bm25_over_the_searched_scopes`,
   `test_grouped_search_runs_the_exact_term_channels`,
   `test_a_tie_between_projects_puts_the_closer_projects_group_first`). Its
   ranking effect on a real office is not measured: this corpus has one scope.
6. A query that is a file name finds the file only through the dense channel
   (file rank 10 for `ex-filename-rl5`). A dense channel restricted to
   `file_name` equal to the named file would put it first; not built.

## Re-run on the merged code

Same corpus, same cached vectors, after the hardening from review (the `word`
tokenizer, `paragraph_refs` for `§` references, write consistency 1) and the
BM25 pricing were merged (2026-10-13, without G6). Nothing was re-embedded.

| Measure | Chroma path | Qdrant path, first run | Qdrant path, merged |
|---|---|---|---|
| „§ 8“ through full retrieval, P@10 / R-precision | 0.50 / 0.44 | 0.00 / 0.00 | 0.50 / 0.56 |
| Hard cases through full retrieval, mean R-precision | 0.542 | 0.554 | 0.586 |
| Golden, nDCG@10 / MRR | 0.782 / 0.725 | 0.848 / 0.810 | 0.856 / 0.821 |
| Exact mode vs `$regex`, 33 phrases | — | identical | identical |
| G2 store call p95 | 66 ms | 34 ms | 21 ms |

Still open from the cohorts: exact-id recall@16 0.80 on Qdrant against 0.90 on
Chroma (the `ex-filename-rl5` question, item 3), and overview recall@16 0.883
against 0.950. Both closed by the ranking sweep below.

## Ranking sweep (2026-10-13)

Same corpus, same cached vectors. `task be:eval:qdrant-parity -- --no-dimension
--variants all` builds the collection once and then reads it through
`_retrieve_sync` once per variant, each variant swapping
`knowledge_layer.qdrant.search.RANKING` (a `Ranking`: fusion, RRF `k`, the
dense channel's RRF weight, rescoring and oversampling, MMR, the tie-break).
The module is `qdrant_parity/variants.py`; `results.json` keeps every
question's numbers per variant, and `report.md` lists, per variant, which
questions moved against the baseline. The baseline is measured again after
every other variant (`baseline_repeat`), on the same collection, as the noise
floor.

**Adoption rule.** A variant is adopted only if it improves golden nDCG@10 and
MRR and hard-case R-precision through full retrieval, moves no cohort and no
hard case by more than one question, with the per-question moves read, and
keeps G2 p95 well under its bound. 46 golden questions are a small set: one
question's first hit is worth about 2 points of MRR.

### What the gaps actually were: two defects in what BM25 was asked

The cohort gaps were not quantization and not fusion. `dense_only` (BM25 and
the exact-term channels off) put `ex-filename-rl5` at file rank 10 and both
`ov-rl1` and `ov-rl6` at recall@16 1.0, and no rescoring or oversampling
variant brought `ex-filename-rl5` back into the pool. What pushed them out was
the BM25 channel, fed terms that carry no signal:

1. **Umlaut stopwords.** Qdrant's German BM25 folds before it drops stopwords,
   so with `ascii_folding` „über“, „für“, „können“, „während“, „würde“ reach
   the index and the query as `uber`, `fur`, … (measured: BM25 for „was“ or
   „die“ returns nothing, for „über“ 448 chunks). „über“ is on 18% of the
   corpus, under the 25% pricing ceiling, so „was weißt du über die oib 1“
   asked BM25 for `über` alone and ranked every chunk holding it.
2. **File names.** `german_text.query_terms` splits
   `oib-rl_5_ausgabe_mai_2023.pdf` into `ausgabe mai 2023 pdf`, each on about
   10% of the corpus, so pricing kept them and BM25 ranked every Richtlinie's
   front matter over the file the dense channel found.

Fixed in `retrieval.bm25_candidates`, which `_qdrant_lexical_inputs` now uses:
the eight Snowball stopwords spelled with an umlaut or ß are dropped, and a
word with a document extension is taken out of the BM25 text (dense still
reads it). 9 of the 105 harness queries changed their BM25 input, all in the
overview and exact-id cohorts; no golden or hard-case query changed.

| Qdrant path | exact-id r@16 | overview r@16 | golden nDCG@10 / MRR | hard R-prec |
|---|---|---|---|---|
| before (merged code) | 0.800 | 0.850 | 0.847 / 0.810 | 0.586 |
| after | **1.000** | **0.967** | 0.847 / 0.809 | 0.586 |
| Chroma path, for reference | 0.900 | 0.950 | 0.782 / 0.725 | 0.544 |

### The fused ranking was not deterministic

Four identical calls returned a different top-60 order for **86 of 105**
queries, and a different top-16 for 31; the dense channel alone is stable.
Equal-weight RRF ties exactly whenever two passages hold the same ranks in
different channels (dense rank 3 alone against BM25 rank 3 alone), and Qdrant
returns tied points in no fixed order. That is the run-to-run spread every
earlier table carries: over seven measurements of the unchanged baseline,
golden nDCG@10 ranged 0.839 to 0.856, MRR 0.798 to 0.821 and hard-case
R-precision 0.580 to 0.586. It is also why the gate re-run above read 0.856 /
0.821 where the first run read 0.848 / 0.810 on the same code.

`Ranking.cosine_tie_break` orders tied passages by their cosine to the query,
then by chunk id. A tie straddling the cut is fetched whole first (a quarter
more points, `search._tie_slack`) and cut after ordering. Repeated calls then
vary for **0 of 105** queries.

### The sweep (final run)

Golden: Punkt golden set, 46 questions. Hard: the 21 gating hard cases, mean
R-precision; `compound` and `compound_only` are the per-kind means (3 and 2
cases). Cohorts: file recall@16. p95: the store call, 5 timed passes over 76
questions, this machine. Cosine error: the largest gap between a hit's
`Chunk.score` and its true cosine (numpy over the stored vectors), over every
hit of every question.

| variant | nDCG@10 | MRR | r@1 | hard | compound / only | exact-id / overview / paraphrase | p95 ms | verdict |
|---|---|---|---|---|---|---|---|---|
| baseline: RRF k=60 | 0.855 | 0.820 | 0.663 | 0.586 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 23.7 | was production |
| baseline, repeated last | 0.856 | 0.821 | 0.663 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 32.2 | noise floor |
| dense alone | 0.907 | 0.890 | 0.739 | 0.298 | 0.230 / 0.105 | 1.000 / 0.950 / 1.000 | 16.6 | reference |
| rescore | 0.834 | 0.791 | 0.620 | 0.586 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 26.8 | rejected |
| rescore, oversampling 1.5 | 0.841 | 0.802 | 0.641 | 0.581 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 22.9 | rejected |
| rescore, oversampling 2 | 0.842 | 0.802 | 0.641 | 0.580 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 22.6 | rejected |
| rescore, oversampling 3 | 0.841 | 0.802 | 0.641 | 0.581 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 26.4 | rejected |
| RRF k=20 | 0.836 | 0.787 | 0.598 | 0.578 | 0.461 / 0.030 | 1.000 / 0.950 / 1.000 | 26.8 | rejected |
| RRF k=100 | 0.847 | 0.809 | 0.641 | 0.586 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 25.7 | rejected |
| dense weight 1.5 | 0.828 | 0.784 | 0.620 | 0.565 | 0.430 / 0.040 | 1.000 / 0.967 / 1.000 | 28.0 | rejected |
| dense weight 2 | 0.828 | 0.784 | 0.620 | 0.554 | 0.400 / 0.050 | 1.000 / 0.967 / 1.000 | 24.0 | rejected |
| dense weight 3 | 0.799 | 0.747 | 0.554 | 0.539 | 0.368 / 0.060 | 1.000 / 0.967 / 1.000 | 21.6 | rejected |
| DBSF | 0.854 | 0.810 | 0.641 | 0.541 | 0.402 / 0.030 | 1.000 / 0.967 / 1.000 | 27.8 | rejected |
| MMR 0.2 (120 candidates) | 0.848 | 0.810 | 0.641 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 29.8 | rejected |
| MMR 0.4 (120 candidates) | 0.848 | 0.810 | 0.641 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 29.4 | rejected |
| rescore os 2 + dense weight 2 | 0.820 | 0.772 | 0.598 | 0.555 | 0.398 / 0.050 | 1.000 / 0.967 / 1.000 | 31.7 | rejected |
| rescore os 2 + DBSF | 0.855 | 0.812 | 0.641 | 0.541 | 0.402 / 0.020 | 1.000 / 0.942 / 1.000 | 36.6 | rejected |
| rescore os 2 + MMR 0.2 | 0.850 | 0.813 | 0.663 | 0.580 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 32.1 | rejected |
| **cosine tie-break** | **0.856** | **0.821** | 0.663 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 29.9 | **adopted** |
| tie-break + rescore | 0.850 | 0.813 | 0.663 | 0.580 | 0.459 / 0.020 | 1.000 / 0.967 / 1.000 | 32.6 | rejected |
| tie-break + RRF k=100 | 0.856 | 0.821 | 0.663 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 26.7 | rejected |
| tie-break + MMR 0.2 | 0.856 | 0.821 | 0.663 | 0.580 | 0.461 / 0.030 | 1.000 / 0.967 / 1.000 | 29.0 | rejected |
| BM25 decompounded, index and query | 0.845 | 0.808 | 0.630 | 0.573 | 0.296 / 0.066 | 1.000 / 0.942 / 1.000 | 51.5 | rejected |
| the same + tie-break | 0.852 | 0.818 | 0.652 | 0.571 | 0.296 / 0.066 | 1.000 / 0.942 / 1.000 | 29.7 | rejected |
| BM25 decompounded, index only | 0.841 | 0.803 | 0.630 | 0.600 | 0.459 / 0.066 | 1.000 / 0.950 / 1.000 | 30.4 | rejected |
| the same + tie-break | 0.850 | 0.814 | 0.652 | 0.595 | 0.459 / 0.066 | 1.000 / 0.950 / 1.000 | 26.6 | rejected |

The cosine error was 0.000 for every variant.

Why each was decided, from the per-question moves (the three earlier full
runs of the sweep agree unless said otherwise):

- **Cosine tie-break, adopted.** Against the baseline it moves one golden
  question up and one hard case down (`para-8`, one of its 9 relevant chunks
  in or out of the top 9). Its numbers are the top of the baseline's spread
  (0.856 / 0.821 in this run and 0.857 / 0.822 in the previous one, against
  0.839 to 0.856 for the baseline), and its hard-case R-precision is the bottom
  of it (0.580). The golden gain is one question and within that spread; what
  it buys for certain is that the same question gets the same ranking. It has
  no constant to tune. It clears the rule only narrowly, which is why the
  reason for keeping it is the determinism and not the score.
- **Rescoring, at any oversampling: rejected.** No primary measure improves.
  The same golden questions get worse in all four runs (`en-fluchtwegbreite`,
  `en-tragwerk-zuverlaessigkeit`, and one or two others, by a rank each), the
  hard cases lose 2 to 4 (`comp-fluchtwege`, `comp-only-brandabschnitt`), and
  p95 rises by up to 26 ms. It does not recover `ex-filename-rl5` (cause above).
  The quantized order is close enough to exact that the exact one only
  reshuffles near-ties. It is also not needed for exact scores: every hit's
  `Chunk.score` is already the exact cosine, from `search._cosines`, an
  `exact=True` query over the hit ids, which reads the original vectors
  (probed: error 0.0 against numpy at 256 dimensions, where the quantized
  default is 0.008 off). That round trip cannot be dropped for rescoring
  either: a fused query returns the fusion's score, not the dense channel's.
  The 0.012 gap in [gotchas](../contributing/gotchas.md) is a channel's
  `$score` inside a boost formula, not a served score.
- **RRF k=20 and k=100: rejected.** k=100 moved golden questions by net 0,
  +2, −2 and −2 over the four runs: noise around k=60. k=20 is worse
  (golden −4/+2, `ov-cross-rl` out of the top 16). k=60 stays, the paper's
  constant.
- **Dense weight 1.5 to 3: rejected.** Before the BM25 fixes, weight 2 and 3
  were the only settings that recovered the exact-id and overview questions;
  after them, they only cost: golden −6 to −10 questions, hard −7 to −8 cases
  (`§ 8`, the compounds, ß/umlaut spellings). Dense alone ranks natural
  questions best (MRR 0.890), but the exact-term channels are what the hard
  cases need, and Qdrant's weighted RRF scales the rank, not the vote.
- **DBSF: rejected.** Golden +5/−4, but hard cases −7/+4 (mean 0.541 against
  0.586): normalising BM25's scores by their spread lets dense outvote the
  exact-term channels on `§ 8`, `TRVB`, `BROOF`, the compounds.
- **MMR on the dense channel: rejected.** Aimed at file recall in the overview
  cohort, it moved none (0.967 with and without); golden ±1, hard −1. Its
  price is a 120-candidate scan per query. Once the stopword defect was gone,
  the overview cohort had no diversity gap left to close: its one miss
  (`ov-cross-rl`, two of three files) is missed by dense alone as well.

### Compound splitting for BM25 (harness-only experiment)

Neither German analyzer splits closed compounds: „Verfahren“ never reaches
„Nachweisverfahren“. The experiment (`qdrant_parity/decompound.py`) copies the
corpus into a second scope of the same collection whose BM25 vector is built
from the chunk text plus the parts of its compounds, keeps dense, payload and
text index, and prices the parts on the split corpus. Two shapes: parts on
both sides (the question's compounds split too), and the index only (the
question keeps its words whole). A separate sparse vector fused as its own
channel was not built: the index-only shape already shows what the parts do
to the BM25 ranking, and a fourth RRF channel weighs whatever it returns
fully, as the dense-weight rows show.

- **Splitter.** CharSplit (Tuggener 2016), from PyPI as `split-words` 0.1.3:
  MIT, pure Python, no dependencies, its n-gram table (40 MB of JSON) shipped
  in the 13 MB wheel, no download at runtime. Loading it takes about 2 s and
  360 MB of memory. `compound-split` (the other packaged CharSplit) is
  GPL-3.0, and `german-nouns` is CC BY-SA dictionary data; neither fits.
  CharSplit always proposes a split („Verfahren“ → „Verf|ahren“), so a
  proposal is kept only when both parts are words of the corpus (four letters
  or more, a linking „s“ dropped): 2,449 of 2,534 chunks gained parts.
- **Result: rejected, both shapes.** `compound_only` rose from 0.030 to 0.066
  (`comp-only-verfahren` 0 → 0.09; „Prüfverfahren“ is not split, and
  `comp-only-brandabschnitt` did not move). Splitting the question too costs
  the gating compound cases 0.461 → 0.296 („Brandabschnittsfläche“ widens to
  every „Brand“ and „Fläche“: R-precision 0.61 → 0.26). The index-only shape
  keeps them and lifts the ß/umlaut cases (0.460 → 0.512, mostly
  `sz-fussboden`), so gating hard R-precision rises to 0.600, but golden falls
  by 4 to 6 questions (English questions whose glossary terms now match
  compound parts: `en-treppe-steigung-auftritt`, `en-u-wert-aussenwand`,
  `en-tragwerk-zuverlaessigkeit`) and `ov-cross-rl` drops out of the top 16.
  The rule allows one.
- **What production would have needed**, had it won: the parts appended to
  the text the BM25 `Document` is built from at upsert (`QdrantStore._point`,
  so every write path), every collection re-written once (the BM25 vector is
  computed at write), the same split in `retrieval.bm25_candidates` for the
  query side, and the pricing counting parts on a field that holds them (the
  `text` index sees only whole words). With the splitter's 360 MB in every
  process that writes or searches.

Re-running the sweep with these rows: `uv pip install split-words==0.1.3` into
the venv first; without it the decompounding rows are skipped with a warning.

## G1 answer quality: pass

The answer suite (`task be:eval:answer-suite`) through the real agent, on one
commit and one ingested corpus, with the pre-migration Chroma path as the
baseline and the Qdrant path as the change. Measured 2026-10-13 on commit
`7970366f5`. G1 had been listed as needing a deployed stack; the suite runs
in-process, and `--corpus data/oib` (added for this run) lets `--ingest` read
the PDFs from a directory instead of the object store.

### What was run

- **Corpus.** The 39 OIB 2023 PDFs, ingested once by the production pipeline
  under `AIQ_VECTOR_BACKEND=dual` (about ten minutes on 4 CPUs): 2,938 chunks
  in Chroma, mirrored into Qdrant 1.19.2 with the same ids, text and vectors.
  `scripts/backfill_qdrant.py --dry-run --verify` found the id sets equal
  (missing 0, extra 0). Both paths read the same chunks and the same document
  inventory.
- **Questions.** `--all`: the 29 questions of the loop eval's set that have a
  family, two runs each, so 58 turns per pass; the 2 that need a project are
  skipped. The six `suite: core` questions are a subset and are quoted apart.
  Six of the 29 are Bauordnung questions the OIB-only corpus cannot answer;
  they exercise a search that finds nothing, and the live RIS lookup.
- **Passes.** Four, run one after another so neither path competed with the
  other for the provider:

  | Pass | Read path | Chroma reached as |
  |---|---|---|
  | Chroma A | pre-migration baseline | embedded (`AIQ_CHROMA_DIR`), as the suite opens it by default |
  | Chroma B | pre-migration baseline | the Chroma 1.5.9 server, as production runs it (`AIQ_CHROMA_URL`) |
  | Qdrant A | `AIQ_VECTOR_BACKEND=qdrant` | embedded, as the write record only |
  | Qdrant B | `AIQ_VECTOR_BACKEND=qdrant` | the server, as the write record only |

  Chroma B is the baseline the comparisons below use. Chroma A hit a fault of
  the harness (under Defects) and is kept as a second sample of the
  baseline's noise.
- **Models.** The boot defaults in `configs/config_oib_openrouter.yml`, with
  no admin overrides. A turn cost about two US cents and a pass about $1.05;
  the ingest, four passes and one pass abandoned after nine turns came to
  $4.75.
- **Knowledge database.** SQLite, as the suite's own setup uses. On the
  baseline that makes the German lexical channel the SQLite fallback
  analyser, not production's Postgres `german` FTS. G1b above measured the
  SQLite analyser above Postgres on the golden set, so if anything this
  flatters the baseline.

### Results

Every turn of every pass finished; none errored.

| Pass | Checks held | envelope | kind | family cited | mentions | not | shape |
|---|---|---|---|---|---|---|---|
| Chroma A | 170/192 | 54/58 | 42/58 | 46/46 | 17/18 | 8/8 | 3/4 |
| **Chroma B** | **180/192** | 57/58 | 47/58 | 46/46 | 18/18 | 8/8 | 4/4 |
| **Qdrant A** | **180/192** | 57/58 | 47/58 | 46/46 | 18/18 | 8/8 | 4/4 |
| **Qdrant B** | **180/192** | 57/58 | 47/58 | 46/46 | 18/18 | 8/8 | 4/4 |

On the core subset (12 turns a pass): Chroma B 54/56, Chroma A 52/56,
Qdrant A 54/56, Qdrant B 55/56.

| Pass | Wall s, median | Wall s, p90 | First text s, median | Research calls, mean | Tool calls, mean | Reasoning tokens, median | Reasoning tokens, p90 | Largest call, median |
|---|---|---|---|---|---|---|---|---|
| Chroma A | 29.4 | 54.8 | 25.6 | 2.53 | 2.64 | 1,342 | 2,552 | 1,034 |
| **Chroma B** | 30.1 | 65.0 | 26.5 | 2.41 | 2.50 | 1,132 | 2,580 | 1,002 |
| **Qdrant A** | 32.9 | 56.0 | 28.7 | 2.31 | 2.36 | 1,390 | 2,659 | 1,176 |
| **Qdrant B** | 30.8 | 52.6 | 26.1 | 2.31 | 2.17 | 1,114 | 2,316 | 894 |

Read question by question, the seconds do not move. Per question, the median
of the four Qdrant runs minus the median of Chroma B's two:

- **Wall seconds.** Median delta −0.3 s, mean −1.2 s; Qdrant slower on 13 of
  29 questions, range −18 to +8 s. The baseline against itself (Chroma A
  minus Chroma B): median −1.8 s, range −19 to +11 s.
- **Reasoning tokens.** Median delta −22, mean −56; higher on 12 of 29. The
  baseline against itself: +112.

The pass medians spread as widely within one path as between the two: wall
29.4–30.1 s on Chroma and 30.8–32.9 s on Qdrant, reasoning 1,132–1,342 and
1,114–1,390. Qdrant turns made slightly fewer research calls (2.31 a turn
against 2.41–2.53).

Pipeline signals over 116 turns a path (A and B together), Chroma against
Qdrant: unverified quote 6 and 9, salvaged envelope 3 and 4, prose outside
the envelope 1 and 2, summary gated 1 and 0, escalation to deep research 0
and 2.

### Every check that changed, and why

No content expectation (`mentions`, `not`, `shape`, `family_cited`) held on
the baseline and failed on Qdrant. These are the checks that differ between
passes:

| Question | Check | Chroma A | Chroma B | Qdrant A | Qdrant B | Cause |
|---|---|---|---|---|---|---|
| fluchtweg-varianten | `mentions:REI 60`, `shape:tabs\|table`, `envelope` | 1/2 | 2/2 | 2/2 | 2/2 | Model variance. Chroma A's second run wrote bare prose around a `[[card:1]]` reference with no envelope, so the variant tabs and their REI 60 were lost. Its searches had found the table (Tabelle 3, p. 30) |
| was-weisst-du-ueber-oib-2 | `envelope` | 2/2 | 2/2 | 1/2 | 2/2 | Model variance: bare prose with no envelope, holding every value the question expects |
| barrierefrei-wohngebaeude, einreichung-wien-unterlagen, tragwerk-einwirkungen, treppenhaus-gk4-tabelle, was-regelt-oib-4 | `envelope` | | | | | Model variance: one run on one pass without an envelope, on both paths (4 such turns on Chroma and 2 on Qdrant, of 116 each) |
| stellplatz-tirol | `kind` | 1/2 | 2/2 | 0/2 | 1/2 | Model variance on a question the corpus cannot answer. Both paths' first search returned the same OIB passages with the same verdict (`Abdeckung: unzureichend`, top probability 0.07–0.09). The answer came from live RIS lookups, and both Qdrant A runs handed the question to deep research instead; no Qdrant B run did |
| abstand-nachbargrenze-brandwand, tiefgarage-entrauchung, barrierefrei-wohngebaeude, mensa-schule-pflicht, rauchwarnmelder-wohnung, feuerwiderstand-gk5 | `kind` | | | | | Model variance: the turn picked `ruling` or `walkthrough` differently from run to run, on both paths. `abstand-nachbargrenze-brandwand` went 0/2, 2/2, 1/2, 2/2 over the four passes |

### What retrieval changed

The first search of every turn is the question verbatim, so its result list
is the retrieval difference with the model's own choices taken out (the
reranker and the requery judge are model calls, so it is not fully
deterministic). Overlap of the (file, page) sets, runs paired, mean over the
29 questions:

| Pair | Jaccard | Same first hit |
|---|---|---|
| Chroma A, Chroma B | 0.83 | 0.86 |
| Qdrant A, Qdrant B | 0.85 | 0.88 |
| Chroma B, Qdrant A | 0.69 | 0.81 |
| Chroma B, Qdrant B | 0.68 | 0.83 |

Qdrant retrieves differently, by about 15 points of overlap beyond the
run-to-run noise, and the answers do not show it:

- **Mostly the tail.** In `treppenbreite-wohnbau` the first eight of 16
  results agree; ranks 9–16 differ.
- **A more specific first hit.** Where the first hit differs consistently,
  Qdrant's is the more specific passage. `hochhaus-ab-22m` opens with
  OIB-RL 2.3 p. 1 (the Richtlinie for Hochhäuser) in all four Qdrant runs;
  Chroma opens with an Erläuterung to RL 2.2 or with RL 2.3 p. 11.
  `betriebsbau-brandschutz` puts RL 2.1 p. 11 ahead of p. 9.
- **One distractor.** For `mensa-schule-pflicht` („Muss ich in einer Schule
  eine Mensa haben?“) Qdrant puts OIB-RL 5 passages (Schallschutz in schools)
  into the first eight in all four runs, first in one; Chroma does not. The
  question's own expectation is that the answer names neither, and it held in
  every run. It is a ranking difference for the tuning work, not a regression.
- **No empty search on Qdrant** except one a model asked for:
  `doc_class="oib_richtlinie"` with `title_contains="Begriffsbestimmungen"`,
  which matches nothing on either path (that document is `oib_begriffe`).
- **Session shelf.** RIS documents a turn fetched were ingested into its
  session shelf and found by its next Qdrant search, so the mirror covers
  session scopes too.

### Defects

None found in the Qdrant path.

One in the harness, on the baseline only: **embedded Chroma races its own
client creation.** When a turn's parallel round-0 searches open the
retriever's Chroma client at once, `chromadb.PersistentClient` on one path
fails in some of them (`KeyError: '<path>'` in
`SharedSystemClient._create_system_if_not_exists`, then `'RustBindingsAPI'
object has no attribute 'bindings'`), and the knowledge layer skips that
search (`Knowledge layer failed, skipping`). It hit 8 of Chroma A's 58 turns,
and 2 of the first 8 turns of a repeat pass, which was abandoned for it.
Production reaches Chroma over HTTP and never takes this path; with
`AIQ_CHROMA_URL` (Chroma B) it did not occur. It is not fixed, since the
Chroma read path is being removed, and it is why Chroma A is not the
baseline.

### What it means for the flip

G1 passes on this corpus. Through the whole agent, with the reranker, the
requery judge and the answer pipeline downstream of retrieval, the Qdrant path
held every check the pre-migration baseline held (180 of 192 on each of its
two passes, the baseline's 180), at the same seconds and reasoning tokens per
question. Retrieval does differ, measurably, and on this corpus the
difference never reached an answer's checked content.

The limits of that statement:

- One corpus of 39 PDFs in one scope, so cross-project grouped search is not
  exercised (open item 5).
- Content expectations exist for 6 of the 29 questions, 30 checks a pass.
- `kind` and `envelope` are model behaviour that moves 5 to 10 checks between
  passes of the same path.

### Re-running the Qdrant side

The state of this run is kept: Qdrant storage at `/tmp/claude-0/qd/g1`; the
Chroma directory, SQLite database and corpus cache under
`/tmp/claude-0/g1/state`; the results under `/tmp/claude-0/g1/`, with
`chroma-srv/results.json` as the baseline. Qdrant is the only store now, so
the stored points are read as they are, with no flag and no Chroma directory;
start the Qdrant server on that storage:

```bash
QDRANT__STORAGE__STORAGE_PATH=/tmp/claude-0/qd/g1 QDRANT__STORAGE__SNAPSHOTS_PATH=/tmp/claude-0/qd/g1-snap \
  QDRANT__SERVICE__HTTP_PORT=6450 QDRANT__SERVICE__GRPC_PORT=6451 QDRANT__TELEMETRY_DISABLED=true /tmp/claude-0/qd/qdrant
AIQ_QDRANT_URL=http://localhost:6450 \
  AIQ_SUMMARY_DB=sqlite+aiosqlite:////tmp/claude-0/g1/state/summaries.db \
  GRID_BASE_CORPUS_CACHE_DIR=/tmp/claude-0/g1/state/base-corpus \
  task be:eval:answer-suite -- --all --runs 2 --out /tmp/claude-0/g1/qdrant-c \
    --baseline /tmp/claude-0/g1/chroma-srv/results.json
```

To measure ingestion too (it writes Qdrant directly now), ingest afresh, into
an empty Qdrant storage path (`/tmp/claude-0/qd/g1-q`) and an empty state
directory:

```bash
AIQ_QDRANT_URL=http://localhost:6450 \
  AIQ_SUMMARY_DB=sqlite+aiosqlite:////tmp/claude-0/g1/state-q/summaries.db \
  GRID_BASE_CORPUS_CACHE_DIR=/tmp/claude-0/g1/state-q/base-corpus \
  task be:eval:answer-suite -- --ingest --corpus data/oib --all --runs 2 \
    --out /tmp/claude-0/g1/qdrant-after --baseline /tmp/claude-0/g1/chroma-srv/results.json
```

`--baseline` adds the medians' deltas to the report. The per-check diff above
was read by hand from both `results.json` files and the recordings beside
them.

### After the pre-merge review (2026-10-14)

One more pass of the answer suite, after the pre-merge review fixes and
develop's merges since G1. Same Qdrant storage, the same 29 questions, two
runs each, at commit `2c7b50000`.

| Pass | Checks held | envelope | kind | family cited | mentions | not | shape |
|---|---|---|---|---|---|---|---|
| Chroma B (baseline) | 180/192 | 57/58 | 47/58 | 46/46 | 18/18 | 8/8 | 4/4 |
| Qdrant B (G1) | 180/192 | 57/58 | 47/58 | 46/46 | 18/18 | 8/8 | 4/4 |
| **After review** | **174/192** | 56/58 | 42/58 | 46/46 | 18/18 | 8/8 | 4/4 |

- **Content held.** Every `mentions`, `not`, `shape` and `family_cited` check
  held, as on every pass.
- **The drop is the answer's label, from model variance.** Chroma A scored the
  same 42/58 on `kind`. The questions that moved are ones that already split
  between passes, mostly between `ruling` and `walkthrough`, on Chroma as well.
  `tragwerk-einwirkungen` lost its envelope in both runs: both answers name the
  four action groups and cite OIB-RL 1 p. 4. Run 1 wrote prose, and run 2 put
  the envelope's JSON in a code span.
- **Retrieval did not change.**
  - The turn's first search, the question verbatim, has a mean Jaccard of 0.83
    against Qdrant B and the same top hit on 91% of questions.
  - Two passes of one code score 0.85 and 88% (Qdrant A against B), and
    0.83 and 86% (Chroma A against B).
  - On `tragwerk-einwirkungen` the first three hits are identical.
- **Seconds rose with the prompt.** Wall median 35.8 s against 30.8 s, and
  first text 30.6 s against 26.1 s. Median input tokens a turn went from about
  80k to 87k: develop added tools and prompt since G1 (proposals, the review
  canvas, steering). The final call's output rate did not move: 105 tokens/s
  against 108 and 112.

The review's retrieval changes do not touch this path:
- the grouped search's superseded filter is cross-project only;
- the chunk ordinal orders reads of one document;
- the reconciles are maintenance.

## Re-running

```bash
task be:eval:qdrant-parity                       # data/oib, Qdrant, OPENROUTER_API_KEY
task be:eval:qdrant-parity -- --embedder hashed  # keyless wiring check, numbers mean nothing
```

Chroma has since left the stack (ADR-0113), so a re-run measures the Qdrant
path alone, written through ingestion's `write_chunks`. The Chroma path's numbers
above are its fixed reference (`qdrant_parity/baseline.py`, checked against this
page by `tests/benchmarks/test_qdrant_parity.py`), and exact mode is held to a
full regex scan of the corpus, which is what `$regex` was.

The harness touches only uniquely named `parity_*` collections and drops them
afterwards. A cold run takes about 15 minutes on this machine, most of it
Qdrant building HNSW and TurboQuant for 2.5k × 3,072 dimensions twice (the
corpus collection and the G6 collection). Its own tests are
`tests/benchmarks/test_qdrant_parity.py` (offline) and
`sources/knowledge_layer/tests/test_qdrant_parity_harness.py` (against
`AIQ_QDRANT_TEST_URL`, which CI provides).

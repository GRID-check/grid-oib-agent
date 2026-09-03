# OIB Retrieval Evaluation Harness

The gating instrument for the retrieval programme: nothing in retrieval can be tuned before
there is something that says whether a change helped. This is that something.

It exists to be **honest before it is impressive**. Each section below states what it
measures, what it does not, and how far the number may be carried.

## What is measured, and how far each number goes

| # | Measurement | Needs a key? | What it is worth |
|---|-------------|--------------|------------------|
| 1 | **Structural retrievability** — what fraction of the 946 indexed Punkte survive each chunking strategy as a citable unit | no | **Fully real, absolute.** No model of any kind is involved. It is a property of the corpus and the chunker, and it decides whether a citation can ever be precise. |
| 2 | **Lexical-channel recall** — recall@k / nDCG@k / MRR through `aiq_agent.common.german_text` over the real corpus | no | **Real for the shipped analyzer.** German numbers are that channel's recall. English numbers are real too, and near zero: the channel is monolingual *by construction* (see that module's docstring). |
| 3 | **Dense channel** — `--embedder hashed` or `--embedder e5` | no | `hashed`: **wiring only**, see below. `e5`: **real but relative only**, see below. |
| 4 | **Hybrid** — dense fused with lexical through the production `reciprocal_rank_fusion` and `_merge_results` | no | Inherits the dense arm's caveat; the *delta* against dense-alone is the number the fusion work is judged on. |

### The dense arm's two embedders, and why both exist

`--embedder hashed` is a deterministic projection of the German analyzer's lexemes into a
512-dim unit vector. It has **no semantics at all** — it cannot connect "escape route" to
"Fluchtweg" — and its numbers exist to prove the pipeline runs end to end and that the
metric code is exercised. It is the CI path: no download, no key, no network. **A number
from the hashed embedder is never a retrieval-quality result.**

`--embedder e5` runs `intfloat/multilingual-e5-small` (384-dim) locally, with the
`query: ` / `passage: ` prefixes the model requires. This is a **real measurement of that
model**. It is a legitimate instrument for the *relative* comparisons this harness exists
for — page-cut vs Punkt-cut chunking, German vs English, dense vs hybrid — because both
sides of each comparison see the same model, so the difference is a property of the corpus,
the chunking or the query language.

**It is not production's embedder.** Production embeds with `openai/text-embedding-3-large`
through OpenRouter. No number here is a claim about production's absolute recall, and the
runner prints that caveat above every dense line.

One asymmetry the e5 arm introduces and the runner quantifies per arm: e5 accepts 512
tokens, while the page-cut chunks are built for a 1024-token budget, so a large share of
them are truncated before embedding and their tail is invisible to the model. The Punkt-cut
chunks are mostly short enough not to be. **That handicaps the page arm under this model in
a way production's 8191-token embedder would not**, so the e5 chunking A/B overstates the
Punkt arm's margin by an amount the printed truncation share bounds. The structural table
(section 1) carries the same conclusion with no model involved at all, which is why it, not
the dense A/B, is the load-bearing evidence for the chunking change.

### What is NOT measured here, at all

* **Production's retrieval quality.** That needs `OPENROUTER_API_KEY` / `AIQ_EMBED_API_KEY`
  and a populated Chroma collection. Everything here runs against a freshly built in-memory
  index.
* **Chroma's approximate-nearest-neighbour recall.** The dense arm here is exact brute-force
  cosine. Production's HNSW loses a little more; how much is not measured and is not
  claimed to be zero.
* **Reranking.** `rerank_llm` / `reranker_provider` sit downstream of everything measured
  here and need a key.
* **Postgres `ts_rank`.** The lexical arm runs `german_text`'s SQLite-path analyzer
  (`analyze`, i.e. fold + tokenize + the Python stemmer). On Postgres the real Snowball
  stemmer runs and `ts_rank` orders the hits. The lexeme *selection* is identical (the same
  `select_terms` document-frequency ceiling, and `tsquery_for` builds the exact string
  Postgres would be handed); the ranking within the matched set is not.
* **Answer quality.** Retrieval can be perfect and the answer still wrong. The NAT evaluator
  in `evaluator.py` scores the *citations an answer wrote*, which is the other half, and it
  needs a real workflow run.

## The golden set

`fixtures/oib_retrieval_golden.json` — 52 entries covering 25 information needs.

* **Labels are Punkte, not chunks.** Each entry names `(richtlinie, punkt, grade)`; the
  loader expands those into the `(file_name, page)` units retrieval returns, through the
  committed `fixtures/punkt_index.json`. This is why the same golden file scores both
  chunking arms without relabelling.
* **Grades are 3 / 2 / 1**: 3 = this Punkt states the answer; 2 = the answer is wrong or
  incomplete without it; 1 = context an expert would want beside it. nDCG uses the
  exponential gain `2**grade - 1`.
* **Questions come from the repo's own taxonomy**, not invented: `shared/cards/schemas.json`
  card descriptions name a question class *and* its Richtlinie, `src/aiq_agent/cards/catalog.py`
  `CARD_EXAMPLES` carries Punkt-level references, `src/aiq_agent/common/applicability.py`
  supplies the intake vocabulary, and `configs/norms/at/registry.yml` marks what is corpus
  and what is a RIS pointer. Every entry's `provenance` names which.
* **Every German question has an English sibling with IDENTICAL qrels.** The requirement is
  that English perform as well as German; identical expected output means any measured gap
  is a retrieval defect and cannot be argued away as a labelling artefact. The English
  wordings are how a fire engineer would ask, not word-for-word translations. The loader
  refuses to run if a pair's qrels ever diverge.
* **Should-refuse cases** (`relevant: []`) ask things the corpus provably does not contain
  (tax law; Vienna's Bauordnung setback; the Garagengesetz parking count — all RIS pointers
  in `registry.yml`, not corpus). They are scored on `fill_rate`: a value of 1.0 means the
  retriever fills `top_k` regardless, i.e. there is no abstention path and the answer
  generator is handed confident-looking irrelevant context. That is the highest-consequence
  failure mode in a legal product and it is invisible to recall and nDCG, which are 0.0
  either way.
* **Forbidden-hit rule.** `aenderungen_*` are change logs describing what moved between
  editions; their sentences read exactly like requirements, so a hit there is a wrong answer
  wearing a correct-looking citation. `forbidden_rate` is reported on the **unfiltered**
  ranking on purpose — production removes those files with a hardcoded `exclude_file_names`
  list at query time, so with the filter applied the rate is structurally zero and would
  tell nobody whether the list is still complete.
* **German morphology variants** of one need (`Fluchtwegbreite` / `Breite des Fluchtwegs` /
  `nutzbare Breite`) carry identical qrels. `german_text` documents that neither backend
  splits closed compounds; these three wordings turn that documented limitation into a
  measured spread. They are excluded from the language-parity aggregate so a wording effect
  is never reported as a language effect.
* **`calibration_pending: true` on every entry.** The labels were read out of the corpus
  page by page (each entry's `notes` names the page), but the grades have not been reviewed
  by a second Austrian building-law reader. Treat absolute values as provisional; the
  before/after deltas are what this set is for.

### The overview golden set (broad queries)

`fixtures/oib_golden_overview.json` — 30 German entries in three cohorts: `overview`
(10 broad "was weißt du über die oib N" questions with no usable lexical signal —
the vector-only failure class), `exact-id` (10 §-refs, RL designations, filenames),
`paraphrase` (10 everyday wordings of the same intents). Labels are corpus FILES
(real `data/oib` names), scored as recall@16 (production `top_k`) + MRR by
`src/oib_retrieval_eval/overview.py` against a deterministic in-memory fixture
corpus through the production exact + sparse channels (no fill — see that
module's docstring for what is and is not measured). CI runs it as
`tests/benchmarks/test_oib_overview_recall.py`; humans run `task be:eval:overview`.

Baseline (2026-09-03; overview re-recorded after item 13, the casefold
identifier): overview recall 0.583 / MRR 0.389 / empty 0.10 (9/10 queries rank
something — only the bare "oib-richtlinien" question with no number stays
silent), exact-id 0.700 (filenames + the bare short-form §-ref score 0),
paraphrase 1.000. The overview floors in the test are the ratchet retrieval
changes ship against: a fix that lifts overview recall further turns them
red — raise them then.

Item 14 (HyDE-as-channel, experiment, default off) is measured here as
`overview.run(..., hyde_drafter=...)`: for the identifier-free queries the
draft is ranked through the draft's deterministic channels and fused beside
the original via the production RRF. Measured 2026-09-03 with no draft model
in the loop (fail-open): on is byte-identical to off on all three cohorts —
no lift, no regression — so the channel stays off. A lift claim needs
RECORDED drafts from the real draft model (never hand-written passages);
`tests/benchmarks/test_oib_hyde.py` pins the gating, the fail-open identity,
and the fusion order. See that module's docstring for what the on-mode can
and cannot measure (no dense arm offline).

## Layout

| Path | Purpose |
|------|---------|
| `src/oib_retrieval_eval/metrics.py` | PURE. `recall_at_k`, `precision_at_k`, `ndcg_at_k`, `mrr`, `forbidden_rate`, `fill_rate`. No NAT, no chroma, no network, no I/O. |
| `src/oib_retrieval_eval/qrels.py` | PURE. Golden schema, loader, and the Punkt → `(file_name, page)` expansion. Strict: an unresolvable label raises. |
| `src/oib_retrieval_eval/corpus.py` | Extraction (via the production `_extract_text_from_pdf`) and the two chunking arms; reads production's `top_k` / diversity cap / exclusion list from `configs/config_oib_openrouter.yml`. |
| `src/oib_retrieval_eval/structure.py` | The structural before/after. |
| `src/oib_retrieval_eval/lexical.py` | In-memory inverted index built from `aiq_agent.common.german_text`. |
| `src/oib_retrieval_eval/dense.py` | `HashedEmbedder` (CI) and `E5Embedder` (gated), plus exact cosine search. |
| `src/oib_retrieval_eval/citations.py` | PURE. Parses `file.pdf, p.N` out of an answer. |
| `src/oib_retrieval_eval/runner.py` | Drives everything and prints the report. |
| `src/oib_retrieval_eval/evaluator.py` | NAT `EvaluatorInfo` wrapper (citation scoring). |
| `src/oib_retrieval_eval/register.py` | Plugin entry point (see `pyproject.toml`'s `[project.entry-points."nat.plugins"]`). |
| `fixtures/punkt_index.json` | Ground truth: 946 Punkte across 12 Richtlinien. **Committed; never regenerated by this harness** — a ground truth that moves with the thing it measures is not one. |
| `fixtures/oib_retrieval_golden.json` | The 52 golden entries. |
| `.cache/` | Extracted-page cache (gitignored, regeneratable in ~4 minutes). |

Fixtures live in `fixtures/`, not `data/`, because `frontends/benchmarks/*/data/` is
gitignored for large downloaded datasets — same convention as the sibling `oib_compliance`
suite.

## Run

Offline, no key, from the repo root:

```bash
# The chunking A/B alone (~30 s warm, ~4 min cold while the PDF cache builds)
PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src \
  ./.venv/bin/python -m oib_retrieval_eval.runner --structure-only

# Everything, with the CI embedder. Dense/hybrid numbers are WIRING ONLY.
PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src \
  ./.venv/bin/python -m oib_retrieval_eval.runner --embedder hashed

# Everything, with the real local model (downloads ~120 MB once, ~12 min CPU)
pip install -e "frontends/benchmarks/oib_retrieval[dense]"
OIB_RETRIEVAL_MODEL_CACHE=~/.cache/huggingface \
PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src \
  ./.venv/bin/python -m oib_retrieval_eval.runner --embedder e5
```

The structural arm is also the **regression gate** CI runs on every change to the
chunker, the German analyzer, the harness or the corpus (`task be:eval:retrieval`,
the `retrieval-eval` job): `--fail-below 95` fails the build when the Punkt arm's
citable-unit share drops under 95%. The measured baseline on the current corpus is
98.3% (`punkt` arm, 744 of 744 located leaf Punkte), against 5.2% for page cutting.

The offline unit tests live at the repo root and are keyless, model-free and CI-safe:

```bash
PYTHONPATH=src ./.venv/bin/python -m pytest tests/benchmarks/ -q
```

## Install

```bash
pip install -e frontends/benchmarks/oib_retrieval          # CI path
pip install -e "frontends/benchmarks/oib_retrieval[dense]" # adds sentence-transformers
```

Like `oib_compliance`, this suite is deliberately **not** in the root `pyproject.toml`'s
`[tool.uv.workspace] members` list; the tests fall back to a `sys.path` insert so they run
without the editable install.

That was tried and reverted, on measurement. `uv` locks every extra a workspace member
declares, so adding this one pulled `torch`, `transformers` and the NVIDIA CUDA wheels
into `uv.lock` (+400 lines) and **downgraded `tokenizers` 0.23.1 → 0.22.2 for the whole
workspace**, including the deployed backend. An evaluation harness must not move the
application's dependency floor. Install it on demand instead, exactly as `oib_compliance`
is installed.

### The NAT evaluator is registered but not yet driven by a config

`register.py` / `evaluator.py` expose `oib_retrieval_citation_evaluator` through the
`nat.plugins` entry point, and it is unit-covered offline. There is deliberately **no**
`configs/config_oib_retrieval_eval.yml` yet: `nat eval` needs a dataset in its own
`{question, expected_output}` shape plus a workflow to run, and both need
`OPENROUTER_API_KEY`. Writing a config that cannot be executed here would be a file that
looks wired and is not. To wire it:

1. export `fixtures/oib_retrieval_golden.json` to a NAT eval dataset — one row per entry
   with `input` = `question` and `expected_output` = `{"relevant": [...]}` (the evaluator
   reads exactly that key);
2. copy `frontends/benchmarks/oib_compliance/configs/config_oib_compliance_eval.yml`,
   point `eval.general.dataset` at the export and swap the evaluator name for
   `oib_retrieval_citation_evaluator`;
3. run it against `chat_deepresearcher_agent` with a key, exactly as the compliance suite
   documents.

## How to read a regression

* **Structural numbers moving** means the chunker changed. Nothing else can move them.
* **Lexical recall moving with structure unchanged** means `german_text` changed — the
  stemmer, the tokenizer or the document-frequency ceiling.
* **Dense moving with the same embedder flag** means the chunk text changed (breadcrumbs,
  metadata prefixes, furniture stripping).
* **The de/en delta widening** is the language-parity requirement regressing. It cannot be a
  labelling artefact: the siblings' qrels are asserted identical on every run.
* **`fill_rate` on the should-refuse cases at 1.0** is not a regression — it is the standing
  state of the system, and it will stay 1.0 until something is built that can abstain.

# OIB Compliance Golden Eval Suite

Backlog T4-5. A small, hand-authored set of golden OIB-compliance eval cases
run through the real `chat_deepresearcher_agent` workflow (the same one
`configs/config_oib_openrouter.yml` runs in production) so that:

- **latency/cost regressions** (e.g. a return of the 20+ minute runaway-run
  bug fixed in the 2026-07-16 audit) show up as a failed bounds check, and
- **answer-correctness regressions** (e.g. the agent stops citing OIB-RL 2,
  stops naming the specific missing Nachweise, or starts hallucinating a
  document that doesn't exist) show up as a failed checklist item,

per case, in one run.

This is a NAT (NeMo Agent Toolkit) eval harness extension, following the same
pattern as the sibling `freshqa` and `deepsearch_qa` suites in this
directory: a small installable plugin package registers a custom
`nat.plugins.eval` evaluator, wired up via a config YAML passed to `nat eval`.
Unlike those two, this evaluator does **not** call an LLM judge — see
`src/oib_compliance_eval/checklist.py` for why and how.

## Layout

| Path | Purpose |
|------|---------|
| `src/oib_compliance_eval/checklist.py` | Pure scoring logic (checklist grading + bounds check). No NAT/LLM imports — unit-tested offline in `tests/benchmarks/test_oib_compliance_checklist.py` at the repo root. |
| `src/oib_compliance_eval/evaluator.py` | NAT `EvaluatorInfo` wrapper: pulls the response + trajectory out of each `EvalInputItem`, calls `checklist.py`. |
| `src/oib_compliance_eval/register.py` | Plugin entry point (see `pyproject.toml`'s `[project.entry-points."nat.plugins"]`). |
| `fixtures/oib_compliance_golden.json` | The 4 golden cases (query + expected-fact checklist + bounds). Deliberately named `fixtures/`, not `data/` — `frontends/benchmarks/*/data/` is gitignored (large downloaded datasets); these are small, checked-in, hand-authored fixtures. |
| `configs/config_oib_compliance_eval.yml` | The runner entry point — usage documented in its header comment. |

## Install

```bash
# From repo root — this suite is a standalone plugin package, same as
# freshqa/deepsearch_qa. It is intentionally NOT yet added to the root
# pyproject.toml's [tool.uv.workspace] members list (that file is outside
# frontends/benchmarks/); wire it in as a follow-up once calibrated.
pip install -e frontends/benchmarks/oib_compliance
```

## Run

See the header comment in `configs/config_oib_compliance_eval.yml` for the
full command and required environment variables (`OPENROUTER_API_KEY` at
minimum — this suite runs the real OpenRouter-backed OIB workflow, not a
lighter stand-in). Short version:

```bash
dotenv -f deploy/.env run nat eval \
  --config_file frontends/benchmarks/oib_compliance/configs/config_oib_compliance_eval.yml
```

Results (including per-case checklist detail and bounds) go to
`frontends/benchmarks/oib_compliance/results/` (gitignored, regeneratable).

## Calibration status

The 4 cases' checklist facts were authored from general knowledge of the OIB
Richtlinien / NÖ Bauordnung structure, not verified against the ingested
corpus or a live RIS lookup (no live LLM access in the environment these were
authored in). The `bounds` (max wall-clock/LLM-calls/completion-tokens) are
explicitly marked `bounds_calibration_pending: true` in the fixture and are
deliberately generous starting points, not tuned SLAs. Before trusting a
failure as a real regression:

1. Run the suite once against the live stack and read the per-item
   `reasoning.checklist.items[].matched_any` / `missing_all` detail to sanity
   check whether the checklist phrasing is too strict/loose for real model
   output style (adjust `any_of` synonyms, not the underlying legal fact).
2. After 3-5 stable runs, tighten `bounds` in
   `fixtures/oib_compliance_golden.json` to the observed p95 with headroom,
   and flip `bounds_calibration_pending` to `false`.

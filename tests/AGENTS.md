# The backend suite — `tests/`

pytest over `src/aiq_agent`, mirroring its package layout. This is the suite
`task be:test` runs and the one carrying CI's 65% coverage gate.

Read [`../AGENTS.md`](../AGENTS.md) too. This file is only what is true here.

## Commands

```bash
task be:test                       # the whole suite, quiet
task be:test:ci                    # with the coverage gate CI enforces
.venv/bin/pytest tests/aiq_agent/cards -q    # one area, via the venv
```

`PYTHONPATH=src` is mandatory and `Taskfile.yml` sets it. Invoke `pytest`
yourself without it and you test whatever the venv installed — possibly another
worktree — while everything appears to pass. This is the single most expensive
trap in the repo.

## Conventions

| Thing | How it works here |
|---|---|
| Async tests | `asyncio_mode = "auto"`. No `@pytest.mark.asyncio` needed; the loop is session-scoped |
| Imports | `--import-mode=importlib` with `pythonpath = ["."]`, so `from tests.conftest import ...` resolves the same under `pytest`, `python -m pytest` and an IDE runner |
| Shared doubles | `tests/conftest.py` holds the provider-contract double. Extend it rather than re-mocking a provider per file |
| Fixtures on disk | `tests/fixtures/<area>/` — real captured payloads, not hand-written approximations |
| Coverage | 65% floor on `src/aiq_agent`. It is a floor, not a target; a new module arriving untested spends everyone else's headroom |

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Fix a bug | Add the test that fails without your fix | Review. A fix with no test is a fix that comes back |
| Assert on an LLM call | Assert the contract — tools bound, prompt block present, bounds respected — never the prose | The test passes until the model changes its wording, then fails for no reason |
| Test tenant behaviour | Remember this suite does not exercise row-level security; `task db:test:rls` does, and `task verify` does not run it | A tenancy bug that only RLS would catch |
| Add a suite under `sources/` | Know that no CI job runs it — see [`sources/AGENTS.md`](../sources/AGENTS.md) | Nothing. That is the problem |

## Reference

- [`docs/contributing/testing-and-verification.md`](../docs/contributing/testing-and-verification.md)
  — the whole gate, CI's sharding, and the security stack.
- The bar for "done": [`aiq-definition-of-done`](../skills/aiq-definition-of-done/SKILL.md).

# The backend suite: `tests/`

pytest over `src/aiq_agent`, mirroring its package layout. This is the suite
`task be:test` runs and the one carrying CI's 65% coverage gate.

## The trap

`pyproject.toml` puts this checkout's `src/` ahead of the venv's editable install,
so `pytest` tests the code in front of you, whatever the venv was built from. A
worktree without its own venv is the case this guards: before that setting, a
bare `pytest` there tested the main checkout while everything passed.
`knowledge_layer` (under `sources/`) is not covered; see
[`docs/contributing/gotchas.md`](../docs/contributing/gotchas.md).
`.venv/bin/pytest tests/aiq_agent/cards` for one area; `task be:test:ci` carries
CI's 65% coverage gate.

## Conventions

| Thing | How it works here |
|---|---|
| Async tests | `asyncio_mode = "auto"`. No `@pytest.mark.asyncio` needed; the loop is session-scoped |
| Imports | `--import-mode=importlib` with `pythonpath = [".", "src"]`, so `from tests.conftest import ...` resolves the same under `pytest`, `python -m pytest` and an IDE runner |
| Shared doubles | `tests/conftest.py` holds the provider-contract double. Extend it rather than re-mocking a provider per file |
| Fixtures on disk | `tests/fixtures/<area>/`, real captured payloads rather than hand-written approximations |
| Coverage | 65% floor on `src/aiq_agent`. It is a floor, not a target; a new module arriving untested spends everyone else's headroom |

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Fix a bug | Add the test that fails without your fix | Review. A fix with no test is a fix that comes back |
| Assert on an LLM call | Assert the contract, never the prose: tools bound, prompt block present, bounds respected | The test passes until the model changes its wording, then fails for no reason |
| Test tenant behaviour | Remember this suite does not exercise row-level security; `task db:test:rls` does, and `task verify` does not run it | A tenancy bug that only RLS would catch |
| Add a suite under `sources/` | Nothing extra — `task be:test:sources` runs it, in `be:verify` and in CI. Do not add a `tests/__init__.py` to it: a package named `tests` collides with this suite's `tests.conftest` ([`sources/AGENTS.md`](../sources/AGENTS.md)) | The **Backend tests** CI job |

## Reference

- The whole gate, CI's sharding and the security stack:
  [`docs/contributing/testing-and-verification.md`](../docs/contributing/testing-and-verification.md).
- The bar for "done": [`aiq-definition-of-done`](../skills/aiq-definition-of-done/SKILL.md).

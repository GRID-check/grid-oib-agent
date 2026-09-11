# Standalone libraries: `packages/`

Two implementations of the same spatial surface over IFC: `ifc-spatial`
(TypeScript, MPL-2.0, also an MCP server) and `ifc-spatial-py` (a spike on
IfcOpenShell). The agent reaches them through
`aiq_agent/knowledge/ifc_spatial_client.py` (ADR-0045).

## The gate, and why it is not in `task verify`

Both suites run in CI, behind a `packages/**` paths filter: the `packages` job
in [`ci.yml`](../.github/workflows/ci.yml), which `CI OK` requires. It is its
own job because both packages sit outside their neighbouring workspace —
`ifc-spatial` has its own `package-lock.json` (not the UI's bun workspace),
`ifc-spatial-py` its own `uv.lock` (not the root uv workspace) — so neither
tier's install can run them.

```bash
task pkg:install    # both toolchains; `task setup` now does this too
task pkg:test       # both suites
task pkg:test:ts    # ifc-spatial: 194 tests + BOTH tsconfigs, ~10s
task pkg:test:py    # ifc-spatial-py: 636 tests, 3m55s measured 2026-09-10
```

`task verify` does **not** run them, and the Python suite's four minutes is the
whole reason: it is a per-commit tax on a directory most changes never touch,
and CI already pays it on the commits that earn it. Run `task pkg:test`
yourself when you change `packages/` — the same discipline `task db:test:rls`
asks for at the tenant boundary. A change here is unverified until you have
pasted that output.

`--all-extras`, not `--extra dev`: `pytest` is the `dev` extra, and the suite
also collects `test_ids_export.py`, which needs `ifctester` from the `ids`
extra. Plain `uv run pytest` installs neither.

Adding a third package means adding it to `pkg:test` in `Taskfile.yml`; the
paths filter is already `packages/**`, so it needs nothing.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Change an operator | Keep the two implementations' answer contracts identical | The agent gets a different number depending on which engine answered, with nothing to detect it |
| Return a measurement | Carry the provenance: GlobalIds, the operator expression, an absolute tolerance | A measurement without provenance is a number the agent cannot defend, and it is not a citable source |
| Add a geometry dependency | Check the version floor comment in `ifc-spatial-py/pyproject.toml` first | The `shapely>=2.1` floor is there for the *test suite's* GEOS cross-checks, not for the operators. Leave it where it is |
| Edit `ifc-spatial` | Keep the MPL-2.0 headers and `NOTICE` intact | It is separately licensed from the rest of the repo |

## Reference

- ADR-0045, IFC models are a queryable building rather than another document.
- `ifc-spatial-py/COVERAGE.md` and `CORPUS.md` record what the spike actually
  covers, which is less than the operator list suggests.

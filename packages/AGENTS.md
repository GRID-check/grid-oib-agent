# Standalone libraries — `packages/`

Two implementations of the same spatial surface over IFC: `ifc-spatial`
(TypeScript, MPL-2.0, also an MCP server) and `ifc-spatial-py` (a spike on
IfcOpenShell). The agent reaches them through
`aiq_agent/knowledge/ifc_spatial_client.py` (ADR-0045).

Read [`../AGENTS.md`](../AGENTS.md) too. This file is only what is true here.

## The gap you need to know about

**Neither package is in `task verify`, and neither is in CI.** `Taskfile.yml`
names no `packages/` target and `.github/workflows/ci.yml` has no `packages/**`
paths filter, so a change here runs no lint, no typecheck and no tests on any
gate. They are also outside the uv workspace: `ifc-spatial-py` carries its own
`uv.lock`.

Run the suites by hand, every time:

```bash
npm --prefix packages/ifc-spatial install     # not covered by `task setup` either
npm --prefix packages/ifc-spatial run typecheck
npm --prefix packages/ifc-spatial test
(cd packages/ifc-spatial-py && uv run pytest)  # its own lockfile, its own env
```

Treat a change here as unverified until you have pasted that output. If you
extend either package, wiring it into `Taskfile.yml` and the CI paths filter is
the correlated substrate lift, and it belongs in the same branch.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Change an operator | Keep the two implementations' answer contracts identical | The agent gets a different number depending on which engine answered, with nothing to detect it |
| Return a measurement | Carry the provenance: GlobalIds, the operator expression, an absolute tolerance | A measurement without provenance is a number the agent cannot defend, and it is not a citable source |
| Add a geometry dependency | Check the version floor comment in `ifc-spatial-py/pyproject.toml` first | `shapely` 2.1 is required by the *test suite's* cross-checks, not by the operators — do not "simplify" that pin away |
| Edit `ifc-spatial` | Keep the MPL-2.0 headers and `NOTICE` intact | It is separately licensed from the rest of the repo |

## Reference

- ADR-0045 — IFC models are a queryable building, not another document.
- `ifc-spatial-py/COVERAGE.md` and `CORPUS.md` record what the spike actually
  covers, which is less than the operator list suggests.

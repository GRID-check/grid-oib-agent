# Standalone libraries: `packages/`

Two implementations of the same spatial surface over IFC: `ifc-spatial`
(TypeScript, MPL-2.0, also an MCP server) and `ifc-spatial-py` (a spike on
IfcOpenShell). The agent reaches them through
`aiq_agent/knowledge/ifc_spatial_client.py` (ADR-0045).

## No gate covers this directory

`Taskfile.yml` names no `packages/` target and `ci.yml` has no `packages/**`
paths filter, so a change here runs no lint, no typecheck, no tests. Both
packages also sit outside the uv workspace; `ifc-spatial-py` carries its own
`uv.lock`.

```bash
npm --prefix packages/ifc-spatial install      # `task setup` skips this too
npm --prefix packages/ifc-spatial run typecheck
npm --prefix packages/ifc-spatial test
(cd packages/ifc-spatial-py && uv run --all-extras pytest)   # 636 tests, ~5 min
```

`--all-extras`, not `--extra dev`: `pytest` is the `dev` extra, and the suite
also collects `test_ids_export.py`, which needs `ifctester` from the `ids`
extra. Plain `uv run pytest` installs neither.

A change here is unverified until you have pasted that output. Extending either
package makes wiring it into `Taskfile.yml` and the CI paths filter the
correlated substrate lift, in the same branch.

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

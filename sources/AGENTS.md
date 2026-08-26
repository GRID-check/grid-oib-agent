# Data sources: `sources/`

NAT data-source packages: web search, scholarly search, prediction markets, the
RIS legal adapter, and the knowledge layer. Each is its own uv workspace member
with its own `pyproject.toml` and tests, installed into the shared venv.

## No CI job runs these tests

`be:test:ci` covers `tests/`, `be:test:api:ci` covers the aiq_api suite. The one
command that covers `sources/` is the `pytest` pre-commit hook, which is
`stages: [push]`, and CI's repo-lint job SKIPs it. A change here can go green
through every gate with its own suite never executed.

```bash
PYTHONPATH=src pytest sources -q   # nothing sets PYTHONPATH for you here
```

Adding a source? Put its tests where CI already looks, or wire `sources/` into
`Taskfile.yml` in the same change and say so in the PR.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a package | Put it under `sources/`, which `[tool.uv.workspace]` globs, then run `uv sync --group dev` | It is a directory nothing installs |
| Register a function | `@register_function` with a `FunctionBaseConfig` subclass, plus a `nat.plugins` entry point in the **root** `pyproject.toml` | NAT never discovers it |
| Make it toggleable in the UI | Register it in `aiq_agent/common/data_source_registry.py` | The tool works and no user can turn it on |
| Add a third-party API | Read the key from config, never from a module-level `os.environ` at import | The plugin fails to import on a deployment that does not use it, taking unrelated tools with it |
| Return retrieved text | Return passages a citation can resolve to and be verified against | An unverifiable "source" launders an ungrounded claim. See `aiq_agent/common/source_kinds.py` |

## Reference

- [`aiq-add-data-source`](../skills/aiq-add-data-source/SKILL.md) is the
  step-by-step; [`aiq-add-tool`](../skills/aiq-add-tool/SKILL.md) covers a
  non-retrieval tool.
- `uv run` here resolves an environment without the workspace packages. Use the
  venv that `uv sync --group dev` builds, which is what the Taskfile does.

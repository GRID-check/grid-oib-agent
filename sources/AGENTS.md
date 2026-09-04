# Data sources: `sources/`

NAT data-source packages: Tavily web search, the RIS legal adapter, and the
knowledge layer. Each is its own uv workspace member with its own
`pyproject.toml` and tests, installed into the shared venv.

## Running these tests

`task be:test:sources` runs them, and the backend CI job runs the same task, so
a package under `sources/` is covered the day it lands — the glob picks it up
with no list to update.

```bash
task be:test:sources          # what CI runs
PYTHONPATH=src pytest sources/<package>/tests -q   # one package
```

`pytest sources` as a single run does NOT work: every package ships a
`tests/__init__.py`, so pytest derives the module name `tests.conftest` for each
of them and the second one aborts collection with "Plugin already registered
under a different name". That is why the task runs one pytest per package.

This suite went uncovered for a long time — only the `stages: [push]` pre-commit
hook touched it, and CI's repo-lint job skips that. A package here once carried
three tests asserting a function signature the implementation had already
changed, and they stayed green through every gate because nothing ran them.

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

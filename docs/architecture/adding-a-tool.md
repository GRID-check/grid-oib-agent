# Adding a tool or a data source

A tool is a NeMo Agent Toolkit (NAT) function the agent can call. A data source
is a tool, or a group of tools, that also appears as a toggle in the UI because
it is listed in the `data_source_registry`. Everything below applies to both;
the last sections are only for a data source.

Before adding one, read the principles in
[agent-tool-surface.md](agent-tool-surface.md#1-principles). Piloti binds about
twenty tools, and every one is paid for on every call: consolidate what a
person thinks of as one act, and prefer extending an existing tool to adding a
second one beside it.

## Where it lives

| It | Put it in | Entry point in |
|---|---|---|
| Retrieves evidence from a corpus or an external service | a package under `sources/` ([`sources/AGENTS.md`](../../sources/AGENTS.md)) | the package's own `pyproject.toml` |
| Acts on the user's workspace (files, drafts, the model) | `src/aiq_agent/tools/` ([its `AGENTS.md`](../../src/aiq_agent/tools/AGENTS.md)) | the root `pyproject.toml` |

Copy the closest existing package rather than inventing a shape:
`sources/tavily_web_search/` is the minimal one, `sources/ris_adapter/` has a
client, a cache and tests for each layer.

## A package under `sources/`

```text
sources/my_tool/
  pyproject.toml
  README.md
  src/
    __init__.py
    register.py     # the config class and the NAT registration
    client.py       # the implementation, free of NAT imports
  tests/
    conftest.py
    test_client.py
```

No `tests/__init__.py`: with one, pytest names the conftest `tests.conftest`,
the same module as the repo's own suite, and a run over both aborts.

`pyproject.toml` maps the package onto `src/` and declares the entry point NAT
discovers it by. Without the entry point nothing reports a problem; the tool
just never exists.

```toml
[tool.setuptools]
packages = ["my_tool"]
package-dir = {"my_tool" = "src"}

[project]
name = "my-tool"
requires-python = ">=3.14,<3.15"

[project.entry-points."nat.plugins"]
my_tool = "my_tool.register"
```

`[tool.uv.workspace]` globs `sources/*`, so `uv sync --group dev` installs the
new package into the shared venv. Use the venv's interpreter
(`.venv/bin/pytest`), not `uv run`, which resolves an environment without the
workspace packages.

## The registration

`register.py` defines a `FunctionBaseConfig` subclass whose `name=` becomes the
YAML `_type`, and an async `@register_function` that yields a `FunctionInfo`.
`sources/tavily_web_search/src/register.py` is the worked example.

- **The description is the contract.** The function's docstring becomes the
  description the model reads; a docstring `Args:` section never reaches it.
  Say what the tool does, when to call it and what it returns, and put
  parameter guidance in the description or in the schema (a `Literal` for fixed
  values). A rule about how the tool is used goes here too, not in the prompt
  (ADR-0060).
- **Secrets come from config or the environment at registration time**, never
  from a module-level `os.environ` read at import, which fails the plugin's
  import on a deployment that does not use it. When the key is missing, yield a
  stub that returns a clear error string rather than raising.
- **Never raise from the tool.** Return the failure as text the model can act
  on, naming the next call where there is one.
- **Evidence goes through the grounding block.** A tool whose results an answer
  may cite builds `GroundingHit` records and calls `render_grounding_block`
  (`src/aiq_agent/common/grounding_block.py`, ADR-0061). It never writes
  `Source:` or `Citation:` lines itself.
- A new kind of evidence is a `SourceKind`, changed in both
  `src/aiq_agent/common/source_kinds.py` and its TypeScript mirror (the rule in
  [`AGENTS.md`](../../AGENTS.md#two-rules-that-span-services)).

## Binding it to an agent

Add an instance under `functions:` in `configs/config_oib_openrouter.yml`, then
name that instance in the `tools:` list of each agent that should have it:

```yaml
functions:
  my_tool_instance:
    _type: my_tool        # the config class's name=
    max_results: 10

  shallow_research_agent:  # Piloti, the chat agent
    tools:
      - my_tool_instance

  deep_research_agent:
    tools:
      - my_tool_instance
```

Both agents pin an explicit `tools:` list, so a tool missing from it is not
bound, data source or not. Inheriting every registry tool happens only when an
agent's list is empty, and neither shipped agent's is.

## Making it a data source

Add an entry to `data_sources.sources` in the same config. The fields are
`DataSourceEntry` in `src/aiq_agent/common/data_source_registry.py`:

```yaml
functions:
  data_sources:
    _type: data_source_registry
    sources:
      - id: my_source
        name: "My Source"
        description: "What it retrieves."
        default_enabled: true
        tools:
          - my_tool_instance
```

- `GET /v1/data_sources` serves the list and the UI renders the toggles from it;
  no frontend change is needed for a plain source.
- List every tool name a result can arrive under. `get_source_id_for_tool` maps
  a result back to its source, and a result it cannot map is never captured as
  a citable source.
- A conversation that switches the source off does not unbind the tool on
  Piloti: the call is refused with one sentence the model can repeat, so the
  tool payload and its prompt-cache shard stay the same
  (`src/aiq_agent/common/data_sources.py`). Deep research drops the tool
  instead, because its workers have no point at which to refuse.

## Verifying it

```bash
.venv/bin/pytest sources/my_tool/tests -q   # the package
task be:test:sources                        # every sources/ package, as CI runs it
task be:lint
```

Unit-test the client with mocked I/O, and cover both the configured path and
the missing-key stub. Then run the agent on a question that needs the tool. A
new retrieval tool changes what shapes an answer, so the answer suite runs
before and after (the obligation in [`AGENTS.md`](../../AGENTS.md#obligations));
the rest of the bar is the
[definition of done](../contributing/definition-of-done.md).

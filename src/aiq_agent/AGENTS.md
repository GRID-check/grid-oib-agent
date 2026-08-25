# The agent — `src/aiq_agent`

The Python half of Grid: LangGraph agents on the NeMo Agent Toolkit (NAT), the
card surface, the post-answer stages, and the knowledge layer. Stateless per
turn — conversation state lives in Postgres and reaches this process in headers
(ADR-0003, ADR-0013).

Additive to the root [`../../AGENTS.md`](../../AGENTS.md), not a replacement: this file is only what is true here.

## Commands

```bash
task be:lint          # ruff check + format --check, line length 120, py3.11 target
task be:test          # pytest tests/ — the core suite
task be:verify        # what CI runs for this tier, incl. the 65% coverage gate
```

`pytest` directly needs `PYTHONPATH=src`. The Taskfile sets it; you do not get
it for free, and without it you validate whatever the venv installed — possibly
another worktree — while everything appears to pass.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add a tool or agent | `@register_function` with a `FunctionBaseConfig` subclass, then a `nat.plugins` entry point in the root `pyproject.toml` | NAT never discovers it. It simply is not there at runtime |
| Split a tool across optional deps | Give it its own entry point rather than importing from a neighbour's `register` | One missing extra (ifcopenshell, shapely) takes the whole plugin down. `aiq_bim_measure` is the worked example |
| Add a source kind | Change `common/source_kinds.py` **and** mirror it in `frontends/ui/src/features/chat/lib/source-kinds.ts` | The chip renders as unknown. There is no shared schema between them |
| Emit a card | Push it through the `emit_card` tool into the session `CardRegistry`; address it from prose as `[[card:N]]` | The frontend resolves N positionally against the same ordered array. A card added by any other path is unaddressable |
| Add per-turn state | A `ContextVar` registry created/reset per turn, the way `cards/registry.py` and `common/citation_verification.py` do | Module-level state leaks across turns and across tenants |
| Build a prompt block from rows | Bound it, and say in the text the model reads that it is bounded | Cost grows with project size on every turn, and the agent answers "which files do I have" confidently and wrongly. See `render_inventory_block` |
| Change `cards/models.py` | Re-run both generators: `uv run python scripts/generate_card_schema.py`, then `npm run generate:cards` in `frontends/ui` | The `card-schemas` pre-commit hook. Without it the frontend validates the old schema, and it type-checks |
| Change a builtin skill's `SKILL.md` | Re-run the generator: `node frontends/ui/scripts/sync-platform-skills.mjs` | `sync-platform-skills` pre-commit hook. A stale generated module type-checks perfectly, which is why it has broken the build from behind three times |
| Change a prompt or a model name | Remember `configs/*.yml` model names are the **boot fallback only**; the live default is admin-controlled | Editing YAML to move the fleet does nothing. See ADR-0014 |

## Rules that need more than a row

**A measurement is not a source.** The four retrieved kinds (`baurecht`,
`buero`, `projekt`, `web`) are passages a citation resolves to and can be read
back. `messung` is reproducible instead, carries GlobalIds and a tolerance, and
travels its own channel (`agents/bim/measurement_sources.py`). Putting one in
the `SourceRegistry` would let a basement measurement ground an uncited legal
verdict — the exact laundering path `shallow_researcher.grounding` exists to
close. The header of `common/source_kinds.py` is the full argument.

**`doc_class` is human-set and beats every filename guess.** The fine
`norm_registry` lanes are a sub-label within a coarse kind, never a kind of
their own.

**The agent groups are a real boundary.** A model override arrives per group
through the context headers; do not reach for a global. `common/model_overrides.py`
is where that resolution belongs.

## Reference

- Adding a tool: [`aiq-add-tool`](../../skills/aiq-add-tool/SKILL.md).
  Adding a retrieval source: [`aiq-add-data-source`](../../skills/aiq-add-data-source/SKILL.md).
- How the backend fits together:
  [`docs/architecture/backend-deep-dive.md`](../../docs/architecture/backend-deep-dive.md).
- The modules here carry long "why" docstrings. `common/source_kinds.py`,
  `cards/registry.py` and `stages/runner.py` are worth reading before changing
  anything near them; they are the design docs that stayed next to the code.

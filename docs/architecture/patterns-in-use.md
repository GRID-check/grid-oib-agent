# Patterns in use

Structural patterns this codebase actually applies, written down because they
were being learned by reading code. Each entry says where the pattern lives, why
it is there, and **whether anything enforces it**. An unenforced pattern is a
convention, and conventions decay.

A pattern that already has an ADR gets a pointer here, not a second explanation.

## Atomic design (frontend)

Atoms compose into molecules, molecules into organisms, organisms into a route.
An organism reaches for an atom, never for Tailwind; shape is a primitive and
the domain is an atom on top of it.

`features/bim/components/viewer/index.ts` is the clearest instance: a barrel
whose only job is enforcing the import direction, so a control needing a new
shape makes the kit grow rather than the organism.

Layers and rules:
[`../design/grid-design-language.md`](../design/grid-design-language.md#component-layers-atomic-design).
**Enforced by:** review only.

## Guard scripts

A bespoke check for a repo-specific failure that no off-the-shelf linter knows
about. Each one exists because the failure is invisible: the code reads
correctly and the wrong thing happens anyway.

| Script | Catches |
|---|---|
| `frontends/ui/scripts/check-static-utility-modifiers.mjs` | `bg-warning/15` against a static Tailwind v4 `@utility`, which matches no rule and is silently dropped. Reads the utility names out of `globals.css`, so it tracks the design system rather than a hardcoded list |
| `scripts/check_agent_docs.py` | An `AGENTS.md` no agent can reach |
| `scripts/check_adrs.py` | The ADR index disagreeing with the directory |
| `scripts/validate_skills.py` | A malformed skill bundle |

The shape to copy: read the source of truth at check time instead of restating
it, so the guard cannot drift from what it guards.
**Enforced by:** `bun run lint` for the first, `task lint:repo` for the rest.

## Generated artifacts, guarded by `--check`

Several committed files are generated. The failure mode is always the same: a
stale generated module type-checks perfectly, so nothing local objects and only
CI knows. `platform-skills.ts` broke the build from behind three times before
its guard existed.

The guard is the generator itself in `--check` mode: run it, diff the output,
fail on a difference.

| Artifact | Generated from | Guarded |
|---|---|---|
| `frontends/ui/src/lib/skills/platform-skills.ts` | `src/aiq_agent/skills/builtin/*/SKILL.md` | yes, the `sync-platform-skills` pre-commit hook |
| `shared/cards/schemas.json` | `aiq_agent/cards/models.py`, via `scripts/generate_card_schema.py` | yes, the `card-schemas` pre-commit hook |
| `frontends/ui/src/shared/cards/generated.ts` | `shared/cards/schemas.json`, via `frontends/ui/scripts/generate-card-schemas.mjs` | yes, the same hook |

The card schema is a two-stage pipeline from Pydantic models to Zod. Neither
generator has a `--check` flag, so the hook simply runs both: pre-commit fails
the commit when they modify anything, the same way `ruff format` does. That
works because neither stamps a timestamp, so a clean tree stays clean.

Until this hook existed, editing `cards/models.py` without re-running both
generators left the frontend validating the previous schema, and it
type-checked.

## Per-turn state in a `ContextVar`

The agent is stateless per turn but needs turn-scoped collectors: emitted
cards, resolved citations, cost, traces. Each is a registry created and reset per
turn behind a `ContextVar`, never module-level state, because the process serves
many tenants concurrently and module state leaks across both turns and tenants.

`cards/registry.py` and `common/citation_verification.py` are the reference
pair; `common/cost_tracking.py`, `common/profiler.py` and
`agents/bim/measurement_sources.py` follow it.
**Enforced by:** review.

## Idempotent global registration

Registering a converter or an exporter with NAT is a process-global side effect,
and the modules that need it are imported from several entry points. The
convention is a module-level `ensure_registered()` that is safe to call twice,
called explicitly by each entry point rather than run at import time.

`common/nat_converters.py`, `observability/otlp_logging_method.py`,
`observability/otel_header_redaction_exporter.py`.
**Enforced by:** review.

## Plugin discovery by entry point

Agents, tools and data sources are found through `nat.plugins` entry points in
the root `pyproject.toml`, not by importing a registry module. This is what lets
a tool with heavy optional dependencies stay independently loadable:
`aiq_bim_measure` is a second entry point precisely so `ifc_query` keeps working
where ifcopenshell and shapely are not installed.

A function that is registered but has no entry point does not exist at runtime.
**Enforced by:** nothing. It fails as absence, which is why it is worth knowing.

## Declare in code, reconcile against the vendor, gate on drift

The authorization catalog (`lib/authz/catalog.ts`) and the audit-log schemas are
declared in the repository and pushed to WorkOS by a provisioning script. The
script's **default mode is read-only check**; `--apply` is opt-in.

That makes the same script a drift detector, and the `WorkOS drift` workflow
runs it in check mode against staging on a schedule.
[`../deployment/workos-provisioning.md`](../deployment/workos-provisioning.md),
ADR-0038. **Enforced by:** the `workos-drift` workflow and `authz-coverage.spec.ts`.

## Already recorded elsewhere

| Pattern | Where |
|---|---|
| Route → service → repository layering | ADR-0017 |
| Row-level security as the tenancy backstop | ADR-0041, [`../database/row-level-security.md`](../database/row-level-security.md) |
| Layered admission control (edge rate limit, job and turn concurrency, euro budget) | ADR-0040, ADR-0015 |
| DB-claimed workers instead of an assigning scheduler | ADR-0021 |
| Materialised path for folders | ADR-0049 |
| Write-through usage rollups | ADR-0019 |
| Cards as the rich-UI layer, decisions persisted on the message | ADR-0012, ADR-0030 |

## Adding to this page

A pattern belongs here when it appears in more than one place, a newcomer would
otherwise infer it by reading code, and it is not already an ADR. Say what
enforces it. If the honest answer is "nothing", write that. Those are the gaps
worth closing next.

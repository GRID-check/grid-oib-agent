# Grid Agent Contributor Guide

This repo is the Grid-branded AI-Q agent worktree. It contains a Next.js UI, a Python backend using the NeMo Agent Toolkit, and a custom OIB knowledge source.

## Start here

| Question | Go to |
|---|---|
| How do I set up, branch, commit, and get a PR merged? | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| What is everything written down about this project? | [`docs/README.md`](docs/README.md), grouped by the question you arrived with |
| How does the system actually work? | [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) |
| Why is it like that? | [`docs/adr/`](docs/adr/) |
| How do we work here, in detail? | [`docs/contributing/README.md`](docs/contributing/README.md) |

Everything below is what an agent must **act on** while working. It is
deliberately short. If you find yourself wanting to add project knowledge here,
that is a signal the knowledge has no home yet: give it one under
[`docs/contributing/`](docs/contributing/README.md) and leave a one-line pointer.

## Repository layout

| Path | Purpose |
|------|---------|
| `.devcontainer/` | VS Code dev container configuration |
| `src/aiq_agent/` | Backend agent (LangGraph agents, cards, knowledge layer) |
| `sources/` | NAT data-source packages (web search, knowledge layer, RIS adapter, grid cards) |
| `frontends/ui/` | Next.js app: UI + BFF API routes + WS proxy (`server.js`) |
| `frontends/web/` | Public Piloti landing page + blog (Astro microservice; `de`/`en`, Keystatic CMS for platform-owner blog writing) |
| `frontends/aiq_api/` | The backend FastAPI front-end plugin (`_type: aiq_api`): REST routes, async jobs, `/v1/ingest` |
| `frontends/debug/` | Debug console mounted at `/debug` |
| `frontends/cli/` | `aiq-research` CLI |
| `frontends/benchmarks/` | Evaluation harnesses |
| `configs/` | Workflow configs. **LLM-agnostic** — any OpenAI-compatible endpoint (set `base_url`/key per config). **`config_oib_openrouter.yml` is the working reference config** (`config_grid_oib.yml`/Kimi is currently unmaintained). The `model_name` values are only the **boot fallback**: the live default per agent group is admin-controlled (Platform → Models, `platform_model_defaults`) and a tenant may override it (Organization → Models) — see `docs/architecture/org-model-configuration.md`. Do not edit the YAML to move the fleet to a new model. |
| `deploy/` | Docker Compose assets and environment templates; `deploy/pulumi/` holds the Pulumi (TypeScript) Kubernetes deployment (see `docs/deployment/kubernetes.md`) |
| `docs/architecture/` | Architecture docs (see `backend-deep-dive.md`, `project-memory-design.md`, `citation-system-audit-2026-07.md` for the citation pipeline as built) |
| `skills/` | API-consumer skill examples |
| `scripts/` | Utility scripts, including `scripts/ingest_oib.py` |
| `releasenotes/` | reno release notes — one YAML file per user-visible change, published to piloti.at/changelog |
| `data/oib/` | OIB Richtlinien PDFs, tracked with Git LFS |

## Working style: value driven

Before you touch anything, answer one question in writing. What does the user
actually expect to be true when this is done? Not what the ticket says, not what
the spec file contains. What changes for the person who asked.

The request is evidence about the expectation, not the expectation itself. A
spec, a handover package, a simulation HTML: those are someone's guess at how to
reach the outcome. Implementing the guess faithfully while the outcome stays out
of reach is the most expensive way to fail here, because it looks like delivery.

So the order is expectation, then "does the requested change produce it", then
code. When the middle step comes back no, say so before writing the code, and
say what would.

The test that produced this rule. A wizard handover package (`wizard_spec.json`
v1.2 plus concept plus clickable simulation) specified `B2_upl`, "Bebauungsplan
ablegen", as a question of `type: 'upload'`. Implementing that literally means
rendering an upload control in the wizard. Doing so would have satisfied the
spec completely and delivered nothing, because the expectation behind it is that
the assistant knows which file is the Bebauungsplan for this project, and this
repo has no per-project notion of a document's ROLE at all. Tags
(`document_classification.ALLOWED_TAGS`) are LLM-guessed content labels.
`doc_class` is the base-corpus norm hierarchy. Folders are user-arranged
furniture. None of them can answer "which file is THE Bebauungsplan here", which
is what every downstream feature in that package is built on: extraction, the B3
Kernset review, Modul I's completeness checklist, the agent's project context.
The upload control was the visible tip. The missing declaration was the work.

Corollary, and it cuts both ways. Value driven is not licence to widen a task
because you spotted something adjacent, and it is not licence to narrow it to
the part that is comfortable. It obliges you to name the gap between what was
asked and what was expected, then let the user decide which one they are paying
for.

## Working style: prefer visuals

The maintainer values visual explanations. When explaining architecture, data
flows, deployment topology, sequence/interaction, or any non-trivial design,
render a diagram with the **Excalidraw** tool (`create_view`) rather than
describing it in prose alone. Keep diagrams structured: a clear layered/left-to
-right flow, aligned grid, orthogonal arrows that don't cross boxes, and a short
legend. Offer a diagram proactively for architecture/design discussions.

## Working style: fix causes, not symptoms

Solve the problem at the level it actually exists. A change that makes a number
better without changing what produced it is a bandage, and it makes the real
fault harder to see later because the signal that pointed at it is gone.

The test that surfaced this: `InputArea.spec.tsx` took 45.9s of the UI suite's
209.6s of test execution. Three fixes were available.

| | what it does | level |
|---|---|---|
| Raise the shard count | spreads the same work over more runners | hides it |
| Split the spec file | spreads the same work over more shards | hides it |
| Decompose the component | removes the work | fixes it |

The first two move a 172ms-per-test mount around; only the third makes it stop
costing 172ms. The slow test was never the problem — it was the readout on a
1999-line component that needed eleven mocked modules to render at all. Optimise
that away and the design fault is still there, minus the evidence.

The cause is specific and this repo already solves it elsewhere. 37 of those 102
tests assert on *logic* — mention rules, addressee resolution, draft persistence
— and each mounts the whole React tree to do it, because the logic lives in the
render function. Compare two specs in the same suite:

| spec | tests | test time | per test |
|------|-------|-----------|----------|
| `layout/lib/source-presets.spec.ts` (logic in a module) | 10 | 13ms | **1.3ms** |
| `layout/components/InputArea.spec.tsx` (logic in a component) | 102 | 17,550ms | **172ms** |

132x, from nothing but where the code sits. `src/features/layout/lib/` is the
established pattern — pure modules with their own fast specs. Extend it rather
than reaching for shards.

So: before optimising a measurement, establish what the measurement is *of*.
Ask what would have to be true for this number to be legitimate, and if it
isn't, fix that instead. When a fast fix and a correct fix disagree, take the
correct one or say plainly that you are deferring it and why — never ship the
fast one described as the correct one.

Corollary, learned the same way: verify the cause before acting on it. Two
plausible explanations for that 172ms (userEvent's default keystroke delay, an
unmocked motion library) were both measured and both wrong. A cause that has not
been measured is a guess, and a fix built on a guess is a bandage even when it
happens to work.

## Working style: ratchet every correction

A **ratchet** turns one way and cannot slip back. A correction that changes only
the output leaves the layer that allowed it exactly as it was, so the same class
of error is free to recur and the next person pays again. Fix the output, then
close the layer. Prefer the layer that holds while people are tired: a database
CHECK constraint asks nobody to remember anything, where a rule in this file
asks every future reader.

The section above is about diagnosing deep enough. This one is about what
happens after the diagnosis, so they compound rather than overlap.

Reach for the playbook, which names the layer to close for each kind of failure
and where each lives in this repo, whenever a reviewer corrects you, something
surprises you, or you correct yourself twice for one reason:
**`docs/contributing/correction-ratchet.md`**.

## Verification

`task verify` is the merge gate, host-native, defined once in `Taskfile.yml` and
run unchanged by CI. `task verify:fast` omits only the production build, and
`task --list` is the always-current command list.

Three things that will bite you, in full in
[`docs/contributing/testing-and-verification.md`](docs/contributing/testing-and-verification.md):
spec type errors fail the production build, `task db:test:rls` is required but
not part of `task verify`, and backend tests need `PYTHONPATH=src` if you bypass
the tasks.

A user-visible UI change is done only with a committed screenshot
(`task fe:screenshots`, `/dev/*` preview route plus a registry target).

## Release notes are mandatory (obligation)

A change a customer can notice does not merge without a release note in the same
pull request, enforced by the **Release note** CI job. `task release:note -- <slug>`
creates one, `task release:lint` checks it, `no-release-note` on the PR is the
escape hatch and using it claims no user can observe the change. Everything else,
including what makes a note customer copy:
[`docs/contributing/release-notes.md`](docs/contributing/release-notes.md).

## Documentation is part of the work (obligation)

Docs change in the same commit as the behaviour they describe. Stale docs are a
bug, and "I'll document it after" means it does not happen. Which doc for which
change: [`docs/contributing/documentation.md`](docs/contributing/documentation.md).

## Authorization (obligation)

Permission-driven, never role-name driven.

1. **Add the permission to `frontends/ui/src/lib/authz/catalog.ts` first.** The
   app derives its permission types from it and `bun run provision:authz` applies
   it to WorkOS, so code and identity provider cannot drift.
2. **Every `app/api` route declares how it is authorized.** `apiRoute` does not
   compile without an `authz` option, and `authz-coverage.spec.ts` fails when a
   handler escapes the factories.
3. **Decisions go through `lib/authz/decide.ts`**, the single decision point, so
   bypasses are named rather than implicit.

Model and runbook:
[`docs/architecture/multitenancy-and-auth-spec.md`](docs/architecture/multitenancy-and-auth-spec.md),
[`docs/deployment/workos-provisioning.md`](docs/deployment/workos-provisioning.md).

## Tenant isolation is enforced in the database (obligation)

Authorization decides whether a caller may act. Which rows a query returns is
PostgreSQL row-level security, a real boundary under the `WHERE organization_id`
convention rather than a replacement for it.

- **A new table joins the boundary in the migration that creates it**: one
  `SELECT grid_secure_table('<table>', '<tenancy predicate>');`.
  `src/lib/db/rls-coverage.spec.ts` fails by name until you do.
- **Context comes from `getGridSession()`.** Callers without a session state it
  (`withTenant`, `withPlatformAccess`, `withOptionalTenant`), and
  `internalApiRoute` does not compile without a `tenancy` declaration.
- **Stepping up is not authorization.** RLS guards application bugs, the missing
  `WHERE` and the widened join, not a compromised process: anything that runs
  arbitrary SQL as `grid_app_rw` can name any tenant. Keep every platform-scope
  caller behind its own check.

Runbook: [`docs/database/row-level-security.md`](docs/database/row-level-security.md).

## BFF architecture (obligation)

Every service and every endpoint change follows the repository/service split.

- **Routes** (`app/api/**/route.ts`) are thin transport adapters declared through
  `@/lib/api/handler`. No bare `export async function GET`, no `getDb()` in a
  route, no hand-rolled error responses.
- **Services** (`lib/<domain>/service.ts`) own business logic and authorization,
  and throw typed errors from `@/lib/api/errors`.
- **Repositories** (`lib/<domain>/repository.ts`) are the only modules that query
  their domain's tables. Every list query is bounded.
- `publicApiRoute` is for health checks. Anything else needs an ADR.

The projects domain is the reference implementation. Rationale:
[`docs/architecture/bff-service-architecture.md`](docs/architecture/bff-service-architecture.md).

## Cards must persist the user's answer (obligation)

A card whose button *writes* something follows propose-never-auto-apply, so the
user's click is the only place authorization exists.

- **Never hold that decision in component-local `useState`.** The card payload
  persists, so a lost decision brings the card back after a reload looking
  untouched, with a live button that applies the patch or writes the memory a
  second time. Neither endpoint is idempotent. Put it on `ChatMessage`
  (`cardInteractions`, keyed by `cardKey(card, index)`, through `useCardDecision`).
- **A new card type must be classified in `CARD_INTERACTIVITY`**
  (`features/grid-cards/card-decision.ts`). The map is exhaustive over the
  generated union, so `task fe:types` fails until you do.

Contract and checklist: ADR-0030 and
[`docs/architecture/cards.md`](docs/architecture/cards.md).

## Knowledge systems (obligation)

Two systems share the name: **project knowledge** (the intake profile plus
agent-curated memory) and **RAG document knowledge** (uploads ingested into
scoped collections). Three rules keep rivals from sprouting:

- **The project profile has one editor, the intake wizard.** Settings displays it
  read-only and links to the wizard. No second parameters form, no inline
  editing: the facts are interdependent and edits belong in the guided flow.
- **One coarse `SourceKind` drives all rendering** (`baurecht | buero | projekt |
  web`), defined in `src/aiq_agent/common/source_kinds.py` and mirrored in
  `features/chat/lib/source-kinds.ts`. The fine `norm_registry` lanes are a
  sub-label within a kind, not a competing taxonomy.
- **`doc_class` is human-set, never a filename guess**, and is preferred over
  heuristics everywhere.

Tiers, pipeline and memory plumbing:
[`docs/architecture/rag-system-audit-2026-08.md`](docs/architecture/rag-system-audit-2026-08.md),
[`docs/architecture/project-memory-design.md`](docs/architecture/project-memory-design.md).

## Environment variables

Secrets and deployment knobs live in environment variables only (`deploy/.env`).
Add the row to
[`docs/deployment/environment-variables.md`](docs/deployment/environment-variables.md)
in the same change that adds the variable.

## Agent skills

Skills live in `.claude/skills/`. Repo-authored ones are in `.agents/skills/`
(maintainer) and top-level `skills/` (API-consumer). Third-party ones are
dependencies: pinned in `apm.yml`, locked in `apm.lock.yaml`, installed by
`task agents:setup` which `task setup` already runs. `task agents:audit` checks
for drift. Selection rationale and the vendored pstack set:
[`.claude/skills/PSTACK.md`](.claude/skills/PSTACK.md).

## Code conventions

House rules with a history, each one written down because somebody paid for it,
in [`docs/contributing/code-conventions.md`](docs/contributing/code-conventions.md):
the `any` ban in production code and tests, coercing raw `sql<T>` results at the
repository boundary, where a general-purpose helper belongs, and the capability
doctrine (flag AND capability, never a second flag).

Python is ruff, line length 120, Python 3.11. New tools use `@register_function`
with a `FunctionBaseConfig` subclass.

## Three rules about scope

**Fix errors you find. Never dismiss them as pre-existing.** A bug, a broken
test, or wrong behaviour you meet while working gets fixed, including one that
pre-dates your change. "It was already broken" is not a reason to leave it
broken. When a fix is genuinely out of scope, say so loudly in the PR rather
than waving it away.

**Correlated substrate debt belongs in the change that tripped over it.** YAGNI
forbids unused features, not known defects on the path you are walking. If
implementing B needs A to be generic and A's own audit says it is not, a
visibility write that silently no-ops, mentions typed to one consumer, a cleanup
that knows one type, you lift A in this change as its own commits rather than
special-casing B or filing the lift as later. The test: would you have to work
around it, switch on your type, or leave a descriptor field unread? Then it is
correlated. Register and rule:
[`docs/architecture/adding-a-shareable-resource-type.md`](docs/architecture/adding-a-shareable-resource-type.md).

**Question necessity, then simplify.** The best part is no part. Start by asking
why the thing must exist and whether existing machinery already covers it, and
finish with a pass that tries to delete: remove parts, collapse layers, reuse
instead of add. Reduce complexity, never features. That pass is part of done,
not a follow-up.

## Git workflow

One feature, one branch, cut from `develop`. Conventional Commits, and the PR
title itself must be a valid Conventional Commit subject because the repo
squash-merges it. Never commit secrets; branch before committing if you are on
`develop` or `main`. Full conventions, including stacking and the allowed types:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

Substrate lifts a feature depends on belong in the same branch, each as its own
commit, before the feature starts depending on the repaired primitive.

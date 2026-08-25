# Grid Agent Contributor Guide

Grid is an OIB building-regulation assistant: a Next.js UI and BFF
(`frontends/ui`), a Python agent on the NeMo Agent Toolkit (`src/aiq_agent`),
and a custom OIB knowledge source.

## Start here

| Question | Go to |
|---|---|
| Set up, branch, commit, get a PR merged | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Everything written down, by the question you arrived with | [`docs/README.md`](docs/README.md) |
| How the system works | [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md) |
| Why it is like that | [`docs/adr/`](docs/adr/) |
| How we work, in detail | [`docs/contributing/README.md`](docs/contributing/README.md) |

This file is what you must **act on** while working. Project knowledge you want
to add here has no home yet: give it one under
[`docs/contributing/`](docs/contributing/README.md) and leave a one-line pointer.

## Working style

**Value driven.** Before touching anything, answer what the user expects to be
true when this is done. The request is evidence about that expectation, not the
expectation itself: a spec or handover package is someone's guess at how to
reach the outcome. When the requested change would not produce it, say so before
writing the code, and say what would. Name the gap and let the user decide which
one they are paying for. This neither widens a task because you spotted
something adjacent, nor narrows it to the comfortable part.

**Prefer visuals.** For architecture, data flow, deployment topology or
sequence, render an Excalidraw diagram (`create_view`) rather than prose alone:
layered left to right, aligned, orthogonal arrows that miss the boxes, short
legend. Offer one proactively in design discussions.

**Fix causes, not symptoms.** Establish what a measurement is *of* before
optimising it. A change that improves a number without changing what produced it
is a bandage, and it removes the signal pointing at the real fault. Verify the
cause by measuring it: an unmeasured cause is a guess, and a fix built on a
guess is a bandage even when it works. When the fast fix and the correct fix
disagree, take the correct one, or say plainly that you are deferring it and
why.

**Ratchet every correction.** A ratchet turns one way. Fix the output, then
close the layer that let it through, preferring the layer that holds while
people are tired: a database CHECK constraint asks nobody to remember anything.
Ratcheted means a second occurrence is caught by something other than a person
noticing. Reach for it when a reviewer corrects you, when something surprises
you, or when you correct yourself twice for one reason.

**When something surprises you or breaks, read
[`docs/contributing/gotchas.md`](docs/contributing/gotchas.md) before you start
debugging it.** It is indexed by the symptom you arrive with, and every entry is
an afternoon somebody already spent. Add yours the moment a failure costs you
more than a few minutes, while you still remember the string you searched for.
That register is the other half of the ratchet: a correction with nowhere to
land is not ratcheted.

The cases that produced each rule:
[`docs/contributing/working-style.md`](docs/contributing/working-style.md).
Which layer to close: [`docs/contributing/correction-ratchet.md`](docs/contributing/correction-ratchet.md).

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add an `app/api` route | Declare `authz` on the factory from `@/lib/api/handler` | `apiRoute` does not compile; `authz-coverage.spec.ts` |
| Add a permission | Add it to `lib/authz/catalog.ts` first, then `bun run provision:authz` | WorkOS drifts from the code |
| Decide access | Go through `lib/authz/decide.ts`, the single decision point | Bypasses become implicit |
| Create a table | `SELECT grid_secure_table('<table>','<tenancy predicate>');` in the same migration | `rls-coverage.spec.ts`, by name |
| Read tenant rows | Take context from `getGridSession()`, or state it (`withTenant`, `withPlatformAccess`, `withOptionalTenant`) | `internalApiRoute` does not compile |
| Write an endpoint | Route stays a thin adapter, service owns logic and authorization, repository owns the SQL and bounds every list | Review. `publicApiRoute` needs an ADR |
| Add a card type | Classify it in `CARD_INTERACTIVITY` (`features/grid-cards/card-decision.ts`) | `task fe:types` |
| Store a card's answer | Put it on `ChatMessage.cardInteractions` via `useCardDecision` | A reload re-applies the patch; neither endpoint is idempotent |
| Add an environment variable | Add its row to [`docs/deployment/environment-variables.md`](docs/deployment/environment-variables.md) in the same change | Review |
| Change what a customer can notice | `task release:note -- <slug>` | The **Release note** CI job |
| Change behaviour a doc describes | Update the doc in the same commit | Review. Stale docs are a bug |
| Ship a user-visible surface | `/dev/<name>` preview route, a registry target, committed PNGs from `task fe:screenshots` | `visual-coverage` |
| Touch the tenant boundary | `task db:test:rls`, which `task verify` does not include | A required merge check |
| Run `pytest` directly | Set `PYTHONPATH=src`, which `Taskfile.yml` otherwise sets for you | Silently validating another worktree's code |

`task verify` is the merge gate: host-native, defined once in `Taskfile.yml`, run
unchanged by CI. `task --list` is the current command list. Spec type errors fail
the production build, because the UI tsconfig includes tests.

## Four rules that need more than a row

**Stepping up is not authorization.** Row-level security guards application
bugs, the missing `WHERE` and the widened join. Anything that runs arbitrary SQL
as `grid_app_rw` can name any tenant, so every platform-scope caller keeps its
own check.

**The project profile has one editor, the intake wizard.** Settings shows it
read-only and links to the wizard. Its facts are interdependent, so edits belong
in the guided flow rather than a second form.

**One coarse `SourceKind` drives all rendering** (`baurecht | buero | projekt |
web`), defined in `src/aiq_agent/common/source_kinds.py`, mirrored in
`features/chat/lib/source-kinds.ts`. The fine `norm_registry` lanes are a
sub-label within a kind. `doc_class` is human-set and beats every filename guess.

**Correlated substrate debt belongs in the change that tripped over it.** YAGNI
forbids unused features, not known defects on the path you are walking. If B
needs A to be generic and A is not, lift A here as its own commits. The test:
would you work around it, switch on your type, or leave a descriptor field
unread? Then it is correlated.
[`docs/architecture/adding-a-shareable-resource-type.md`](docs/architecture/adding-a-shareable-resource-type.md)
holds the register.

## Scope

Fix errors you meet, including ones that pre-date your change. "It was already
broken" leaves it broken; when a fix is genuinely out of scope, say so loudly in
the PR.

Question necessity first, then simplify. The best part is no part: ask whether
existing machinery already covers it, and finish with a pass that tries to
delete. Reduce complexity, never features. That pass is part of done.

## Reference

- Code conventions, the `any` ban, coercing raw `sql<T>`, where a shared helper
  belongs, capability doctrine:
  [`docs/contributing/code-conventions.md`](docs/contributing/code-conventions.md).
  Python is ruff, line length 120, 3.11; new tools use `@register_function` with
  a `FunctionBaseConfig` subclass.
- Verification, CI sharding, the security stack, visual evidence:
  [`docs/contributing/testing-and-verification.md`](docs/contributing/testing-and-verification.md).
- Branching, Conventional Commits, PR titles: [`CONTRIBUTING.md`](CONTRIBUTING.md).
  Substrate lifts go in the same branch, each its own commit, before the feature
  depends on the repaired primitive.
- Skills: `.claude/` is generated and gitignored. Repo-authored ones live in
  `.agents/skills/` and `skills/`; third-party ones are pinned in `apm.yml`.
  `task agents:setup` rebuilds both halves.
  [`docs/contributing/agent-skills.md`](docs/contributing/agent-skills.md).
- `configs/` model names are the boot fallback only. The live default is
  admin-controlled (Platform → Models); moving the fleet is a save in the admin
  UI, never a YAML edit.
  [`docs/architecture/org-model-configuration.md`](docs/architecture/org-model-configuration.md).

# Grid Agent Contributor Guide

Grid is an OIB building-regulation assistant: a Next.js UI and BFF
(`frontends/ui`), a Python agent on the NeMo Agent Toolkit (`src/aiq_agent`),
and a custom OIB knowledge source.

## Setup

Run this before anything else, including before reading much further — every
command this guide names comes from `Taskfile.yml` and none of them exist until
the first line has run.

```bash
npm i -g @go-task/cli   # `task` itself. Nothing in the repo installs it
task setup              # backend venv, UI, web, both Pulumi programs, agent skills
pre-commit install      # NOT part of `task setup`, and CI lints the whole repo
task verify             # the merge gate. Run it before you call anything done
```

`task setup` needs `uv`, `bun` and Node on the PATH; it installs everything
else, is idempotent, and takes a few minutes on a cold clone. `bun` is the
installer and script runner for the UI, never the runtime — see
[`gotchas.md`](docs/contributing/gotchas.md) before you reach for `--bun`.

Two things `task setup` does not do, both of which fail later and confusingly:
it does not install the git hooks (`pre-commit install`, above), and it does not
give you `task db:test:rls`, which needs PostgreSQL server binaries and is a
required merge check whenever you touch the tenant boundary.

`task --list` is the current command list and beats any list written down here.

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

## Where the scoped guides are

This file is the part that is true everywhere. Each service carries its own
`AGENTS.md` with the part that is true only there — the onboarding guide for
that one thing. **Read the guide for the area you are about to touch before you
touch it**, and read this one as well; they are additive, not alternatives.

| You are working in | Read |
|---|---|
| `src/aiq_agent/` — the agent: LangGraph agents, tools, cards, stages, knowledge | [`src/aiq_agent/AGENTS.md`](src/aiq_agent/AGENTS.md) |
| `frontends/ui/` — Next.js UI, the BFF, the WebSocket proxy | [`frontends/ui/AGENTS.md`](frontends/ui/AGENTS.md) |
| `frontends/aiq_api/` — the FastAPI plugin: REST routes, async jobs, `/v1/ingest` | [`frontends/aiq_api/AGENTS.md`](frontends/aiq_api/AGENTS.md) |
| `frontends/web/` — the public Astro site and blog | [`frontends/web/AGENTS.md`](frontends/web/AGENTS.md) |
| `sources/` — NAT data-source packages | [`sources/AGENTS.md`](sources/AGENTS.md) |
| `packages/` — standalone libraries, gated by nothing yet | [`packages/AGENTS.md`](packages/AGENTS.md) |
| `deploy/` — Compose, Helm, Pulumi | [`deploy/AGENTS.md`](deploy/AGENTS.md) |
| `tests/` — the backend suite | [`tests/AGENTS.md`](tests/AGENTS.md) |
| `docs/adr/` — writing or superseding a decision | [`docs/adr/AGENTS.md`](docs/adr/AGENTS.md) |

Open it yourself, and treat anything your harness loaded on its own as a bonus.
Claude Code reaches a nested guide only after it has already read a file in that
directory, and some harnesses never do. One read settles it.

Why these files are shaped the way they are, and what breaks when they are not:
[`docs/contributing/agent-onboarding-files.md`](docs/contributing/agent-onboarding-files.md).

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

**Buy, don't build.** Complexity that belongs to somebody else's domain —
geometry, cryptography, time zones, PDF, identity, storage, observability — is a
dependency, not a module you write. Identity is WorkOS, the cache Dragonfly, the
object store SeaweedFS, LLM traces Langfuse; each was an ADR rather than a
weekend. Before the second hundred lines of something general, search for the
library and say in the PR what you found and why it did or did not fit. Write it
yourself when the library's shape does not answer the question you are asking,
when it drags a native toolchain into the image, or when the thing *is* the
product — and then keep the library in the suite as the oracle you check
against.

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

**Finish the task.** Reversible work does not get a permission checkpoint. A
natural boundary — a layer done, a slice green, a commit pushed — is a place to
report progress, never a place to stop and ask whether to continue. Asking costs
the user a turn to say "yes, keep going", and that turn is a correction: it
means the plan was already agreed and you paused anyway. Carry on to the end
state the user described, then present the result and let them redirect. Stop
early only for something genuinely irreversible or genuinely ambiguous, and when
you do, say what you need rather than offering a menu.

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

Repo-wide. Each service adds its own — the map is above, and the rows there are
the ones that will actually fail your PR.

| When you | You must | What fails you |
|---|---|---|
| Add an environment variable | Add its row to [`docs/deployment/environment-variables.md`](docs/deployment/environment-variables.md) in the same change | Review |
| Change what a customer can notice | `task release:note -- <slug>` | The **Release note** CI job |
| Change behaviour a doc describes | Update the doc in the same commit | Review. Stale docs are a bug, because an agent acts on them |
| Learn something the repo could have told you | Write it down where the next agent will already be looking, before you carry on | Nothing, once. Then everyone re-earns it. [The ratchet](docs/contributing/correction-ratchet.md#human-intervention-is-a-failure-signal) |

`task verify` is the local gate: host-native, defined once in `Taskfile.yml`. CI
calls the same definitions but schedules them differently, so a local pass is
strong evidence rather than a guarantee. `task verify:fast` skips two production
builds, `fe:build` and `web:build`.

Two gates sit outside `task verify` and are still required: `task db:test:rls`
whenever you touch the tenant boundary, and the suites under `sources/` and
`packages/`, which no CI job runs at all.

## Two rules that span services

**One coarse `SourceKind` drives all rendering** (`baurecht | buero | projekt |
web`), defined in `src/aiq_agent/common/source_kinds.py`, mirrored in
`frontends/ui/src/features/chat/lib/source-kinds.ts`. The fine `norm_registry`
lanes are a sub-label within a kind. `doc_class` is human-set and beats every
filename guess. There is no shared schema between the two files: changing one
and not the other renders the chip as unknown.

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
- Patterns this codebase applies and what enforces each one (atomic design,
  guard scripts, generated artifacts, per-turn `ContextVar` registries):
  [`docs/architecture/patterns-in-use.md`](docs/architecture/patterns-in-use.md).
- Verification, CI sharding, the security stack, visual evidence:
  [`docs/contributing/testing-and-verification.md`](docs/contributing/testing-and-verification.md).
- Branching, Conventional Commits, PR titles: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Skills: `skills/` is the one source, `.claude/` and `.agents/` are generated.
  [`docs/contributing/agent-skills.md`](docs/contributing/agent-skills.md).
- `configs/` model names are the boot fallback only. The live default is
  admin-controlled (Platform → Models); moving the fleet is a save in the admin
  UI, never a YAML edit.
  [`docs/architecture/org-model-configuration.md`](docs/architecture/org-model-configuration.md).

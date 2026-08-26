# Agent skills

`skills/` is the single source. Everything else is generated.

Every skill this repo authors lives in [`../../skills/`](../../skills/), listed
in [`../../apm.yml`](../../apm.yml) as a local path beside the pinned
third-party ones. apm publishes the whole set into each harness directory named
in that manifest's `targets`, so `.claude/` and `.agents/` are **generated and
gitignored** and nothing in them is source.

```bash
task agents:setup   # publish every skill in apm.yml to every target
task agents:audit   # drift against the lock, plus a hidden-Unicode scan
task agents:update  # refresh the third-party pins, then review the diff
```

Adding a harness is one line in `targets`. Adding a skill is a directory in
`skills/` and one line in `dependencies.apm`. There is no copy step to keep in
sync, which is the point: an earlier version of this had a script symlinking
one directory into another, and before that, ten committed files that *looked*
like symlinks and were plain text containing a path (git mode `100644`, not
`120000`). None of them resolved, so none of those skills had ever loaded for
anyone. Publishing from one source removes the category.

`skills/` holds two audiences, maintainer and API-consumer, side by side. See
[`../../skills/README.md`](../../skills/README.md) for which is which and how to
add one.

## Installed

Third-party skills sit in the same manifest, pinned to a commit and locked in
`apm.lock.yaml`, fetched by [apm](https://github.com/microsoft/apm).

| Skill | Fires | Why |
|---|---|---|
| `unslop` | automatically, on any writing | This repo carries a lot of prose |
| `writing-for-agents` | automatically, when you touch a skill, `AGENTS.md` or `CLAUDE.md` | The rules `AGENTS.md` is now written to |
| `typescript-best-practices` | automatically, on any `.ts`/`.tsx` | `frontends/ui` is most of the surface area |
| `how` | automatically, on "how does X work" and placement questions | Four layers can own a feature here, so "which layer" recurs |
| `why` | automatically, on "why does X work this way", rationale, postmortems | The question `docs/adr/` exists to answer. `how` reads the code, `why` reconstructs the forces from history, issues and docs |
| `technical-writing` | by name | Human-facing prose: docs, RFCs, PR bodies. `writing-for-agents` covers what an agent consumes |
| `interrogate` | by name | Adversarial multi-model review of a diff |
| `blast-radius` | by name | Changes whose danger sits outside the diff |
| `principle-model-the-domain` | by name | Encode the domain in a structure instead of scattered conditionals |
| `improve-codebase-architecture` | by name | Scans for shallow modules, reports candidates, then walks the chosen one. Reads `docs/adr/` so it does not re-propose decisions we already recorded |
| `codebase-design` | by name, and by the skill above | The architecture vocabulary the report is written in |
| `grilling` | by name, and by the skill above | The decision loop once a candidate is picked |
| `domain-modeling` | by name, and by the skill above | Keeps a `CONTEXT.md` glossary current as terms sharpen |

The last four are one capability. `improve-codebase-architecture` calls the
Skill tool for the other three by name, so taking it alone leaves three dead
calls. It also wants a `CONTEXT.md` domain glossary, which this repo does not
have; the skill creates one lazily the first time a term needs a home.

Eight are from [pstack](https://github.com/cursor/plugins/tree/main/pstack),
picked out of its 44, and five from
[mattpocock/skills](https://github.com/mattpocock/skills).
`apm install cursor/plugins/pstack` takes the whole plugin in one dependency if
you want the rest; the cost is context load from the ones that fire on their own.

### Deliberately not taken

pstack ships roughly twenty `principle-*` skills. Most of them restate something
this repo already says in a place that loads earlier and carries our own worked
examples, and a second copy of a rule is sediment rather than reinforcement:

| Skill | Already covered by |
|---|---|
| `principle-encode-lessons-in-structure` | [the correction ratchet](correction-ratchet.md) |
| `principle-fix-root-causes` | "Fix causes, not symptoms", `AGENTS.md` |
| `principle-subtract-before-you-add` | "Question necessity first, then simplify", `AGENTS.md` |
| `principle-never-block-on-the-human` | "Finish the task", `AGENTS.md` |
| `principle-prove-it-works` | [`aiq-definition-of-done`](../../skills/aiq-definition-of-done/SKILL.md) |
| `principle-type-system-discipline` | the `any` ban, [code-conventions.md](code-conventions.md) |
| `principle-guard-the-context-window` | [agent-onboarding-files.md](agent-onboarding-files.md) |

**`no-comments` would actively damage this codebase.** It deletes explanatory
comments on application logic and keeps only constraint comments. The long "why"
headers in `common/source_kinds.py`, `cards/registry.py`, `Taskfile.yml` and
`.gitignore` are the design documents that stayed next to the code, and several
scoped `AGENTS.md` files point readers at them on purpose. Do not add it.

**`create-verification-skill`** generates its harness into `.cursor/skills/`, a
fourth harness path that `apm.yml` does not target, and this repo already proves
behaviour through `task verify` and committed screenshots from
`task fe:screenshots`.

A skill carrying `disable-model-invocation: true` never triggers by itself. Ask
for it by name. That is deliberate for `interrogate` and `blast-radius`, which
spawn subagents.

## Two things to know before trusting them

**`interrogate` is weaker here than upstream.** It reads a reviewer list from
`~/.cursor/rules/pstack-models.mdc` and defaults to a cross-vendor panel
(`gpt-5.6-sol-max`, `grok-4.6-fast-xhigh`). Neither exists in this setup, so it
falls back to Claude reviewers. Its adversarial signal comes from model
diversity, so a single-vendor panel is a diminished version of the skill. The
vendored text also says `Task` tool and `subagent_type: generalPurpose`; here
that is the `Agent` tool with `subagent_type: general-purpose`.

**`unslop` rule 13 bans em dashes outright.** Every `AGENTS.md`, every
`CLAUDE.md` and all of this directory now hold to it, so a dash appearing in one
of those is a regression rather than a house style. The rest of `docs/` does
not, and a punctuation sweep of the audits and specs is not worth a diff on its
own. Two deliberate exceptions: the `next dev` block at the top of
`frontends/ui/AGENTS.md`, which regenerates itself, and ADR titles quoted in
`docs/adr/README.md`, which have to match the records they point at.

Rule 26 bans some words this repo uses on purpose. "Ratchet" and "substrate
debt" are defined terms here, each with a document behind it, and the
`writing-for-agents` skill calls that a leading word rather than a metaphor to
avoid. Keep them.

**apm 0.28 resolves targets inconsistently, and names them inconsistently.**
Autodetection in `install` and in the `audit` replay disagree, which reported
files `install` never wrote as drift, so `apm.yml` pins `targets` rather than
relying on detection. The name for the shared `.agents/skills/` path is
`agent-skills` in a manifest, while the CLI's `--target` help also lists
`agents`, which a manifest rejects.

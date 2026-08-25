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
| `interrogate` | by name | Adversarial multi-model review of a diff |
| `blast-radius` | by name | Changes whose danger sits outside the diff |
| `principle-model-the-domain` | by name | Encode the domain in a structure instead of scattered conditionals |

Six of these are from [pstack](https://github.com/cursor/plugins/tree/main/pstack),
picked out of its 44. `apm install cursor/plugins/pstack` takes the whole plugin
in one dependency if you want the rest; the cost is context load from the ones
that fire on their own.

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

**`unslop` rule 13 bans em dashes outright**, and most prose in this repo uses
them. `AGENTS.md` and this directory are written under the rule. Nobody has
decided whether the rest should follow, and a punctuation sweep of existing docs
is not worth a diff on its own.

**apm 0.28 resolves targets inconsistently, and names them inconsistently.**
Autodetection in `install` and in the `audit` replay disagree, which reported
files `install` never wrote as drift, so `apm.yml` pins `targets` rather than
relying on detection. The name for the shared `.agents/skills/` path is
`agent-skills` in a manifest, while the CLI's `--target` help also lists
`agents`, which a manifest rejects.

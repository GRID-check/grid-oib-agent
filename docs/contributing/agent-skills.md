# Agent skills

`.claude/` is **generated and gitignored**. Nothing in it is source. `task
agents:setup` rebuilds it, and `task setup` already runs that.

Skills come from two places, with different rules.

## Repo-authored

Source of truth on disk, tracked in git:

| Location | Audience |
|---|---|
| `.agents/skills/` | Maintainers working **on** this repo (`aiq-add-tool`, `aiq-release-qa`, `aiq-definition-of-done`, …) |
| `skills/` | Consumers calling a running AI-Q server (`aiq-deploy`, `aiq-research`) |

See [`../../.agents/skills/README.md`](../../.agents/skills/README.md) for which
is which. Edit these in place. `task agents:link` symlinks them into
`.claude/skills/` so Claude Code can see them.

That link step replaced eight files committed as *text containing a path* rather
than as real symlinks (git mode `100644`, not `120000`), so none of them
resolved and none of those skills ever loaded. Generating the links removes the
category of bug rather than repairing eight files.

## Installed

Third-party skills are dependencies: declared in
[`../../apm.yml`](../../apm.yml), pinned to a commit, locked in
`apm.lock.yaml`, fetched by [apm](https://github.com/microsoft/apm).

```bash
task agents:setup   # apm install --frozen, then link the repo-authored ones
task agents:audit   # drift against the lock, plus a hidden-Unicode scan
task agents:update  # refresh the pins, then review the diff before committing
```

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

**apm 0.28 resolves targets inconsistently.** `install` detects `claude` from
`.claude/` and `CLAUDE.md`; the `audit` replay also resolves `agents` from
`.agents/`, then reports files `install` never wrote as drift. `apm.yml` pins
`targets` so both agree.

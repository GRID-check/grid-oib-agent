# pstack skills vendored into this repo

Six skills from [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack)
(poteto's stack), copied verbatim so upstream updates stay a clean `cp`. Do not
edit the vendored `SKILL.md` files. Corrections belong here or upstream.

They are copied rather than installed because pstack is a Cursor plugin, not an
apm package. Everything apm *can* resolve goes through `apm.yml` instead (see
the Agent skills section of `AGENTS.md`). The two live side by side in
`.claude/skills/`: apm deploys into that directory and leaves directories it
does not own alone, which `apm prune` and `apm audit` both confirm.

To refresh from upstream:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins.git /tmp/pstack
git -C /tmp/pstack sparse-checkout set pstack
for s in unslop typescript-best-practices how interrogate blast-radius principle-model-the-domain; do
  rm -rf ".claude/skills/$s" && cp -r "/tmp/pstack/pstack/skills/$s" ".claude/skills/$s"
done
```

| Skill | Fires | Why this one |
|---|---|---|
| `unslop` | automatically, on any writing | Requested as mandatory. This repo carries a lot of prose: `AGENTS.md`, ADR-style schema comments, release notes. |
| `typescript-best-practices` | automatically, on any `.ts`/`.tsx` | `frontends/ui` is most of the surface area, and the file leans on discriminated unions and exhaustive switches already (`DOCUMENT_SCOPES`, `ProjectIntakeQuestionType`). |
| `how` | automatically, on "how does X work" and placement questions | Four layers can own a feature here (BFF route, `lib/` service, `aiq_api` plugin, `aiq_agent` knowledge layer). "Which layer owns this" is the recurring question. |
| `interrogate` | explicit invocation only | Adversarial multi-model review of a diff. See the adaptation note below. |
| `blast-radius` | explicit invocation only | For changes whose danger sits outside the diff. The wizard v1.0 to v1.2 renumbering is the live example: the risk is stored profiles, not the code. |
| `principle-model-the-domain` | explicit invocation only | Encode the domain in a structure instead of scattered conditionals. This is the whole argument for modelling a document's project role as a binding rather than reusing tags. |

Skills marked `disable-model-invocation: true` never trigger on their own. Ask
for them by name.

## Adaptations for Claude Code

The vendored text is written for Cursor. Two things read across:

1. Subagents. The skills say `Task` tool and `subagent_type: generalPurpose`.
   Here that is the `Agent` tool with `subagent_type: general-purpose`.
2. Model panel. `interrogate` reads a reviewer list from
   `~/.cursor/rules/pstack-models.mdc` and defaults to a cross-vendor panel
   (`gpt-5.6-sol-max`, `grok-4.6-fast-xhigh`). Neither the file nor those models
   exist here, so it falls back to Claude reviewers. The adversarial signal
   upstream comes from model diversity, so a single-vendor panel is a weaker
   version of the skill. Worth knowing before you trust a clean verdict from it.

`setup-pstack` and `poteto-mode` were deliberately left out. `poteto-mode` is the
orchestrator for the whole 44-skill set and assumes that model panel.

## One conflict with house style

`unslop` rule 13 bans em dashes outright. The rest of `AGENTS.md`, and most doc
comments in this repo, use them heavily. Only the "value driven" section was
written under the rule. Nobody has decided whether the rest should follow, and a
sweeping punctuation rewrite of existing prose is not worth a diff on its own.

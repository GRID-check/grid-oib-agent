# Skills

Every skill this repo authors, in one place. `apm` publishes them from here into
the harness directories that actually read them, so this is the only copy you
edit and the only copy git tracks.

```bash
task agents:setup   # publish this folder (and the pinned third-party skills) to every target
task agents:audit   # drift against the lock, plus a hidden-Unicode scan
```

`.claude/` and `.agents/` are generated and gitignored. A skill added here
reaches every harness by being listed in [`../apm.yml`](../apm.yml); adding a
harness is one line in that manifest's `targets`.

## Two audiences, one folder

| | Maintainer skills | API-consumer skills |
| :-- | :-- | :-- |
| **Audience** | Developers changing this repo | Users calling a running AI-Q server |
| **Examples** | `aiq-add-data-source`, `aiq-add-tool`, `aiq-release-qa`, `aiq-prepare-pr`, `aiq-maintain-ci`, `aiq-customize-prompts-models`, `aiq-definition-of-done` | `aiq-deploy`, `aiq-research` |
| **Assumes** | A repo checkout and dev toolchain | A reachable AI-Q backend |
| **Extras** | none | `skill-card.md`, `skill.oms.sig`, `evals/`, authored to be self-contained and exportable to the NVIDIA Skills catalog |

Both kinds are validated the same way and live side by side. The distinction is
about who reads them, not where they sit.

None of this is an in-product skill runtime. The deployed product remains a
research blueprint on the NeMo Agent Toolkit; nothing here is loaded or executed
by it. These exist to help coding agents and contributors work in this
repository.

## Layout

```
skills/<aiq-skill-name>/
  SKILL.md            # required: YAML frontmatter (name, description) + body
  references/*.md     # optional: linked from SKILL.md, must stay inside the bundle
```

Names are lowercase, hyphen-separated and `aiq-` prefixed. The validator
enforces it, and `tests/test_agent_skills.py` runs the validator in CI.

## Adding one

1. Copy [TEMPLATE.md](TEMPLATE.md) to `skills/<aiq-skill-name>/SKILL.md` and
   fill in the frontmatter.
2. Add `- ./skills/<aiq-skill-name>` to the `dependencies.apm` list in
   [`../apm.yml`](../apm.yml).
3. Run `task agents:setup`, which publishes it to every target.
4. Run `uv run python scripts/validate_skills.py` to check the bundle.

Write it against [`../docs/contributing/`](../docs/contributing/README.md) —
`writing-for-agents` is installed and fires when you touch a `SKILL.md`.

# Skills

The skills this repo authors for coding agents. `apm` publishes them from here
into the harness directories that read them, so this is the only copy you edit
and the only copy git tracks.

```bash
task agents:setup   # publish this folder (and the pinned third-party skills) to every target
task agents:audit   # drift against the lock, plus a hidden-Unicode scan
```

`.claude/` and `.agents/` are generated and gitignored. A skill added here
reaches every harness by being listed in [`../apm.yml`](../apm.yml).

A procedure is a skill here only when it is agent-specific; everything a
contributor needs as much as an agent is documentation. The rule and the audit
that applied it:
[`../docs/contributing/agent-skills.md`](../docs/contributing/agent-skills.md#skill-or-document).
Today that leaves `aiq-research`, which drives a running backend through
`scripts/aiq.py`. Its `skill-card.md`, `skill.oms.sig`, `BENCHMARK.md` and
`evals/` come from the NVIDIA Skills catalog it was first published to.

Piloti's own skills, the ones the product reads at run time, are a different
thing and live in `src/aiq_agent/skills/` (ADR-0046).

## Adding one

1. Create `skills/<aiq-skill-name>/SKILL.md` with YAML frontmatter (`name`,
   `description`) and a body; longer material goes in `references/*.md`
   beside it, linked from `SKILL.md`, and must stay inside the bundle.
2. Add `- ./skills/<aiq-skill-name>` to `dependencies.apm` in
   [`../apm.yml`](../apm.yml).
3. Run `task agents:audit` until it passes, and commit `apm.lock.yaml` with
   the skill.
4. Run `.venv/bin/python scripts/validate_skills.py` to check the bundle.

Names are lowercase, hyphen-separated and `aiq-` prefixed; the validator
enforces it, and `tests/test_agent_skills.py` runs the validator in CI. The
`writing-for-agents` skill fires when you touch a `SKILL.md`.

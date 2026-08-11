# Vendored review rulebooks

This directory holds third-party rulebooks that GRID's own reviewers *read*. It
is deliberately **not** `../builtin/`: `discover_builtin_skills` globs
`builtin/*/*/SKILL.md` and hands everything it finds to agents as an invocable
skill. What lives here is a rulebook for a reviewer, not a capability any agent
may call, and putting it one directory over would have published it to every
agent in the platform.

## `skill-check/SKILL.md`

| | |
|---|---|
| Source | <https://raw.githubusercontent.com/olgasafonova/SkillCheck-Free/main/skills/skill-check/SKILL.md> |
| Upstream | <https://github.com/olgasafonova/SkillCheck-Free> |
| Version | `3.28.0` (from the file's own frontmatter `metadata.version`) |
| Author | `olgasafonova` |
| Licence | MIT (declared in the file's frontmatter `license: MIT`) |

The file is vendored **verbatim**, frontmatter included, so the licence and the
author travel with the content rather than living only in this README. Do not
edit it: any local change belongs in the code that consumes it
(`frontends/aiq_api/src/aiq_api/routes/skill_review.py`), which strips the
frontmatter and the upsell paragraph at import time and leaves the rules alone.
To take a newer upstream version, re-download the file and bump the Version row
above.

### Why vendored instead of fetched at runtime

Two reasons, and either alone would be enough:

1. **Reproducibility.** The `/v1/skills/review` endpoint is graded output — an
   author reads its findings and rewrites their skill accordingly. A reviewer
   whose rules can change under it, without a commit, cannot be reasoned about:
   the same skill would draw different findings on Tuesday than on Monday and
   nobody could say why, or which version produced the advice already acted on.
   Pinning the rulebook to a reviewed commit makes a review reproducible and
   makes a rule change something that shows up in a diff.
2. **No network guarantee.** The backend is not promised egress to
   raw.githubusercontent.com — deployments run behind egress policies, and the
   review path is already fail-open for LLM outages. Fetching at import time
   would turn somebody else's CDN into a hard boot dependency of the API; the
   rules are ~15 KB of text, so keeping them on disk costs nothing worth
   spending a failure mode on.

# Release notes

Every change a customer can notice ships with a release note, in the same pull
request that makes the change. The notes are published — automatically, in
German and English — to the changelog on the marketing site.

- **Tool:** [reno](https://docs.openstack.org/reno/latest/), OpenStack's release-note
  manager. One YAML file per change, under `releasenotes/notes/`.
- **Rule:** [AGENTS.md](../../AGENTS.md) — "Release notes are mandatory".
  Enforced on every PR by the **Release note** job in
  [`ci.yml`](../../.github/workflows/ci.yml).
- **Destination:** `https://piloti.at/changelog` (de) and `/en/changelog` (en).

## Writing one

```bash
task release:note -- re-index-projects      # creates releasenotes/notes/re-index-projects-<hash>.yaml
$EDITOR releasenotes/notes/re-index-projects-*.yaml
task release:lint                           # the same check CI runs
```

reno picks the filename — a slug plus a random suffix — which is why two
branches never collide on the same note file even when they both add one.

Keep exactly the sections you need and delete the rest:

```yaml
---
features:
  - >
    Projects can now be re-indexed from the settings page. Documents that failed
    to process the first time are picked up without contacting support.
```

| Section | For |
|---|---|
| `features` | Something the reader could not do before |
| `improvements` | Something they already had, now better |
| `fixes` | Something that used to go wrong |
| `security` | Only what a customer must know; never exploit detail |
| `deprecations` | What is going away, and what replaces it |
| `upgrade` | Only when the reader has to do something themselves |
| `other` | Genuinely user-visible, fits nowhere above |
| `prelude` | A short summary for a whole release. Rarely needed. |

The section list lives in [`releasenotes/config.yaml`](../../releasenotes/config.yaml);
its German headings live in `SECTION_TITLES_DE` in
[`scripts/release_notes.py`](../../scripts/release_notes.py), and a test fails if
the two drift apart.

## The house rules

A note is **published verbatim to a public page**, so it is marketing copy that
happens to live in the repository. `task release:lint` enforces the mechanical
half; the rest is judgement.

- Write for the architect using Piloti, not for the reviewer of your diff.
  Say what they can now do, or what stopped going wrong for them.
- Plain sentences, ending in punctuation. Two is usually right, 400 characters
  is the ceiling.
- No reStructuredText, no backticks, no code fences — the page renders plain text.
- No issue numbers, commit shas, file names, repository paths, module names, or
  links to anything but piloti.at.
- English. The German version is produced by the publish step (see below), so
  write the English one as though it were the only one.

Rejected by the lint, and why:

```yaml
fixes:
  - Fixed #1423.                                      # issue number, and says nothing
  - Re-index in `ProjectSettings.tsx` no longer throws.  # internal names, backticks
  - Improved performance.                             # too short to mean anything
```

## What happens on merge

1. The PR merges to `develop`.
2. [`release-notes.yml`](../../.github/workflows/release-notes.yml) runs
   `scripts/release_notes.py publish`: reno reads the notes **through git
   history**, so a note is attributed to the release it actually shipped in;
   each new English sentence is translated into German once and cached in
   `releasenotes/translations/de.json`.
3. The regenerated `frontends/web/src/data/changelog.json` is committed back to
   `develop`. Publishing runs on pushes to `develop` only, and the push is
   authenticated as the `RELEASE_PAT` owner when that secret is set (falling
   back to `GITHUB_TOKEN`), because the branch ruleset requires changes to
   arrive via pull request.
4. That commit rebuilds the web image, the staging deploy rolls it out, and the
   note is on the site.

Until the repository starts tagging releases, notes are grouped on the page by
the **day they shipped**. Once `git tag` produces versions, notes group under
their version instead — no configuration change needed.

### Translation

`OPENROUTER_API_KEY` (repository secret) drives the translation, with
`RELEASE_NOTES_TRANSLATION_MODEL` (repository variable) selecting the model.
`releasenotes/translations/de.json` holds one `{"en": …, "de": …}` pair per
sentence, sorted by the English text, so a note is paid for once and an unchanged
note is never re-translated. (The lookup key is derived from the English text on
load rather than stored: a digest sitting in a JSON file reads as a credential to
every secret scanner, and JSON cannot carry an inline allowlist pragma.)

Without the key the pipeline still runs and publishes the English text on the
German page, with a warning in the log.

To fix a machine translation, edit the German side of the entry in
`releasenotes/translations/de.json` and run `task release:changelog` — the cache
is the source of truth and the translator never overwrites an entry that exists.

### The generated file

`frontends/web/src/data/changelog.json` is generated. Do not edit it; if two
branches conflict in it, regenerate rather than hand-merge:

```bash
task release:changelog
```

It is committed rather than built on demand because reno needs git history and
the web image is built from a bare working tree.

## Setup checklist (once, per repository)

- [ ] Repository secret `OPENROUTER_API_KEY` — otherwise the German page shows English.
- [ ] Repository secret `RELEASE_PAT` — a fine-grained PAT with `contents: write`
      on this repository, owned by an admin whose RepositoryRole bypass is listed
      on the `develop` rulesets (the ruleset requires pull requests, and GitHub
      refuses the Actions integration as a bypass actor). Without it the publish
      push falls back to `GITHUB_TOKEN`.
- [ ] A `no-release-note` label exists, for changes no user can observe.

## Commands

| Command | What it does |
|---|---|
| `task release:note -- <slug>` | Start a note |
| `task release:lint` | House rules + `reno lint` (CI runs both) |
| `task release:preview` | reno's own report, grouped by release |
| `task release:changelog` | Regenerate the website artifact |

# Release notes

Every change a customer can notice ships with a release note, in the same pull
request that makes the change. The notes are published to the changelog on the
marketing site, automatically, in German and English.

- **Tool:** [reno](https://docs.openstack.org/reno/latest/), OpenStack's release-note
  manager. One YAML file per change, under `releasenotes/notes/`.
- **Rule:** [AGENTS.md](../../AGENTS.md), the "Change what a customer can notice"
  row. Enforced on every PR by the **Release note** job in
  [`ci.yml`](../../.github/workflows/ci.yml), which goes by file, not by what
  the diff does: a PR that touches a product file
  ([`ci/require_release_note.py`](../../ci/require_release_note.py)) and adds
  no note fails. A change no user can notice, a comment or a refactor, takes
  the `no-release-note` label instead.
- **Destination:** `https://piloti.at/changelog` (de) and `/en/changelog` (en).
- **Reader:** the architect using Piloti. Not the reviewer of your diff, and not
  the people who run the platform.

## Writing one

```bash
task release:note -- re-index-projects      # creates releasenotes/notes/re-index-projects-<hash>.yaml
$EDITOR releasenotes/notes/re-index-projects-*.yaml
task release:lint                           # the same check CI runs
```

reno picks the filename, a slug plus a random suffix, which is why two
branches never collide on the same note file even when they both add one.

Keep exactly the sections you need and delete the rest:

```yaml
---
features:
  - >
    Projects can now be re-indexed from the settings page, so documents that
    failed the first time are picked up without contacting support.
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
| `operators` | **Never published.** Only the people running the platform can act on it |
| `prelude` | Rarely: a summary for a tagged release. Weeks use `summaries.yaml` |

The section list lives in [`releasenotes/config.yaml`](../../releasenotes/config.yaml);
its German headings live in `SECTION_TITLES_DE` in
[`scripts/release_notes.py`](../../scripts/release_notes.py), and a test fails if
the two drift apart. `INTERNAL_SECTIONS` in the same script is what keeps
`operators` off the page.

## The house rules

A note is **published verbatim to a public page**, so it is marketing copy that
happens to live in the repository. `task release:lint` enforces every rule
marked *lint*, and each failure says how to fix it.

1. **English.** *(lint)* The German page is translated from the English. A note
   written in German used to be published as the "English" text and then
   translated from German into German, which is how 344 German sentences ended
   up on `/en/changelog`. The check counts German and English function words
   outside quotation marks, so an English note may quote a German label such as
   „Von Piloti erstellt“. It agrees with `py3langid` on every note in the repo.
2. **For the architect.** Say what they can now do, or what stopped going wrong
   for them. Not how you did it.
3. **At most two sentences and 400 characters.** *(lint)* One for what
   changed, one for why it matters. An unrelated change gets its own entry;
   the mechanism goes in the PR description.
4. **No internal names.** *(lint, in part)* No issue numbers, commit shas, file
   names, repository paths, module or component names, and no links other than
   piloti.at. Name things the way the UI names them.
5. **Plain text.** *(lint)* No reStructuredText, backticks or code fences.
6. **Operators go under `operators`.** *(lint)* The Platform area, model
   defaults, deployment, migration or environment settings: nobody in an
   architecture office can act on them. Phrasing such as "platform operators",
   "Platform →", "new installations" or "environment variable" outside that
   section fails the lint. Office administrators (roles, budgets, the
   organization's instructions) are customers; their notes stay public.

### Good and bad

```yaml
features:
  # Good: what the reader can do, in the words of the UI.
  - >
    Whole folders can now be uploaded, with Ordner hochladen or by dragging the
    folder onto the file list. Files Piloti cannot read are rejected one by one.

  # Bad: German. Write the English; keep your German for de.json (see below).
  - >
    Ganze Ordner lassen sich jetzt hochladen.

fixes:
  # Good: the effect, then why it matters.
  - >
    Uploading a corrected plan under the same name now replaces the old one
    instead of adding a second copy that Piloti could no longer find.

  # Bad: the mechanism, and a module name.
  - >
    The ingest dedup now keys on filename, so RerankStage no longer sees stale
    chunks.

  # Bad: three sentences retelling the bug.
  - >
    Uploads failed. The cause was a race in the upload queue. It is fixed.

operators:
  # Right section: only the people running the platform can act on it.
  - >
    The reasoning effort set under Platform → Models now applies to every
    agent, within a minute of saving.
```

### If you wrote the German first

Keep it. Write the English note, then add the pair to
`releasenotes/translations/de.json` (`{"en": "<your English>", "de": "<your
German>"}`); the publish step uses a cached translation instead of calling the
translator. Hand-written German beats machine German; it is how the notes
rewritten in September 2026 kept their authors' wording.

## Weekly groups and summaries

Nothing is tagged yet, so the changelog groups notes by the **ISO week** they
shipped in (`2026-W39`, Monday to Sunday). Once `git tag` produces versions,
notes group under their version instead, with no configuration change.

A note's week is the day of the **commit that first added the file** (renames
keep it). reno itself hands back the sha of a note's latest revision, so before
this, correcting a typo in an August note moved it to the week of the fix. Now
an old note can be edited freely: reno publishes the new text, and the note
stays where it shipped.

Each week can carry a short summary above its notes, in
[`releasenotes/summaries.yaml`](../../releasenotes/summaries.yaml), keyed by the
week id. It is written by a person after the week: what an architect would tell
a colleague about it. English, at most three sentences and 500 characters,
linted and translated like a note. A week without an entry shows its notes only.

## What happens on merge

1. The PR merges to `develop`.
2. [`release-notes.yml`](../../.github/workflows/release-notes.yml) runs
   `scripts/release_notes.py publish`: reno reads the notes **through git
   history**; each new English sentence is translated into German once and
   cached in `releasenotes/translations/de.json`.
3. The regenerated `frontends/web/src/data/changelog.json` is committed back to
   `develop`. Publishing runs on pushes to `develop` only, and the push is
   authenticated as the `RELEASE_PAT` owner when that secret is set (falling
   back to `GITHUB_TOKEN`), because the branch ruleset requires changes to
   arrive via pull request.
4. That commit rebuilds the web image, the staging deploy rolls it out, and the
   note is on the site.

### Translation

`OPENROUTER_API_KEY` (repository secret) drives the translation, with
`RELEASE_NOTES_TRANSLATION_MODEL` (repository variable) selecting the model.
`releasenotes/translations/de.json` holds one `{"en": …, "de": …}` pair per
sentence, sorted by the English text, so a note is paid for once and an unchanged
note is never re-translated. (The lookup key is derived from the English text on
load rather than stored: a digest sitting in a JSON file reads as a credential to
every secret scanner, and JSON cannot carry an inline allowlist pragma.)

Changing a note's English makes it a new sentence: the next publish translates
it and prunes the old pair. Without the key the pipeline still runs and
publishes the English text on the German page, with a warning in the log.

German on the page follows German typography: „…“ quotes and the spaced
Gedankenstrich (–), never the English em dash. To fix a machine translation,
edit the German side of the entry in `de.json` and run `task release:changelog`.
The cache is the source of truth and the translator never overwrites an entry
that exists.

### The generated file

`frontends/web/src/data/changelog.json` is generated. Do not edit it; if two
branches conflict in it, regenerate rather than hand-merge:

```bash
task release:changelog
```

It is committed rather than built on demand because reno needs git history and
the web image is built from a bare working tree. It needs a full clone: in a
shallow one reno fails with a `KeyError` on a missing commit
(`git fetch --unshallow`).

## Setup checklist (once, per repository)

- [ ] Repository secret `OPENROUTER_API_KEY`, without which the German page shows English.
- [ ] Repository secret `RELEASE_PAT`, a fine-grained PAT with `contents: write`
      on this repository, owned by an admin whose RepositoryRole bypass is listed
      on the `develop` rulesets (the ruleset requires pull requests, and GitHub
      refuses the Actions integration as a bypass actor). Without it the publish
      push falls back to `GITHUB_TOKEN`.
- [ ] A `no-release-note` label exists, for changes no user can observe.

## Commands

| Command | What it does |
|---|---|
| `task release:note -- <slug>` | Start a note |
| `task release:lint` | House rules + `reno lint` (CI runs both); also checks `summaries.yaml` |
| `task release:preview` | reno's own report, grouped by release, `operators` included |
| `task release:changelog` | Regenerate the website artifact |

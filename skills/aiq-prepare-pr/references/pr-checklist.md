# AI-Q PR checklist and bot commands

Step-by-step companion to `SKILL.md`. The source of truth is `CONTRIBUTING.md`
and `.github/pull_request_template.md`; this file condenses them into an
actionable checklist.

## 1. Scope and branch

- Branch is created from `develop` and named for the change.
- The diff contains only files relevant to this change — no unrelated
  refactors, no formatting churn on untouched files, no generated artifacts.
- No secrets, credentials, private hostnames, internal-only logs, or customer
  data are included.

```bash
git diff --name-only origin/develop..HEAD   # confirm the file set
git status --porcelain                      # confirm a clean tree
```

## 2. DCO sign-off

Every commit must carry a `Signed-off-by: Your Name <your@email.com>` trailer.

```bash
git commit -s -m "Concise, scoped change"   # sign as you commit
git commit --amend -s --no-edit             # sign the latest commit
git rebase --signoff origin/develop         # sign a range already committed
```

Verify the count matches your commits:

```bash
git log --pretty=full origin/develop..HEAD | grep -c "Signed-off-by:"
```

## 3. Validation evidence

Run the checks with `aiq-release-qa` and keep the exact commands and output.
Paste them into the PR's Validation section — do not summarize as "ran tests".

## 4. Open the PR

- Target branch is `develop`.
- Fill every section of `.github/pull_request_template.md`:
  - **Overview** — what changed and why.
  - **Validation** — the exact commands, output, workflow links, or screenshots.
  - **Where should reviewers start?** — the key file, test, or decision.
  - **Related Issues** — `Closes`/`Fixes`/`Relates to #...`.
- Tick each checklist item you can honestly tick (local checks, tests added,
  docs updated, no secrets, DCO sign-off).

## 5. CI and merge flow

This repo is private: CI runs **directly on the PR** (`pull_request` events on
`.github/workflows/ci.yml`) — there is no copy-pr-bot mirror, no `/ok to test`,
no `/merge` bot (those are upstream NVIDIA AI-Q conventions that were removed
here; see `ci.yml`'s header comment). Pushing the branch updates the PR checks
automatically; the `ci-ok` gate is the required status check.

## 6. Review loop

Address feedback until required checks pass and code-owner review is approved.
Keep new commits signed; re-run the relevant `aiq-release-qa` checks after
substantive changes and update the Validation section if results change.

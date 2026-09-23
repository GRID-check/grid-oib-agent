# Visual screenshots (UI evidence)

A user-visible change is "done" only with visual evidence (see the
`aiq-definition-of-done` skill). That evidence goes **in the pull request**, as
an attachment. Nothing is committed to the repo.

- **Capture:** the `agent-browser` skill — a native CLI driving a real Chrome.
- **Publish:** the `before-and-after` skill — formats the media and uploads it
  with `gh --attach`.
- **Targets:** the `/dev/*` preview routes under `frontends/ui/src/app/dev/`.
- **Committed artifacts:** none. That is the point.

Both skills are pinned in [`apm.yml`](../../apm.yml) and deployed by
`task agents:setup`. `before-and-after` lands at `.claude/skills/skill/`, not
`before-and-after/` — see the note in `apm.yml` for why.

## Why it is not a harness any more

The repo used to carry `frontends/ui/visual/`: a registry of 178 targets, a
capture harness, and 620 committed PNGs. It was removed because of what it cost
against what it bought.

It bought less than it looked like. **Nothing compared anything** — there was no
pixel diff anywhere in the repo, so the PNGs were never regression baselines.
The `visual-coverage` workflow only checked that a *new* `.png` file appeared in
a PR; it never opened one. Evidence reached reviewers as an `upload-artifact`
ZIP they had to download and unzip. Two PNGs out of 620 were cited by a doc.

It cost 620 files and 187 MB in the tree, and 348 MB of a 462 MB `.git` — 1303
blob versions across 33 regeneration commits. PNGs do not delta-compress, so
every regeneration stored every changed file in full, forever, in every clone.

An attachment gives a reviewer the image inline, in the place they are already
looking, and costs the repository nothing.

> The 348 MB is still in history. Deleting the files stopped the growth; it did
> not shrink existing clones. Only a history rewrite does that, and that is a
> force-push and a re-clone for everybody — a deliberate, scheduled operation,
> not something to slip into a feature branch.

## Setup, once per machine

```bash
npm install -g agent-browser
agent-browser install          # downloads its own Chrome for Testing
```

On Linux, `agent-browser install --with-deps` if the browser fails to launch.
`gh` must be **2.99 or newer** — `--attach` does not exist before that.

```bash
gh --version
```

## Capture

Start the dev server, then drive it. The preview routes render real components
from fixtures, so nothing else needs to be running.

```bash
cd frontends/ui && bun run dev        # or: npx next dev --turbopack -p 3311
```

Ask the agent-browser skill for its own command reference before you improvise —
it is version-matched to the installed CLI, where these examples are not:

```bash
agent-browser skills get core --full
```

The recipe that reproduces what the old harness produced per target:

```bash
agent-browser open http://localhost:3311/dev/cards

# desktop, light
agent-browser set viewport 1200 900
agent-browser screenshot --full before-cards.light.png

# desktop, dark — BOTH the media query and the class, see below
agent-browser set media dark
agent-browser eval "document.documentElement.classList.add('dark')"
agent-browser screenshot --full before-cards.dark.png

# phone
agent-browser set viewport 390 844
agent-browser screenshot before-cards.mobile.png

agent-browser close --all
```

**Dark mode needs two things, not one.** The app keys off a `.dark` class as
well as `prefers-color-scheme`. `set media dark` alone flips the media query and
leaves the class behind, and you get a half-themed screenshot that looks like a
bug in the component. Set both, in that order, and give the repaint a moment
before capturing.

**Capture `--full` for anything taller than the viewport.** Before/after pairs
are laid out side by side, and equal-height full-page captures are what keeps
their tops aligned.

**The Next.js dev indicator is in the shot.** The floating badge in the bottom
corner is dev-server chrome, not your component. Turn it off in
`next.config.ts` (`devIndicators: false`) for a capture run, or crop it.

## Publish

Capture a *before* from the base branch and an *after* from yours, then hand
both to the `before-and-after` skill. It writes one marked block into the PR
description and replaces that block on later runs, leaving the rest of your
prose alone.

The upload is `gh --attach`, which needs push access to the repository. The
underlying call, if you are doing it by hand:

```bash
gh pr comment 123 --attach './after.png#Cards gallery, dark'
```

Alt text goes after a `#`. The flag repeats, but not for the same file twice.
PNG, JPEG, GIF, WebP, SVG, MP4, MOV and WebM all work.

## What is gone, and what replaced it

| Was | Now |
|---|---|
| `task fe:screenshots` | `agent-browser screenshot` against a running dev server |
| `visual/registry.mjs` targets | the `/dev/*` routes themselves; no second list to keep in sync |
| Committed PNGs under `visual/screenshots/` | attachments on the PR |
| `visual-coverage` workflow | the **Visual evidence** workflow, which reads the PR BODY for the block rather than counting `.png` files in the diff |
| `screenshot-preview` workflow and its bot commits | nothing; nobody commits screenshots |
| `visual/screenshots.manifest.json` staleness gate | nothing. A capture is taken against the branch under review, so it cannot go stale |
| `task fe:touch-audit` | **nothing.** It imported the registry, so it went with it |

That last row is a real loss, not a migration. `touch-audit.mjs` measured every
`/dev` surface at a phone viewport and reported overflow, scroll traps and
sub-44px targets — things a screenshot does not show you.
`mobile-affordances.spec.ts` still holds the static half of that contract. If
the browser measurement is wanted back, it wants writing again as a script that
discovers routes from `src/app/dev/` rather than from a registry.

## Agents

Both skills carry their own instructions and fire on their own. Read them rather
than this file for command detail; this page is the repo's policy, they are the
tools' manuals.

**Paused.** The check step in `.github/workflows/visual-evidence.yml` is
commented out: the job runs and passes, and the capture is a reviewer's ask
rather than a gate. Restoring the two commented lines re-enables what follows.

When enforced, a PR touching `components/`, `features/`, `app/` or a
stylesheet fails the **Visual evidence** workflow unless its body carries a
non-empty `before-and-after` block. That workflow also wakes on a description
edit, so adding the block clears the check without needing another commit —
which is the whole reason it is not a step inside `ci.yml`. If the change really moves no
pixels, say so where the reviewer reads it — the reason is required:

```
<!-- no-visual-evidence: renamed a prop, no rendered output changes -->
```

Exempt without asking: specs, mocks, fixtures, `.d.ts`, `/dev/*` previews (they
are the capture target), and `app/api/**` and `route.ts` handlers, which live
under `app/` but return JSON.

The one rule that is this repo's and not theirs: **do not commit image files as
evidence.** If a capture belongs anywhere permanent, it belongs in a doc that
explains it, and that is a deliberate decision to argue for in review — not the
default, and never a gallery.

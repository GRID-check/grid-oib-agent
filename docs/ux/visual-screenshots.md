# Visual screenshots (UI evidence framework)

User-visible changes are "done" only with a screenshot as evidence (see the
`definition-of-done` skill). This repo has a small, reproducible screenshot
harness so that evidence is a committed artifact, not a one-off manual capture.

- **Harness:** `frontends/ui/visual/capture.mjs`
- **Registry (what gets captured):** `frontends/ui/visual/registry.mjs`
- **Output (committed PNGs):** `frontends/ui/visual/screenshots/<id>.<light|dark>.png`
- **Run:** `cd frontends/ui && npm run screenshots` (optionally `-- <id>` to filter)

## How it works

Each target points at a **self-contained `/dev/*` preview route** that renders a
real component with fixture data and **no backend**. The harness boots
`next dev`, visits each route in light and dark, and writes a retina PNG per
theme. Because the preview routes are backend-free, the screenshots are
reproducible in CI and locally.

```bash
cd frontends/ui
npm run screenshots                       # boot next dev, capture every target
npm run screenshots -- document-grid      # only the matching target id(s)
BASE_URL=http://localhost:3000 npm run screenshots   # reuse a running server
npm run screenshots -- composer --mobile  # also capture the mobile variant
npm run screenshots -- --mobile-only      # capture ONLY the mobile variants
```

### Mobile variant

Every desktop shot has an optional mobile twin, captured at a 390×844 phone
viewport with `isMobile`/`hasTouch` (viewport meta + touch heuristics match a
real device) and written as `<id>.mobile.<theme>.png`. It is produced when:

- the target opts in with `mobile: true` in the registry (captured on every run), or
- you pass `--mobile` (adds the mobile variant to whatever targets you selected), or
- you pass `--mobile-only` (captures the mobile variant and skips desktop).

Mobile is a first-class surface here — a change to any responsive layout is not
done (see the definition-of-done skill) until its mobile twin has been reviewed
in light and dark, the same bar as desktop.

## Adding a new screenshot target

1. **Build a dev preview route** under `src/app/dev/<name>/page.tsx`:
   - Mark it `'use client'` and call `notFound()` when `process.env.NODE_ENV !== 'development'` (dev previews must not exist in production).
   - Render the **real** component with realistic fixture props.
   - If the component fetches data, install a **fetch shim** (see gotchas) so it renders fully resolved without a backend.
   - The card gallery `src/app/dev/cards/page.tsx` is the reference for a pure (fetch-free) preview; `src/app/dev/document-grid/page.tsx` is the reference for a preview that shims fetch.
2. **Add the target** to `frontends/ui/visual/registry.mjs` with an `id`, `path`, `description`, and a `waitFor` selector that only appears once the surface has rendered (e.g. a `data-testid`).
   - **Capturing a `:focus-visible` state?** Add `tabStops: <n>` — the harness presses Tab that many times before the shot so keyboard focus (and only keyboard focus) engages `:focus-visible`. The `focus-ring` target uses this to guard the rounded focus outline (Tab 1 is the layout's "Skip to content" link, Tab 2 the first control). Programmatic `.focus()` is deliberately not used because it doesn't reliably trigger `:focus-visible`.
3. **Run** `npm run screenshots -- <id>` and commit the resulting PNGs alongside the change.
4. **PR preview (automatic):** when the PR diff adds a new target id to the
   registry, the `screenshot-preview` workflow (`.github/workflows/screenshot-preview.yml`)
   captures just those new ids and posts the PNGs (desktop + mobile, light +
   dark) as a **sticky PR comment** — so reviewers see the rendered surface
   without checking out the branch. The comment images are served from the
   `screenshot-previews` branch (`pr-<number>/`); the workflow is informational
   only and never blocks the PR. It runs for same-repo PRs only (fork tokens
   are read-only and cannot receive comments).

## Visual coverage gate (CI)

A new **user-visible component** (`frontends/ui/src/features/**/components/**`,
`frontends/ui/src/components/**` — excluding `components/ui` primitives and
spec files) is expected to ship with visual evidence in the same PR: a
`/dev/<name>` preview route + a registry target + committed PNGs. The
`visual-coverage` workflow (`.github/workflows/visual-coverage.yml`) checks
this on every PR that adds components:

- **Phase 1 (current): comment-only.** If the PR adds a component but no new
  registry target and no new `/dev/*` route, it posts a sticky nudge comment
  listing the uncovered files. It never blocks the PR — flip it to a required
  check once the noise is tuned (same phased rollout as Semgrep/OSV).
- **Escape hatch:** a component that genuinely is not a user-visible surface
  (internal wrapper, logic-only helper) opts out with a
  `// no-visual: <reason>` marker comment in the file.

## Gotchas learned the hard way (keep these here, not in your head)

- **Dark mode is a `.dark` class on `<html>`, not `data-theme`.** The token
  stylesheet keys off `.dark` (`src/app/globals.css`: `@custom-variant dark
  (&:is(.dark *))`); light is the default (no class). The theme is applied by a
  `useThemeEffect` in `src/app/providers.tsx` that toggles that class (default
  mode is `system`, which follows `prefers-color-scheme`). The harness therefore
  sets **both** the Playwright `colorScheme` (so `system` resolves correctly)
  **and** force-toggles `document.documentElement.classList.toggle('dark', …)`
  after load for a deterministic result. To theme-check any component in a
  browser console: `document.documentElement.classList.toggle('dark')`.
- **Dev preview pages 404 outside development.** They call `notFound()` unless
  `NODE_ENV === 'development'`, so they never ship. The harness runs `next dev`
  (not a production build) for exactly this reason.
- **Fetch shims must be installed at module scope, not in a `useEffect`.** React
  runs a child's effects *before* the parent's, so a data-fetching child fires
  its request before a parent effect could install a shim — the shim races and
  loses. Install it at module top-level, guarded by
  `typeof window !== 'undefined' && process.env.NODE_ENV === 'development'`, and
  make it idempotent (a `window.__…Shim` flag). See
  `src/app/dev/document-grid/page.tsx`.
- **Thumbnails 404 → deterministic SVG sketch fallback.** The file cards fetch
  `/api/documents/{id}/thumbnail`; when the shim returns 404 the content-aware
  `DocumentKindThumbnail` sketch renders instead — backend-free and stable
  across runs (no presigned-URL churn), which is exactly what you want for a
  reproducible screenshot.
- **Chromium is pre-installed; do not download it.** `PLAYWRIGHT_BROWSERS_PATH`
  points at `/opt/pw-browsers` (`chromium-<rev>/chrome-linux/chrome`), and
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set. The harness uses `playwright-core`
  and resolves that binary via `executablePath`; override with `CHROMIUM_PATH`
  if resolution fails. `--no-sandbox` is required in the container.
- **Wait for `networkidle` *and* the `waitFor` selector.** `next dev` compiles
  routes lazily, so the first navigation to a route is slow (generous 120s goto
  timeout). Waiting only for load fires before the resolution fetch settles;
  wait for the target selector too, then a short settle delay for fonts.
- **`deviceScaleFactor: 2`** gives retina-quality PNGs; drop it if diffs get
  noisy.
- **Never put `border-radius: inherit` in the global `:focus-visible` rule.** A
  CSS `outline` already follows the focused element's *own* `border-radius` in
  every browser we target, so it needs no help. `border-radius: inherit`
  actively breaks it: it overrides the control's radius with its **parent's**
  (usually `0`), so a `rounded-xl` input/select **squares off the moment it's
  focused**. The `focus-ring` screenshot target exists to catch exactly this
  regression — keep `src/app/globals.css` `:focus-visible` to `outline` +
  `outline-offset` only.

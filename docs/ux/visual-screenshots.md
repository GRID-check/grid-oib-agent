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
real component with fixture data and **no backend**. The harness runs the route
under `next dev` (booting a server or reusing a running one), visits it once per
viewport, and writes a retina PNG per theme. Because the preview routes are
backend-free, the screenshots are reproducible in CI and locally.

```bash
cd frontends/ui
npm run screenshots                       # boot next dev, capture every target
npm run screenshots -- document-grid      # only the matching target id(s)
BASE_URL=http://localhost:3000 npm run screenshots   # reuse a running server
npm run screenshots -- composer --mobile  # also capture the mobile variant
npm run screenshots -- --mobile-only      # capture ONLY the mobile variants
```

### Speed (and the fast inner loop)

Startup — booting `next dev` and letting it compile the route on demand —
dominates a small run, so the harness works to pay it once:

- **An already-running `next dev` for this app is reused.** The harness reads
  `.next/dev/lock` (Next records the live server there), checks the process is
  alive and that the first target route answers `200` without a redirect, and
  attaches to it. A server that gates `/dev/*` behind auth fails that probe and
  is ignored rather than silently screenshotted as a sign-in page.
- **`SCREENSHOT_KEEP_SERVER=1` leaves the harness's own server up** when it
  finishes, so the next run attaches instead of booting. This is the loop you
  want while iterating on one component:

  ```bash
  SCREENSHOT_KEEP_SERVER=1 npm run screenshots -- composer   # first run boots
  npm run screenshots -- composer                            # reuses it
  ```

  Take the server down with `kill $(node -p "require('./.next/dev/lock').pid")`
  (or just let the next `--no-reuse` run replace it).
- **From cold, routes are pre-compiled while Chromium launches** — the harness
  fires a plain `fetch` at every distinct target path in parallel with
  `chromium.launch()`, so the dev server's compile overlaps the browser boot
  instead of stalling the first navigation of every route.
- **Each page is loaded once per viewport, not once per theme.** Light and dark
  come off the same load by flipping Playwright's `colorScheme` and the `.dark`
  class, which halves the navigations.
- **Targets are captured by a worker pool** (`SCREENSHOT_CONCURRENCY`, default
  about half the cores).

| Env var | Default | Purpose |
|---------|---------|---------|
| `SCREENSHOT_CONCURRENCY` | `min(4, max(2, cores/2))` | Pages captured in parallel |
| `SCREENSHOT_KEEP_SERVER` | unset | `1` leaves the dev server up for the next run |
| `SCREENSHOT_NO_REUSE` | unset | `1` always boots a private server (what CI does not need, but useful when a stale server is misbehaving) |
| `SCREENSHOT_NETWORK_IDLE_MS` | `5000` | Cap on the quiet-network wait per load |
| `SCREENSHOT_SETTLE_MS` | `400` | Settle after the page is ready, before the first shot |
| `SCREENSHOT_THEME_SETTLE_MS` | `150` | Settle after flipping the theme (repaint only) |
| `BASE_URL` | unset | Capture against an explicit server, skipping detection entirely |

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
   captures just those new ids (desktop + mobile, light + dark), uploads them as
   the `screenshot-previews` artifact and links it from a **sticky PR comment**,
   so reviewers get the rendered surface without checking out the branch.
   The comment *links* the PNGs instead of embedding them because this
   repository is **private**: GitHub renders comment images through an anonymous
   proxy that 404s on every URL into a private repo, so inline previews are not
   possible here (an earlier revision pushed the PNGs to a `screenshot-previews`
   branch and referenced `raw.githubusercontent.com`; it could only ever have
   rendered broken images). Committing the PNGs in step 3 remains the way
   reviewers see them rendered, in the diff. The workflow is informational only
   and never blocks the PR, and it runs for same-repo PRs only (fork tokens are
   read-only and cannot receive comments).

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
- **Chromium is pre-installed; do not download it** — *in the dev container*.
  There `PLAYWRIGHT_BROWSERS_PATH` points at `/opt/pw-browsers`
  (`chromium-<rev>/chrome-linux/chrome`) and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  is set. The harness uses `playwright-core` and resolves that binary via
  `executablePath`; override with `CHROMIUM_PATH` if resolution fails.
  `--no-sandbox` is required in the container. **CI runners ship no such
  browser**, so `.github/workflows/screenshot-preview.yml` runs
  `npx playwright-core install chromium` once per lockfile (cached in
  `~/.cache/ms-playwright`) and the harness falls back to Playwright's own path.
- **Never stage CI output in a dot-directory.** `actions/upload-artifact@v4`
  skips hidden paths unless `include-hidden-files: true`, and with
  `if-no-files-found: ignore` it does so *silently*: the preview job copied four
  PNGs into `.preview-out`, logged them, uploaded an empty artifact and every
  preview comment then reported "produced no files". Stage into `preview-out`.
- **Readiness is a gate with four parts, and dropping any one of them makes the
  PNGs flaky.** `next dev` compiles routes lazily, so the first navigation to a
  route is slow (generous 120s goto timeout), and waiting only for load fires
  before the fixture fetch settles. After `domcontentloaded` the harness waits
  for: the target's `waitFor` selector, a **bounded** `networkidle`
  (`SCREENSHOT_NETWORK_IDLE_MS`, default 5s), fonts + in-flight images, and
  **document height stability** (`scrollHeight` unchanged for three
  double-`requestAnimationFrame`s), then `SCREENSHOT_SETTLE_MS`.
  - The quiet-network wait is bounded rather than removed. Removing it entirely
    is measurably wrong: `settings` then captured at 5120px, 4242px and 3446px
    tall on three consecutive runs. Leaving it unbounded is what made the harness
    slow: the React Flow previews keep the network busy for ~30s each, and those
    three targets alone cost 390s of a 601s full run.
  - Height stability catches the rest — React Flow sizes its canvas from
    *measured* node bounds, which lands a few frames after the nodes mount.
  - A `waitFor` selector that never matches logs a `WARN` and still captures;
    check the log if a PNG looks empty.
- **`deviceScaleFactor: 2`** gives retina-quality PNGs; drop it if diffs get
  noisy.
- **Pin a preview's language with `<I18nProvider initialLocale="de" fixedLocale>`;
  `initialLocale` alone does not hold.** The provider reconciles the locale on
  first mount against the viewer's saved preference and then their organization's
  default (`src/i18n/context.tsx`), so a page passing only `initialLocale` renders
  German or English depending on *whose* dev server captured it. `fixedLocale`
  skips that reconciliation and exists for the `/dev/*` routes only — never for the
  product, where following the user's preference is the point.
- **A preview that DRIVES an interactive state must be idempotent, because
  `reactStrictMode` mounts every effect twice.** The harness captures a page at
  rest, so a state a reader has to click for (a switched `ConditionTreeCard`
  branch, an opened `ReportOutline`) is produced by an effect in the preview
  route that presses the control — the `/dev/citation-interaction` pattern. In
  development React mounts, unmounts and remounts, so that effect runs twice: a
  plain `.click()` on a toggle opens the panel and closes it again, and the
  target is then captured at rest under the name of the driven state. Guard with
  a **module-scope** flag (a `let`, or a `Set` keyed per block) — a flag inside
  the effect cannot see the second mount, and one the cleanup resets cannot
  either — and keep polling until the control REPORTS the state
  (`aria-expanded === 'true'`), so a press that lands before hydration is
  retried rather than mistaken for success.
- **Never put `border-radius: inherit` in the global `:focus-visible` rule.** A
  CSS `outline` already follows the focused element's *own* `border-radius` in
  every browser we target, so it needs no help. `border-radius: inherit`
  actively breaks it: it overrides the control's radius with its **parent's**
  (usually `0`), so a `rounded-xl` input/select **squares off the moment it's
  focused**. The `focus-ring` screenshot target exists to catch exactly this
  regression — keep `src/app/globals.css` `:focus-visible` to `outline` +
  `outline-offset` only.

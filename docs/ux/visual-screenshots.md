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
```

## Adding a new screenshot target

1. **Build a dev preview route** under `src/app/dev/<name>/page.tsx`:
   - Mark it `'use client'` and call `notFound()` when `process.env.NODE_ENV !== 'development'` (dev previews must not exist in production).
   - Render the **real** component with realistic fixture props.
   - If the component fetches data, install a **fetch shim** (see gotchas) so it renders fully resolved without a backend.
   - The card gallery `src/app/dev/cards/page.tsx` is the reference for a pure (fetch-free) preview; `src/app/dev/document-grid/page.tsx` is the reference for a preview that shims fetch.
2. **Add the target** to `frontends/ui/visual/registry.mjs` with an `id`, `path`, `description`, and a `waitFor` selector that only appears once the surface has rendered (e.g. a `data-testid`).
3. **Run** `npm run screenshots -- <id>` and commit the resulting PNGs alongside the change.

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

# Piloti Landing + Blog Microservice — Design

Date: 2026-08-03
Branch: `feature/landing-site` (worktree `.worktrees/landing-site`)

## Goal

Replace the in-app marketing page with a standalone Astro microservice that serves
the Piloti landing page and a publicly readable blog. Blog authoring is restricted
to platform owners via Keystatic CMS (GitHub mode) — no second auth system, no DB.

## Decisions (locked with user)

- Approach C: Astro + Keystatic CMS. Public read, owner write.
- The existing in-app marketing page (`frontends/ui/src/components/marketing/`) is **deleted**.
- No shared component package: the marketing components die with the deletion, and
  pulling a React/Tailwind-v4 library into Astro couples the services for no benefit.
  Only design tokens (colors/fonts) are ported, as CSS custom properties.
- Domains: apex host `dev.piloti.at` (dev) / `piloti.at` (prod). App link on the
  landing points at `PUBLIC_APP_URL` (`https://app.dev.piloti.at` / `https://app.piloti.at`).

## Architecture

```text
piloti.at / dev.piloti.at  (Envoy Gateway → web service, Astro static site)
├── /                      Landing (SSG, German copy from provided HTML)
├── /blog                  Blog index (SSG from content collection)
├── /blog/[slug]           Blog post (SSG)
├── /keystatic             Keystatic admin (GitHub OAuth via Keystatic Cloud)
└── /impressum, /datenschutz  Legal placeholders (footer targets)

app.piloti.at / app.dev.piloti.at  (existing Next.js app)
└── /                      logged-in → app; logged-out → 302 to GRID_LANDING_URL
```

## Components

### 1. `frontends/web/` — Astro site

- Astro 5, static prerender for the content pages plus the Node standalone
  adapter (`@astrojs/node`) for the SSR Keystatic admin routes (`/keystatic`,
  `/api/keystatic`). Tailwind CSS v4 (`@tailwindcss/vite`).
- Design tokens as CSS custom properties in a global stylesheet:
  - bg `#e8e5dd` / `#f7f7f3`, ink `#1f2023`, dark panel `#22271a`,
    greens `#2a301f` `#2c3620` `#5c6b42` `#6e7d52` `#a4d06a`, light card `#eef2e4`, `#d3ddc0`.
  - Fonts: Poppins (logo/letterspaced), Inter (body), Archivo (display fallback),
    IBM Plex Mono (labels/cards). Self-hosted or Google Fonts via `fontsource`.
- Landing page = one Astro component per section, copy 1:1 from the decoded
  `template.html` (German):
  nav (Piloti, Anmelden → `PUBLIC_APP_URL`, "Demo anfragen" pill),
  hero ("Planen. Statt suchen.", bg photo + aura canvas, CTAs, funding line),
  dark story panel (fragment cards organize around central Piloti card),
  Nutzung (animated decision-chain mock),
  Datengrundlage (4 cards),   KI+Datenschutz (3 cards), CTA (mailto `hallo@piloti.eu`),
  footer (links + © Piloti 2026).
- JS behaviors ported as framework-free TS islands (no React): aura canvas,
  decision-chain loop, IntersectionObserver reveals, solid-nav-after-hero.
- Hero photo extracted from the decoded asset bundle into `public/`.
- Improvements allowed: a11y (semantic landmarks, alt text, focus states, reduced
  motion), responsiveness, performance. Style stays.

### 2. Blog + Keystatic

- Astro content collection `blog` (`src/content/blog/*.md`), frontmatter:
  `title`, `description`, `pubDate`, `cover` (optional), `draft` (bool, default false).
- `/blog` lists published posts newest-first; `/blog/[slug]` renders a post with
  the site chrome; draft posts are excluded from the build output.
- Keystatic (`@keystatic/core` + `@keystatic/astro`), GitHub mode with Keystatic
  Cloud: admin at `/keystatic`, GitHub OAuth, each save = commit to the repo →
  CI rebuild. Write access is enforced by Keystatic Cloud TEAM membership,
  restricted to the platform owners (editors authenticate through Keystatic
  Cloud and need no GitHub account or repo collaboration). Documented in the
  README; no WorkOS involvement on this service.
- One seed post so `/blog` is never empty on first deploy.

### 3. Old marketing page deletion (Next.js app)

- Delete `frontends/ui/src/components/marketing/` and any specs / visual-registry
  targets referencing it.
- `frontends/ui/src/app/page.tsx`: logged-out branch becomes a 302 redirect to
  `GRID_LANDING_URL` (new env var, default `https://piloti.at`; dev stack sets
  `https://dev.piloti.at`). Logged-in behavior unchanged.
- Env var documented in `AGENTS.md` and `docs/deployment/environment-variables.md`.

### 4. Deploy

- `frontends/web/Dockerfile`: node:22-slim multi-stage build → prerendered
  static output served by the Astro Node standalone adapter (required for the
  SSR Keystatic routes; a pure static server cannot host the admin).
- Pulumi (`deploy/pulumi/src/`): new `web` component mirroring the existing
  service pattern — image `ghcr.io/grid-check/grid-web`, HTTPRoute on the apex
  host, TLS via the existing letsEncrypt issuer, `PUBLIC_APP_URL` injected per
  stack.
- CI: build + push the image following the existing workflow pattern; Astro
  check + build as the repo gate for `frontends/web/**` changes.

## Data flow

- Landing: build-time only. No runtime backend dependency.
- Blog read: build-time from markdown in the repo.
- Blog write: platform owner → `/keystatic` → GitHub OAuth → commit to repo →
  CI builds + pushes image → rollout.

## Error handling

- Styled in-brand 404 page.
- Keystatic route renders only when its env config is present; otherwise the
  route is absent from the static build.
- `/blog` with zero published posts renders a friendly empty state (seed post
  prevents this in practice).
- The app redirect fails safe: unset `GRID_LANDING_URL` falls back to the prod
  default, never to a blank page.

## Testing / verification (per user instruction)

- **No automated tests and no browser automation for this change.**
- Gate: `astro check` + `astro build` succeed; repo lint passes; the Next.js
  app still typechecks after the marketing deletion (its tsconfig gate).
- Self-review loop against this spec until satisfied, including UX and UI
  analysis using personas (architect visitor, potential customer, platform-owner
  blog author).

## Out of scope

- No WorkOS integration on the web service.
- No DB, no BFF endpoints for the blog.
- No shared component package.

# Piloti Web (Landing + Blog)

Astro landing page for Piloti plus the public blog. Static-first: the landing
page is prerendered at build time, the blog posts are content-collection MDX
files. The site runs on the Node standalone adapter (SSR capable - Keystatic
admin and the `/api/keystatic` routes need a server).

## Quick start

```bash
npm install
npm run dev        # http://localhost:4321
```

## Environment

| Variable          | Default              | Purpose                                            |
|-------------------|----------------------|----------------------------------------------------|
| `PUBLIC_APP_URL`  | `https://app.piloti.at` | "Anmelden" link in the nav (public, baked at build) |
| `PUBLIC_SITE_URL` | `http://localhost:4321` | Canonical site URL for OG/sitemap metadata (public) |
| `HOST` / `PORT`   | `0.0.0.0` / `4321`   | Node adapter listen address (runtime)              |

Both `PUBLIC_*` variables are read at **build time** (they end up in the
prerendered HTML), so changing them requires a rebuild - the Docker build
accepts them as build args (see `Dockerfile`).

## Blog

Posts live as MDX in `src/content/blog/{de,en}/*.mdx` (frontmatter schema in
`src/content.config.ts`); draft posts are hidden from the public site. Two
Keystatic collections map onto them — `posts-de` and `posts-en`.

Editing happens through **Keystatic** (cloud mode, project `grid/piloti`). In
development, run `npm run dev` and open `/keystatic`; authoring rights are
managed by **Keystatic Cloud team membership** for the project's team —
platform owners are added there, no GitHub account or repository permissions
needed. Published posts are plain files, so they are picked up by the normal
Astro build.

The admin UI is a React island (`client:only="react"`), so `@astrojs/react` +
`react`/`react-dom` are hard runtime requirements and `react()` must stay in the
`integrations` array in `astro.config.mjs`. Removing them does **not** break the
build - `astro build` still succeeds and `astro check` still passes, because the
island is never server-rendered. The breakage shows up only when someone
requests `/keystatic`: the route throws `NoMatchingRenderer` mid-stream and the
browser gets a blank page. Verify the route by hand after touching the
integration list (see Checks).

## Checks

```bash
npm run check    # astro check (types + diagnostics)
npm run build    # astro build (prerenders all static routes)
```

Neither check exercises the Keystatic admin route. To confirm it still renders,
run the built server and look for the hydration island rather than a blank body:

```bash
node dist/server/entry.mjs &
curl -s localhost:4321/keystatic | grep -q 'renderer-url' && echo OK || echo BROKEN
```

## Docker

```bash
docker build -t grid-oib-web:latest . \
  --build-arg PUBLIC_APP_URL=https://app.dev.piloti.at \
  --build-arg PUBLIC_SITE_URL=https://dev.piloti.at
docker run -p 4321:4321 grid-oib-web:latest
```

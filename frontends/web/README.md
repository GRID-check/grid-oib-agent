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

Posts live as MDX in `src/content/blog/*.mdx` (frontmatter schema in
`src/content.config.ts`); draft posts are hidden from the public site.

Editing happens through **Keystatic** (cloud mode, project
`grid-check/piloti`). In development, run `npm run dev` and open
`/keystatic`; authoring rights are managed in the Keystatic project
settings (repo collaborators - i.e. the platform owners). Published posts
are plain files, so they are picked up by the normal Astro build.

## Checks

```bash
npm run check    # astro check (types + diagnostics)
npm run build    # astro build (prerenders all static routes)
```

## Docker

```bash
docker build -t grid-oib-web:latest . \
  --build-arg PUBLIC_APP_URL=https://app.dev.piloti.at \
  --build-arg PUBLIC_SITE_URL=https://dev.piloti.at
docker run -p 4321:4321 grid-oib-web:latest
```

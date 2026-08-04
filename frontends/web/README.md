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

### Images

Uploads — both the cover and anything inserted into the body — go to
`src/content/blog/_images/<slug>/`, **not** `public/`. That is deliberate:
`public/` is copied verbatim, so an author's 11 MB camera-resolution photo would
be served to every visitor untouched. From `src/`, Astro's image pipeline emits a
responsive webp `srcset` instead (the first real upload went from 11 MB to a
12–129 kB variant per breakpoint). `image.layout: 'constrained'` in
`astro.config.mjs` is what extends that to plain markdown images.

Entries reference images relatively (`../_images/<slug>/<file>`), because that is
what Astro resolves and optimises. Keystatic's `publicPath` is a fixed prefix, so
the assets sit one level above `de/`/`en/` to make a single `../` correct for
both locales. Keep the two Keystatic fields and this directory in sync — the
`IMAGE_DIRECTORY`/`IMAGE_PUBLIC_PATH` constants in `keystatic.config.ts` exist so
there is one place to change it.

The originals stay in the build output (Astro keeps them for the image endpoint),
so a huge upload still costs image-layer size and build time even though no
visitor downloads it. Resize before uploading when it is easy to do.

### Publishing safely

`npm run check` includes `scripts/lint-content.mjs`, which fails on an image
reference that resolves to no file and on an image with no alt text. Both are
mistakes the CMS can produce and neither is caught by `astro check` — a bad
image reference otherwise stays green until `astro build` dies inside Rollup with
a stack trace that means nothing to the person who wrote the post.

That check is only useful if it runs **before** the commit reaches `develop`.
Keystatic Cloud commits to the branch selected in its UI; publish from a branch
and let the PR checks run rather than committing straight to `develop`, where a
broken post takes CI, the image publish and the staging deploy down with it.
Enforce it with branch protection on `develop` (require a PR, block direct
pushes) — that is a repository setting, not something this config can guarantee.

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
npm run check    # astro check (types + diagnostics) + blog content guard
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

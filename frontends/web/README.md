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
| `PUBLIC_APP_URL`  | `https://app.piloti.at` | Base URL of the app. The nav's "Anmelden" link uses `SIGN_IN_URL` (`src/consts.ts`), which appends `/?sign-in` — the app's root bounces logged-out visitors back to this site, so the bare URL is a loop. Public, baked at build. |
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
visitor downloads it — the content guard warns above 4 MB for that reason.

Astro's cache is relocated to `frontends/web/.astro-cache` (`cacheDir` in
`astro.config.mjs`) because the default `node_modules/.astro` is deleted by the
`npm ci` in `task web:install`, which made every CI build reprocess every image
from cold — 44s versus 19s warm on current content. `ci.yml` and
`publish-images.yml` both restore it via `actions/cache`; the latter feeds it
into the Docker build context, since a layer cache cannot help a `RUN npm run
build` that `COPY . .` has already invalidated.

### Previewing a post

`blog-preview.yml` runs on any PR touching `src/content/**`: it builds with
`PUBLIC_INCLUDE_DRAFTS=1`, screenshots the posts that PR changed at desktop and
mobile widths, and links the PNGs from a sticky comment. Drafts render there and
nowhere else — a draft is the thing an author most wants to look at, and it is
invisible on the deployed site.

`PUBLIC_INCLUDE_DRAFTS` is preview-only. `astro build` bakes the result into the
image, so setting it on a release build would publish every unfinished draft.

Locally, the same harness runs against a built server. `task web:preview` is the
same target CI uses, so the two cannot drift:

```bash
task web:preview                          # build with drafts, from the repo root

cd frontends/web
node dist/server/entry.mjs &              # background only the server
until curl -sf http://localhost:4321/ >/dev/null; do sleep 1; done

# playwright-core ships no browser of its own; pin it to match CI.
npm i --no-save playwright-core@1.62.1
npx playwright-core install chromium

node scripts/preview-shots.mjs ./preview-out http://localhost:4321 /blog/<slug>/
```

In the dev container, skip the download and point at the pinned browser instead.
The glob has to be resolved before it is exported — a wildcard in an assignment
is not expanded, so exporting it verbatim just fails the launch:

```bash
PREVIEW_CHROMIUM_PATH="$(find /opt/pw-browsers -path '*/chrome-linux/chrome' -type f | head -1)"
[ -x "$PREVIEW_CHROMIUM_PATH" ] || { echo "no pinned Chromium found"; exit 1; }
export PREVIEW_CHROMIUM_PATH
```

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

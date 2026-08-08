import { config, fields, collection } from '@keystatic/core'

// Uploads land in `src/`, not `public/`, so Astro's image pipeline processes
// them: `public/` assets are copied verbatim and served at whatever resolution
// the author happened to upload (the first CMS post carried an 11 MB, 15798px
// scan). From `src/`, the same file is emitted as a responsive webp srcset.
//
// That requires the reference in the entry to resolve *relative to the MDX
// file*, and Keystatic's `publicPath` is a fixed prefix — it cannot vary per
// entry. Keeping the assets one level above the locale folders makes `../` the
// correct hop for both `blog/de/*` and `blog/en/*`. The `_` prefix keeps the
// directory out of the content collection's `**/*.mdx` glob.
const IMAGE_DIRECTORY = 'frontends/web/src/content/blog/_images'
const IMAGE_PUBLIC_PATH = '../_images/'

const postSchema = {
  title: fields.slug({ name: { label: 'Titel' } }),
  description: fields.text({ label: 'Kurzbeschreibung', multiline: true }),
  pubDate: fields.date({ label: 'Veröffentlicht am' }),
  draft: fields.checkbox({ label: 'Entwurf', defaultValue: true }),
  translationSlug: fields.text({ label: 'Übersetzung (Slug)' }),
  cover: fields.image({
    label: 'Titelbild',
    directory: IMAGE_DIRECTORY,
    publicPath: IMAGE_PUBLIC_PATH,
    // Umlauts and spaces survive into the URL as percent escapes, which
    // Keystatic then fails to match back to the file when the entry is
    // re-opened. Normalise on upload so the author never has to think about it.
    transformFilename: (filename) =>
      filename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9.-]+/g, '-')
        .replace(/-+/g, '-')
        .toLowerCase(),
  }),
  // Without this, Keystatic co-locates inline images next to the entry and
  // writes a bare `![](file.jpg)` that resolves from nowhere — Rollup treats it
  // as a module import and `astro build` fails. Note `fields.mdx` has no
  // `transformFilename` equivalent, so inline uploads keep their original name.
  content: fields.mdx({
    label: 'Inhalt',
    options: {
      image: {
        directory: IMAGE_DIRECTORY,
        publicPath: IMAGE_PUBLIC_PATH,
      },
    },
  }),
}

export default config({
  storage: {
    kind: 'cloud',
  },
  cloud: {
    project: 'grid/piloti',
  },
  collections: {
    'posts-de': collection({
      label: 'Blog (Deutsch)',
      slugField: 'title',
      path: 'frontends/web/src/content/blog/de/*',
      format: { contentField: 'content' },
      schema: postSchema,
    }),
    'posts-en': collection({
      label: 'Blog (English)',
      slugField: 'title',
      path: 'frontends/web/src/content/blog/en/*',
      format: { contentField: 'content' },
      schema: postSchema,
    }),
  },
})

import { config, fields, collection } from '@keystatic/core'

const postSchema = {
  title: fields.slug({ name: { label: 'Titel' } }),
  description: fields.text({ label: 'Kurzbeschreibung', multiline: true }),
  pubDate: fields.date({ label: 'Veröffentlicht am' }),
  draft: fields.checkbox({ label: 'Entwurf', defaultValue: true }),
  translationSlug: fields.text({ label: 'Übersetzung (Slug)' }),
  cover: fields.image({
    label: 'Titelbild',
    directory: 'frontends/web/public/images/blog',
    publicPath: '/images/blog/',
  }),
  // Inline images must land in `public/` and be referenced by absolute URL, the
  // same way `cover` already is. Keystatic's default co-locates them next to the
  // entry and writes a relative `![](file.jpg)`, which Rollup then tries to
  // resolve as a module import and the Astro build fails on.
  content: fields.mdx({
    label: 'Inhalt',
    options: {
      image: {
        directory: 'frontends/web/public/images/blog',
        publicPath: '/images/blog/',
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

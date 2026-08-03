import { config, fields, collection } from '@keystatic/core'

export default config({
  storage: {
    kind: 'cloud',
  },
  cloud: {
    project: 'grid-check/piloti',
  },
  collections: {
    posts: collection({
      label: 'Blog',
      slugField: 'title',
      path: 'frontends/web/src/content/blog/*',
      format: { contentField: 'content' },
      schema: {
        title: fields.slug({ name: { label: 'Titel' } }),
        description: fields.text({ label: 'Kurzbeschreibung', multiline: true }),
        pubDate: fields.date({ label: 'Veröffentlicht am' }),
        draft: fields.checkbox({ label: 'Entwurf', defaultValue: true }),
        cover: fields.image({
          label: 'Titelbild',
          directory: 'frontends/web/public/images/blog',
          publicPath: '/images/blog/',
        }),
        content: fields.mdx({ label: 'Inhalt' }),
      },
    }),
  },
})

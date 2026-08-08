import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'

const blog = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/blog' }),
  // `image()` turns the cover path into an ImageMetadata reference, so a cover
  // that points at a missing file fails the content check instead of rendering
  // a broken <img>, and `<Image>` can emit a responsive srcset for it.
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      draft: z.boolean().default(false),
      translationSlug: z.string().optional(),
      cover: image().optional(),
    }),
})

export const collections = { blog }

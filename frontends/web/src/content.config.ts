import { defineCollection, z } from 'astro:content'
import { glob } from 'astro/loaders'
import { CATEGORY_IDS } from './lib/categories'
import { COVER_PLATE_IDS } from './components/craft/plates'

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
      // Required, no default: a post without one would silently land in a
      // strand nobody chose. Keystatic preselects DEFAULT_CATEGORY.
      category: z.enum(CATEGORY_IDS),
      translationSlug: z.string().optional(),
      cover: image().optional(),
      // A riso plate as the cover, by name (craft/plates.ts): it brings the
      // cover on the page and the share card in the same drawing. Keystatic's
      // select writes '' for "none".
      plate: z
        .union([z.literal(''), z.enum(COVER_PLATE_IDS)])
        .optional()
        .transform((v) => v || undefined),
    })
    .refine((d) => !(d.plate && d.cover), {
      message: 'A post wears a riso plate or a cover image, not both: clear one of `plate` and `cover`.',
      path: ['plate'],
    }),
})

export const collections = { blog }

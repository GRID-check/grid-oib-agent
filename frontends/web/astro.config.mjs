import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import node from '@astrojs/node'
import keystatic from '@keystatic/astro'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'https://piloti.at',
  // `react()` is not optional decoration: the Keystatic admin route injected by
  // `keystatic()` renders `<Keystatic client:only="react" />`. Without a React
  // renderer registered, `astro build` still succeeds - the failure only shows
  // up at request time, as a NoMatchingRenderer stream error that reaches the
  // browser as a blank /keystatic page. It must come before keystatic().
  integrations: [
    mdx(),
    react(),
    keystatic(),
    // Lists every prerendered page, paired with its twin in the other locale
    // (same path under /en). Blog posts whose slugs differ per locale are
    // paired by the hreflang links in their own <head> instead. Server-rendered
    // routes (/keystatic, /api, /sign-in, the /de redirect) are never listed;
    // the filter keeps out what is prerendered but not for search.
    sitemap({
      i18n: { defaultLocale: 'de', locales: { de: 'de', en: 'en' } },
      filter: (page) => !/\/(404|keystatic|api|sign-in)(\/|$)/.test(new URL(page).pathname),
    }),
  ],
  adapter: node({ mode: 'standalone' }),
  // Astro's default cache lives in `node_modules/.astro`, which `npm ci` deletes
  // on every CI run — so the image pipeline reprocessed every blog image from
  // cold each time (44s vs 19s warm on the current content). Outside
  // node_modules it survives the install and can be restored by actions/cache.
  cacheDir: './.astro-cache',
  // Blog images arrive from Keystatic at whatever resolution the author's camera
  // or scanner produced - the first upload was 11 MB at 15798px wide. `constrained`
  // makes every processed image emit a srcset capped at its intrinsic size, so the
  // browser fetches a column-sized variant instead of the original, and
  // `responsiveStyles` ships the `max-width`/`height:auto` rules that go with it.
  image: {
    layout: 'constrained',
    responsiveStyles: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
})

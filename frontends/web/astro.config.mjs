import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
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
  integrations: [mdx(), react(), keystatic()],
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss()],
  },
})

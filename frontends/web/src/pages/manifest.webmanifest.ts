import type { APIRoute } from 'astro'
import { SITE_NAME } from '../consts'
import { ui } from '../i18n/ui'

/** The web app manifest. Icons are rendered by scripts/build-brand-assets.mjs. */
export const GET: APIRoute = () => {
  const manifest = {
    name: `${SITE_NAME} — ${ui.de.hero.title}`,
    short_name: SITE_NAME,
    description: ui.de.meta.description,
    lang: 'de-AT',
    start_url: '/',
    display: 'browser',
    background_color: '#f7f7f3',
    theme_color: '#2a301f',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}

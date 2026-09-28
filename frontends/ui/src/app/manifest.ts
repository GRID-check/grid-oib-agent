import type { MetadataRoute } from 'next'
import { PRODUCT_NAME } from '@/lib/brand'

/**
 * Web app manifest (served at /manifest.webmanifest). The icons are rendered
 * from shared/brand/piloti-mark.svg by frontends/web/scripts/build-brand-assets.mjs;
 * never edit the PNGs by hand.
 */
const manifest = (): MetadataRoute.Manifest => ({
  name: PRODUCT_NAME,
  short_name: PRODUCT_NAME,
  description: 'Workspace for planning offices',
  start_url: '/',
  display: 'standalone',
  background_color: '#f7f7f3',
  theme_color: '#2a301f',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
})

export default manifest

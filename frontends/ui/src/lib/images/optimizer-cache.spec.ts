/**
 * @vitest-environment node
 */

/**
 * No cache between `/_next/image` and the document-image route outlives the
 * access check.
 *
 * The route (`streamDocumentImage`) re-checks, on every fetch, that the token is
 * unexpired and that the person it names may still read the folder. That check
 * only runs when the optimizer actually fetches the route, and Next's optimizer
 * cache answers without fetching: a hit is served from `<distDir>/cache/images`,
 * a STALE entry is served too while it revalidates in the background, and when
 * that revalidation fails (our 403/404) Next writes the old entry back with a
 * fresh `minimumCacheTTL` (`response-cache/index.js`, `handleRevalidate`). So a
 * URL fetched once kept serving its picture indefinitely, to whoever held the
 * URL, after the folder was closed to its owner and after the token expired.
 * Lowering `minimumCacheTTL` does not help: the stale entry is still served.
 *
 * The assertions run Next's own `ImageOptimizerCache` and `getMaxAge`, loaded
 * from the installed Next, against the real `next.config.ts`, so an upgrade that
 * changes how the cache is switched off fails here instead of in production.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { getMaxAge, ImageOptimizerCache } from 'next/dist/server/image-optimizer'
import { imageConfigDefault } from 'next/dist/shared/lib/image-config'
import { afterEach, describe, expect, it } from 'vitest'

import nextConfig from '../../../next.config'
import { DOCUMENT_IMAGE_CACHE_CONTROL, IMAGE_URL_WINDOW_SECONDS } from './signed-image-url'

type CacheOptions = ConstructorParameters<typeof ImageOptimizerCache>[0]

const distDirs: string[] = []

afterEach(() => {
  for (const dir of distDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The optimizer cache exactly as `next start` builds it for these image settings. */
function optimizerCache(images: Partial<typeof imageConfigDefault>): ImageOptimizerCache {
  const distDir = mkdtempSync(path.join(tmpdir(), 'image-cache-'))
  distDirs.push(distDir)
  const config = {
    images: { ...imageConfigDefault, ...images },
    experimental: { isrFlushToDisk: true },
  } as unknown as CacheOptions['nextConfig']
  return new ImageOptimizerCache({ distDir, nextConfig: config })
}

/** Write one optimized image, the way `handleRevalidate` stores a fetched one, and read it back. */
async function storeAndRead(cache: ImageOptimizerCache) {
  const key = ImageOptimizerCache.getCacheKey({
    href: '/api/documents/doc-1/image?org=o&u=u&v=original&exp=1&sig=s',
    width: 640,
    quality: 75,
    mimeType: 'image/webp',
  })
  await cache.set(
    key,
    {
      kind: 'IMAGE',
      etag: 'etag',
      upstreamEtag: 'upstream-etag',
      buffer: Buffer.from('optimized bytes'),
      extension: 'webp',
    } as Parameters<ImageOptimizerCache['set']>[1],
    { cacheControl: { revalidate: IMAGE_URL_WINDOW_SECONDS, expire: undefined } },
  )
  return cache.get(key)
}

describe('the image optimizer keeps no copy of a document image', () => {
  it('can tell a caching optimizer from one that is off (the default caches)', async () => {
    // Without this, the assertion below would also pass if the probe were broken.
    const entry = await storeAndRead(optimizerCache({ maximumDiskCacheSize: 10_000_000 }))
    expect(entry?.value).toMatchObject({ kind: 'IMAGE' })
  })

  it('serves nothing from cache under our config, so every request reaches the access check', async () => {
    const entry = await storeAndRead(optimizerCache({ ...nextConfig.images }))
    expect(entry).toBeNull()
  })

  it('lets no browser or shared cache keep the optimized image longer than one token window', () => {
    // `/_next/image` answers `public, max-age=<max(minimumCacheTTL, upstream max-age)>`,
    // whatever the route says about `private`.
    const minimumCacheTTL = nextConfig.images?.minimumCacheTTL ?? imageConfigDefault.minimumCacheTTL
    const sent = Math.max(minimumCacheTTL, getMaxAge(DOCUMENT_IMAGE_CACHE_CONTROL))
    expect(sent).toBeLessThanOrEqual(IMAGE_URL_WINDOW_SECONDS)
  })
})

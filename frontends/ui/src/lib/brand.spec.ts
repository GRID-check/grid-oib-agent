/**
 * @vitest-environment node
 */
/**
 * The app's copy of the public site's URLs, held to `shared/public-site.json`.
 *
 * `lib/brand.ts` cannot import that file: it lives above the app root, outside
 * the UI image's build context, and client code needs the URL at runtime. So
 * the file is read here, walking up from `process.cwd()` the way
 * `adapters/api/wire-v2.spec.ts` reads `shared/wire/v2`, and the copy fails
 * this spec when it drifts. The site holds its own copy to the same file
 * (`frontends/web/scripts/check-public-site.mjs`), and the Worker's bounce
 * text links the same page.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { mailInboxHelpUrl, PUBLIC_SITE_URL } from './brand'

interface PublicSite {
  origin: string
  paths: { mailInbox: string; privacy: string }
}

function loadPublicSite(): PublicSite {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'shared', 'public-site.json')
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')) as PublicSite
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`shared/public-site.json not found above ${process.cwd()}`)
    dir = parent
  }
}

const SITE = loadPublicSite()

describe('the public site URLs, against shared/public-site.json', () => {
  test('the origin is the contract’s', () => {
    expect(PUBLIC_SITE_URL).toBe(SITE.origin)
  })

  test('the mail inbox help page is the contract’s path, German at the root and English under /en', () => {
    expect(mailInboxHelpUrl('de')).toBe(`${SITE.origin}${SITE.paths.mailInbox}`)
    expect(mailInboxHelpUrl('en')).toBe(`${SITE.origin}/en${SITE.paths.mailInbox}`)
  })
})

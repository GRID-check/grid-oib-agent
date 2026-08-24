/**
 * URL invariance for the `/app` route tree.
 *
 * Walks `src/app/app` the way the Next.js router does — every `page.tsx` is a
 * URL, every `(group)` directory contributes nothing to it — and compares the
 * result against the checked-in {@link APP_ROUTE_URLS}.
 *
 * Written BEFORE the shell refactor moved seven segments into a `(shell)`
 * group, because that move is exactly the kind that cannot fail loudly on its
 * own: nothing imports a URL, so a group directory that loses its parentheses,
 * or a page that lands one level deeper than intended, breaks every bookmark in
 * the product while the build stays green.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { APP_ROUTE_URLS } from './app-routes'

const APP_DIR = join(process.cwd(), 'src', 'app', 'app')

/** Route groups `(name)` are organizational only — they never reach the URL. */
const isRouteGroup = (segment: string): boolean => segment.startsWith('(') && segment.endsWith(')')

/** Private folders `_name` are opted out of routing entirely. */
const isPrivateFolder = (segment: string): boolean => segment.startsWith('_')

const isPageFile = (name: string): boolean => /^page\.(tsx|ts|jsx|js)$/.test(name)

function collectRouteUrls(dir: string, url: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (isPrivateFolder(entry.name)) continue
      const nextUrl = isRouteGroup(entry.name) ? url : `${url}/${entry.name}`
      collectRouteUrls(join(dir, entry.name), nextUrl, into)
    } else if (isPageFile(entry.name)) {
      into.push(url)
    }
  }
}

describe('/app route tree', () => {
  test('resolves to exactly the checked-in URL set', () => {
    const found: string[] = []
    collectRouteUrls(APP_DIR, '/app', found)
    expect([...found].sort()).toEqual([...APP_ROUTE_URLS].sort())
  })

  test('never emits a route-group directory into a URL', () => {
    const found: string[] = []
    collectRouteUrls(APP_DIR, '/app', found)
    expect(found.filter((url) => url.includes('(') || url.includes(')'))).toEqual([])
  })

  test('the checked-in list has no duplicates', () => {
    expect(new Set(APP_ROUTE_URLS).size).toBe(APP_ROUTE_URLS.length)
  })
})

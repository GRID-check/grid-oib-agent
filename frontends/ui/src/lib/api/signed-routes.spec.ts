/**
 * @vitest-environment node
 *
 * Signed internal routes and the proxy exclusion are one decision, held from
 * both sides.
 *
 * `src/proxy.ts` leaves `/api/internal/signed/` off its matcher so a raw body
 * reaches the route unbuffered: behind the proxy, a body above
 * `proxyClientMaxBodySize` is cut short without an error. So a route guarded by
 * a signature must live under that folder, and a route in that folder must be
 * guarded by a signature, because nothing else stands in front of it (no
 * AuthKit, no session). The factory also refuses a misplaced signed route at
 * run time (`assertSignedPath`); this catches it before anyone calls it.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { SIGNED_INTERNAL_PREFIX } from './handler'

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../app/api')
/** `internal/signed/`, the prefix as a folder under `app/api`. */
const SIGNED_FOLDER = SIGNED_INTERNAL_PREFIX.replace(/^\/api\//, '')

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return findRouteFiles(path)
    return entry.name === 'route.ts' ? [path] : []
  })
}

/** Whether a route module declares signature auth on `internalApiRoute`. */
function declaresSignature(source: string): boolean {
  return /\binternalApiRoute\s*\(/.test(source) && /\bauth:\s*\{\s*signature:/.test(source)
}

/** The placement errors of one route module, by its path relative to `app/api`. */
function placementProblems(file: string, source: string): string[] {
  const inSignedFolder = file.startsWith(SIGNED_FOLDER)
  const signed = declaresSignature(source)
  if (signed && !inSignedFolder) return [`${file}: a signed route outside ${SIGNED_INTERNAL_PREFIX} sits behind the proxy`]
  if (inSignedFolder && !signed) return [`${file}: a route under ${SIGNED_INTERNAL_PREFIX} skips the proxy and must verify a signature`]
  return []
}

const ROUTES = findRouteFiles(API_DIR).map((absolute) => ({
  file: relative(API_DIR, absolute).replace(/\\/g, '/'),
  source: readFileSync(absolute, 'utf8'),
}))

describe('signed internal routes', () => {
  it('finds the route surface (a broken walk would pass vacuously)', () => {
    expect(ROUTES.length).toBeGreaterThan(100)
  })

  it('live exactly under the folder the proxy skips', () => {
    expect(ROUTES.flatMap(({ file, source }) => placementProblems(file, source))).toEqual([])
  })

  it('catch both misplacements (the check above is not vacuous)', () => {
    const signed = `export const POST = internalApiRoute('x', run, { auth: { signature: { keysEnv: 'K' } }, tenancy })`
    const token = `export const POST = internalApiRoute('x', run, { tenancy })`

    expect(placementProblems('internal/memory/route.ts', signed)).toHaveLength(1)
    expect(placementProblems(`${SIGNED_FOLDER}inbound-mail/route.ts`, token)).toHaveLength(1)
    expect(placementProblems(`${SIGNED_FOLDER}inbound-mail/route.ts`, signed)).toEqual([])
    expect(placementProblems('internal/memory/route.ts', token)).toEqual([])
  })
})

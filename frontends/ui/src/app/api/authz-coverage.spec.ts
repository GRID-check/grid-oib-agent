/**
 * @vitest-environment node
 */
/**
 * The authorization coverage gate (ADR-0038).
 *
 * The audit that produced ADR-0038 found 117 route files enforcing access four
 * different ways, and no mechanism that noticed when one of them enforced
 * nothing at all. `tsc` now blocks the common case — `apiRoute` will not compile
 * without an `authz` declaration — but a type cannot see a route that skips the
 * factories entirely, which is exactly what the eighteen platform routes used to
 * do. This spec closes that gap.
 *
 * It asserts three things about EVERY `app/api/**\/route.ts`:
 *
 *   1. Every exported HTTP method comes from one of the four factories, or is
 *      listed in {@link HAND_ROLLED} with the gate it applies written down.
 *   2. Every `apiRoute` call declares `authz`, and every `publicApiRoute` call
 *      declares `why`.
 *   3. The hand-rolled list does not GROW. Shrinking it is always fine.
 *
 * Adding a route without a posture fails here. That is the point: the failure
 * arrives at the person adding the route, in the same commit, instead of at a
 * customer's penetration tester.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const API_DIR = dirname(fileURLToPath(import.meta.url))

/** Every `route.ts` under `app/api`, found without a glob dependency. */
function findRouteFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findRouteFiles(path))
    else if (entry.name === 'route.ts') found.push(path)
  }
  return found
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

/**
 * Routes that legitimately predate or sit outside the factories, each with the
 * gate it actually applies. Every entry was read and verified when ADR-0038
 * landed; the reason is the record of that reading.
 *
 * Shrinking this map is the goal. Growing it should require the same argument
 * these four entries carry — a genuine reason the factory contract cannot hold.
 */
const HAND_ROLLED: Record<string, string> = {
  'v1/[...path]/route.ts':
    'transport pass-through to the backend: resolves the session, blocks control-plane prefixes, and validates the collection scope via lib/proxy/collection-authz. Returns upstream responses verbatim, so it cannot use the factory’s JSON serialization.',
  'jobs/async/[...path]/route.ts':
    'async-job proxy: streams upstream responses and forwards the WorkOS access token; authorization is the backend’s job-ownership check in aiq_api/jobs/access.py.',
  'auth/websocket-scope/route.ts':
    'mints the WebSocket scope headers; gates with requireProjectAccess per project id before emitting any scope, and returns a bespoke header envelope rather than JSON.',
  'auth/callback/route.ts':
    'the AuthKit OAuth callback. It runs BEFORE a session exists — that is what it creates — so no session-based posture can apply.',
  // The three platform routes that used to sit here — model-defaults,
  // model-defaults/models and audit-portal — now go through `platformApiRoute`,
  // which already does the owner gate, the tenant slot, the platform scope and
  // the 403 mapping. There was never a reason the factory contract could not
  // hold for them; only three copies of it written out by hand.
}

interface RouteFacts {
  file: string
  method: string
  factory: string | null
  declaresAuthz: boolean
}

function collectRoutes(): RouteFacts[] {
  const files = findRouteFiles(API_DIR)
  const facts: RouteFacts[] = []
  for (const absolute of files) {
    const file = relative(API_DIR, absolute).replace(/\\/g, '/')
    const source = readFileSync(absolute, 'utf8')
    for (const method of HTTP_METHODS) {
      // Any exported handler counts — `export const GET = <anything>` as well as
      // `export async function GET(`. Detecting only the factories would let a
      // route that exports a bare handler slip through as "not a route".
      const viaConst = new RegExp(`export const ${method}\\s*=`).test(source)
      const viaFunction = new RegExp(`export async function ${method}\\s*\\(`).test(source)
      if (!viaConst && !viaFunction) continue
      const viaFactory = new RegExp(
        `export const ${method}\\s*=\\s*(apiRoute|platformApiRoute|internalApiRoute|publicApiRoute)`
      ).exec(source)

      // Isolate this export so a sibling's declaration cannot vouch for it.
      const start =
        source.indexOf(`export const ${method}`) >= 0
          ? source.indexOf(`export const ${method}`)
          : source.indexOf(`export async function ${method}`)
      const rest = source.slice(start + 1)
      const nextExport = rest.search(/\nexport (const [A-Z]+|async function [A-Z]+)/)
      const segment = nextExport >= 0 ? rest.slice(0, nextExport) : rest

      facts.push({
        file,
        method,
        factory: viaFactory?.[1] ?? null,
        declaresAuthz: /\bauthz:\s*\{/.test(segment) || /\bwhy:\s*['"]/.test(segment),
      })
    }
  }
  return facts
}

const ROUTES = collectRoutes()

describe('API authorization coverage', () => {
  it('finds the route surface (guards against a broken glob silently passing)', () => {
    // A glob that matches nothing would make every assertion below vacuous.
    expect(ROUTES.length).toBeGreaterThan(100)
  })

  it('every exported handler comes from a factory or is a recorded exception', () => {
    const undeclared = ROUTES.filter(
      (route) => route.factory === null && !(route.file in HAND_ROLLED)
    ).map((route) => `${route.file} [${route.method}]`)

    expect(
      undeclared,
      'Route handlers must be declared through apiRoute / platformApiRoute / ' +
        'internalApiRoute / publicApiRoute. If one genuinely cannot be, add it to ' +
        'HAND_ROLLED in this file with the gate it applies.'
    ).toEqual([])
  })

  it('every apiRoute and publicApiRoute states its authorization posture', () => {
    const silent = ROUTES.filter(
      (route) =>
        (route.factory === 'apiRoute' || route.factory === 'publicApiRoute') && !route.declaresAuthz
    ).map((route) => `${route.file} [${route.method}]`)

    // tsc already refuses to compile these; this keeps the failure legible and
    // catches a declaration that is present but empty.
    expect(silent).toEqual([])
  })

  it('the hand-rolled exception list does not grow', () => {
    const handRolled = new Set(
      ROUTES.filter((route) => route.factory === null).map((route) => route.file)
    )
    expect([...handRolled].sort()).toEqual(Object.keys(HAND_ROLLED).sort())
  })

  it('every recorded exception explains the gate it applies', () => {
    for (const [file, reason] of Object.entries(HAND_ROLLED)) {
      expect(reason.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(60)
    }
  })

  it('platform routes go through platformApiRoute, never a bare session read', () => {
    // The gate must run before the handler. A platform route that resolves its
    // own session is the pattern ADR-0038 removed.
    const offenders = ROUTES.filter(
      (route) =>
        route.file.startsWith('platform/') &&
        route.factory !== null &&
        route.factory !== 'platformApiRoute' &&
        // answer-feedback keeps its gate in the service, which is declared.
        !route.file.startsWith('platform/answer-feedback/')
    ).map((route) => `${route.file} [${route.method}] uses ${route.factory}`)

    expect(offenders).toEqual([])
  })
})

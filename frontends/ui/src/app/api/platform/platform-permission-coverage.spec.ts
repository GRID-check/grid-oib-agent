/**
 * @vitest-environment node
 */
/**
 * Which `platform:*` permission each platform route requires — asserted, not
 * assumed.
 *
 * `platformApiRoute` will not compile without a `permission`, and
 * `authz-coverage.spec.ts` checks that a route goes through the factory. Neither
 * checks WHICH permission is passed, so swapping `settingsManage` for
 * `settingsView` on a PUT — handing every write to the read-only Platform
 * Support role, which is the exact defect the permission split was introduced to
 * fix — was a green change. An adversarial pass found that gap; this closes it.
 *
 * The table below is the intended access model, written down once. Editing a
 * route's permission means editing this file too, which is the point: it turns a
 * silent widening into a diff a reviewer reads.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const PLATFORM_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * route file (relative to `app/api/platform/`) + method → required permission.
 *
 * The rule the table follows: data ABOUT tenant organizations is
 * `platform:organizations:*`; platform-owned configuration and the platform-owned
 * knowledge base are `platform:settings:*`; reads take `*:view` and writes take
 * `*:manage`.
 */
const EXPECTED: Record<string, string> = {
  'audit-portal/route.ts POST': 'organizationsView',
  'cards/route.ts GET': 'settingsView',
  'citation-health/export/route.ts GET': 'organizationsView',
  'citation-health/route.ts GET': 'organizationsView',
  'knowledge/documents/[fileName]/display-title/route.ts PATCH': 'settingsManage',
  'knowledge/documents/[fileName]/doc-class/route.ts PATCH': 'settingsManage',
  'knowledge/documents/[fileName]/route.ts DELETE': 'settingsManage',
  'knowledge/documents/route.ts POST': 'settingsManage',
  'knowledge/reingest/route.ts POST': 'settingsManage',
  'knowledge/sync/route.ts POST': 'settingsManage',
  'maintenance/reconcile-vectors/route.ts POST': 'settingsManage',
  'model-defaults/models/route.ts GET': 'settingsView',
  'model-defaults/route.ts GET': 'settingsView',
  'model-defaults/route.ts PUT': 'settingsManage',
  'norms/route.ts GET': 'settingsView',
  'norms/route.ts PUT': 'settingsManage',
  // A read, gated on manage, and deliberately: it is a step inside the norms
  // EDITING flow and it spends an outbound RIS lookup. The one exception to the
  // reads-take-view rule, recorded here so it reads as a decision.
  'norms/verify/route.ts POST': 'settingsManage',
  'organizations/[organizationId]/storage/route.ts GET': 'organizationsView',
  'organizations/[organizationId]/storage/route.ts PUT': 'organizationsManage',
  'overview/route.ts GET': 'organizationsView',
  'profiler/conversations/[conversationId]/route.ts GET': 'organizationsView',
  'profiler/conversations/route.ts GET': 'organizationsView',
  'reasoning-efforts/route.ts GET': 'settingsView',
  'reasoning-efforts/route.ts PUT': 'settingsManage',
  'retrieval-settings/route.ts GET': 'settingsView',
  'retrieval-settings/route.ts PUT': 'settingsManage',
  'skills/[skillId]/route.ts PATCH': 'settingsManage',
  'skills/[skillId]/route.ts DELETE': 'settingsManage',
  'skills/route.ts GET': 'settingsView',
  'skills/route.ts POST': 'settingsManage',
  'storage/route.ts GET': 'organizationsView',
}

/**
 * The three routes that authorize in their SERVICE rather than the factory
 * (`getAnswerFeedbackHealth` / `getAnswerFeedbackDigest` call
 * `requirePlatformPermission` themselves), so they declare `enforcedBy` instead.
 * `authz-coverage.spec.ts` already exempts them by name.
 */
const SERVICE_ENFORCED = new Set([
  'answer-feedback/route.ts',
  'answer-feedback/digest/route.ts',
  'answer-feedback/export/route.ts',
])

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function findRouteFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findRouteFiles(path))
    else if (entry.name === 'route.ts') found.push(path)
  }
  return found
}

interface Declaration {
  key: string
  file: string
  permission: string | null
}

function collect(): Declaration[] {
  const declarations: Declaration[] = []
  for (const absolute of findRouteFiles(PLATFORM_DIR)) {
    const file = relative(PLATFORM_DIR, absolute).replace(/\\/g, '/')
    const source = readFileSync(absolute, 'utf8')
    for (const method of HTTP_METHODS) {
      const start = source.indexOf(`export const ${method} =`)
      if (start < 0) continue
      // Isolate this export so a sibling's declaration cannot vouch for it.
      const rest = source.slice(start + 1)
      const next = rest.search(/\nexport const [A-Z]+\s*=/)
      const segment = next >= 0 ? rest.slice(0, next) : rest
      const matched = /permission:\s*PLATFORM_PERMISSIONS\.(\w+)/.exec(segment)
      declarations.push({
        key: `${file} ${method}`,
        file,
        permission: matched?.[1] ?? null,
      })
    }
  }
  return declarations
}

const DECLARATIONS = collect()

describe('platform route permissions', () => {
  it('finds the platform route surface (a broken walk must not pass vacuously)', () => {
    expect(DECLARATIONS.length).toBeGreaterThan(25)
  })

  it('every factory-gated platform handler declares the permission this table names', () => {
    const wrong = DECLARATIONS.filter((d) => !SERVICE_ENFORCED.has(d.file))
      .filter((d) => d.permission !== EXPECTED[d.key])
      .map(
        (d) =>
          `${d.key}: declares ${d.permission ?? 'NOTHING'}, table says ${EXPECTED[d.key] ?? 'UNLISTED'}`
      )

    expect(
      wrong,
      'A platform route changed the permission it requires. If that is intended, ' +
        'update EXPECTED in this file — a widening should be a diff somebody reads.'
    ).toEqual([])
  })

  it('the table has no rows for routes that no longer exist', () => {
    const live = new Set(DECLARATIONS.map((d) => d.key))
    expect([...Object.keys(EXPECTED)].filter((key) => !live.has(key))).toEqual([])
  })

  it('no route that WRITES is gated on a view permission', () => {
    // The read-only Platform Support role holds every `*:view` and no `*:manage`.
    // This is the invariant that keeps "read-only" true as routes are added.
    const mutating = DECLARATIONS.filter(
      (d) => !SERVICE_ENFORCED.has(d.file) && /(POST|PUT|PATCH|DELETE)$/.test(d.key)
    )
    const readGated = mutating
      .filter((d) => d.permission?.endsWith('View'))
      // Two documented exceptions, both of which write nothing: audit-portal
      // mints a read/export-only WorkOS portal link (the org-tier equivalent is
      // gated on `org:audit:view`), and norms/verify only queries RIS.
      .filter((d) => !['audit-portal/route.ts POST', 'norms/verify/route.ts POST'].includes(d.key))
      .map((d) => d.key)

    expect(readGated).toEqual([])
  })
})

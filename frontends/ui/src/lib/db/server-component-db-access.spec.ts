/**
 * Server components are transport, like route handlers — they may not query.
 *
 * `bff-service-architecture.md` forbids `getDb()` and drizzle imports in
 * `app/api/**` route handlers, and that rule was enforced by review and by the
 * route factories. Server components under `app/**` were never named by it, so
 * they became a second, unlayered data path — and every consequence the layering
 * exists to prevent showed up there at once:
 *
 *   - the projects page ran its own org-wide `select().from(projects)`, which
 *     bypassed the per-project FGA filtering in `listProjects` and put every
 *     project in the tenant on screen for every member (the ADR-0038 regression);
 *   - four project pages matched on `projects.id` alone, with no organization
 *     predicate at all;
 *   - the same page's list was unbounded, against the repository rule that every
 *     list query carries a limit;
 *   - and none of them established a tenant context, so once row-level security
 *     was enforced they failed closed with `MissingTenantContextError` and took
 *     login down.
 *
 * One rule prevents all four, and it is the rule the API tier already follows:
 * pages call a service or a repository, and the query lives there. This spec is
 * that rule as a failing build rather than a review comment — the same shape as
 * `authz-coverage.spec.ts` and `rls-coverage.spec.ts`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_DIR = join(process.cwd(), 'src', 'app')

/**
 * Route handlers that still query directly, from before this was enforced.
 *
 * They are a real violation of the same rule — `bff-service-architecture.md`
 * has forbidden `getDb()` in a route handler since ADR-0017 — but they are not
 * what took login down, and moving thirteen endpoints into services belongs in
 * its own change with its own review. Listed rather than skipped so the number
 * is visible and can only go down: a new route added to this list should be a
 * question in review, and anything not on it fails immediately.
 */
const PRE_EXISTING_ROUTE_HANDLERS = [
  'app/api/conversations/[id]/route.ts',
  'app/api/internal/agent-profiler-spans/route.ts',
  'app/api/internal/citation-events/route.ts',
  'app/api/internal/memory/route.ts',
  'app/api/internal/usage/route.ts',
  'app/api/organization/memory/[itemId]/route.ts',
  'app/api/organization/memory/route.ts',
  'app/api/projects/[id]/memory/[itemId]/route.ts',
  'app/api/projects/[id]/memory/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/candidates/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/grants/[subjectUserId]/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/grants/route.ts',
  'app/api/sharing/[resourceType]/[resourceId]/route.ts',
]

/** Every `.ts`/`.tsx` file under `src/app`, recursively. */
function appFiles(dir = APP_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) appFiles(full, found)
    else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}

const relative = (file: string) => file.slice(join(process.cwd(), 'src').length + 1)

/**
 * True when `source` imports VALUES from `specifier`.
 *
 * `import type { Project } from '@/lib/db/schema'` is fine and common in
 * transport code — a type builds no query. The match is per import statement
 * (the brace bounds it) rather than a line-anchored scan, so one file's unrelated
 * multi-line import cannot be read as reaching the specifier on a later line.
 */
function importsValuesFrom(source: string, specifier: string): boolean {
  const pattern = new RegExp(
    String.raw`import\s+(type\s+)?(\{[^}]*\}|[\w*\s,]+)\s*from\s*['"]${specifier}['"]`,
    'g',
  )
  for (const match of source.matchAll(pattern)) {
    if (!match[1]) return true
  }
  return false
}

const opensDatabase = (source: string) => importsValuesFrom(source, String.raw`@/lib/db`)
const importsTableValues = (source: string) => importsValuesFrom(source, String.raw`@/lib/db/schema`)

describe('transport code does not query the database directly', () => {
  const offenders = appFiles()
    .filter((file) => {
      const source = readFileSync(file, 'utf8')
      return opensDatabase(source) || importsTableValues(source)
    })
    .map(relative)
    .sort()

  const isRouteHandler = (file: string) => file.endsWith('/route.ts')

  it('no server component or server action opens the database', () => {
    expect(
      offenders.filter((file) => !isRouteHandler(file)),
      'A page, layout or server action is querying directly. That is the shape that ' +
        'bypassed ADR-0038 FGA filtering and lost the tenant context: move the query ' +
        'into lib/<domain>/service.ts or lib/<domain>/repository.ts and call that.',
    ).toEqual([])
  })

  it('no NEW route handler opens the database', () => {
    expect(
      offenders.filter(isRouteHandler),
      'Route handlers are thin transport (ADR-0017). If you are adding one, put the ' +
        'query in a service instead of extending the pre-existing list.',
    ).toEqual(PRE_EXISTING_ROUTE_HANDLERS)
  })
})

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
import ts from 'typescript'
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
 * Every module specifier a file imports VALUES from.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex. A regex
 * gets this wrong in both directions, and both directions are bugs: it reads
 * `import { type Project } from '@/lib/db/schema'` as a value import and fails a
 * file that is doing nothing wrong, and it misses
 * `import db, { projects } from '@/lib/db'` — a real value import that would
 * walk straight through a guard whose whole job is to catch it. A guard with a
 * known bypass is worse than no guard, because it is trusted.
 *
 * Type-only imports are excluded at two levels, matching TypeScript's own
 * grammar: `import type { … }` on the clause, and `{ type X }` per specifier.
 * A side-effect import (`import '@/lib/db'`) still counts — it runs the module.
 */
function valueImportSpecifiers(source: string, filename: string): Set<string> {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = new Set<string>()

  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue

    const clause = statement.importClause
    // No clause at all is a side-effect import: the module is evaluated.
    if (!clause) {
      found.add(statement.moduleSpecifier.text)
      continue
    }
    if (clause.isTypeOnly) continue

    // A default binding (`import db, …`) is always a value.
    let importsValue = clause.name !== undefined
    const bindings = clause.namedBindings
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        importsValue = true
      } else {
        importsValue ||= bindings.elements.some((element) => !element.isTypeOnly)
      }
    }
    if (importsValue) found.add(statement.moduleSpecifier.text)
  }
  return found
}

/**
 * Everything under `@/lib/db` counts as reaching the database — by default, so
 * that a module added there tomorrow is guarded without anyone remembering to
 * extend this list.
 *
 * The exceptions are named rather than pattern-matched, because each one is a
 * deliberate judgement. `tenant-context` is the scoping API itself: a route
 * handler importing `tenantSlotRoute` is doing the thing this rule exists to
 * encourage, and flagging it would push callers away from the correct helper.
 */
const DB_MODULE_PREFIX = '@/lib/db'
const NOT_DATABASE_ACCESS = new Set(['@/lib/db/tenant-context'])

const reachesDatabase = (specifiers: Set<string>) =>
  [...specifiers].some(
    (specifier) =>
      !NOT_DATABASE_ACCESS.has(specifier) &&
      (specifier === DB_MODULE_PREFIX || specifier.startsWith(`${DB_MODULE_PREFIX}/`)),
  )

describe('transport code does not query the database directly', () => {
  const offenders = appFiles()
    .filter((file) => reachesDatabase(valueImportSpecifiers(readFileSync(file, 'utf8'), file)))
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

  describe('the guard itself', () => {
    // A guard is only worth its green tick if it cannot be walked past. These
    // pin both directions: what must be caught, and what must not be flagged.
    const detects = (source: string) => reachesDatabase(valueImportSpecifiers(source, 'probe.tsx'))

    it.each([
      ['plain named value', "import { getDb } from '@/lib/db'"],
      ['default plus named', "import db, { projects } from '@/lib/db'"],
      ['default only', "import db from '@/lib/db'"],
      ['namespace', "import * as db from '@/lib/db'"],
      ['side-effect (still evaluates the module)', "import '@/lib/db'"],
      ['table values from schema', "import { projects } from '@/lib/db/schema'"],
      ['a schema subpath', "import { projects } from '@/lib/db/schema/tables'"],
      ['mixed type and value specifiers', "import { type Project, projects } from '@/lib/db/schema'"],
      ['multi-line', "import db,\n  { projects } from '@/lib/db'"],
    ])('catches %s', (_label, source) => {
      expect(detects(source)).toBe(true)
    })

    it.each([
      ['a type-only clause', "import type { Project } from '@/lib/db/schema'"],
      ['an inline type specifier', "import { type Project } from '@/lib/db/schema'"],
      ['several inline type specifiers', "import { type Project, type Document } from '@/lib/db/schema'"],
      ['an unrelated module', "import { cn } from '@/lib/utils'"],
      ['a module that merely starts with the same text', "import { x } from '@/lib/dbutils'"],
      ['the tenant-scoping helper, which callers SHOULD use', "import { withTenant } from '@/lib/db/tenant-context'"],
    ])('does not flag %s', (_label, source) => {
      expect(detects(source)).toBe(false)
    })
  })

  it('no NEW route handler opens the database', () => {
    expect(
      offenders.filter(isRouteHandler),
      'Route handlers are thin transport (ADR-0017). If you are adding one, put the ' +
        'query in a service instead of extending the pre-existing list.',
    ).toEqual(PRE_EXISTING_ROUTE_HANDLERS)
  })
})

/**
 * @vitest-environment node
 */
/**
 * The sharing repository's ONE documented exception to "every tenant read is
 * org-scoped", pinned so the argument for it cannot die silently.
 *
 * `findGrantForSubject` queries by `(resourceType, resourceId, subjectUserId)`
 * with **no** organization predicate. The module note justifies that by its
 * caller: `resolveResourceAccess` has already established that the resource
 * belongs to the caller's organization, so re-checking would be a second lookup
 * for a fact just proven. That justification holds for exactly ONE caller — and
 * nothing in the type system notices when a second one appears, which is the
 * failure mode this file exists to catch. A future caller that has NOT proven
 * tenancy would turn this into a cross-tenant read of a grant row.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: [] }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import { findGrantForSubject } from './repository'

const SRC_ROOT = path.resolve(__dirname, '..', '..')

/** Every production `.ts`/`.tsx` file under `src/` — specs and mocks excluded. */
function productionSources(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'mocks' || entry === 'node_modules') continue
      files.push(...productionSources(full))
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue
    if (/\.(spec|test)\.(ts|tsx)$/.test(entry)) continue
    files.push(full)
  }
  return files
}

describe('findGrantForSubject — the deliberate non-org-scoped read', () => {
  it('has exactly ONE caller, and it is the access resolver that proved tenancy first', () => {
    const definition = path.join(SRC_ROOT, 'lib', 'sharing', 'repository.ts')

    const callers = productionSources(SRC_ROOT)
      .filter((file) => file !== definition)
      .filter((file) => /\bfindGrantForSubject\b/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'))

    // If this fails, do not relax it: either the new caller has already resolved
    // the resource's organization (say so in the module note and add it here), or
    // it has not — in which case `findGrantForSubject` needs an `organizationId`
    // parameter and the exception is over.
    expect(callers).toEqual(['lib/sharing/access.ts'])
  })

  it('is scoped by resource and subject only — the exception, stated in SQL', async () => {
    captured.length = 0

    await findGrantForSubject('conversation', 'conv_1', 'user_me')

    expect(captured).toHaveLength(1)
    const { sql, params } = captured[0]!
    expect(sql).toContain('"resource_shares"."resource_type" = $1')
    expect(sql).toContain('"resource_shares"."resource_id" = $2')
    expect(sql).toContain('"resource_shares"."subject_user_id" = $3')
    // The exception itself: no organization predicate, because the caller above
    // has already proven the resource is in the caller's organization.
    expect(sql).not.toContain('"resource_shares"."organization_id"')
    // The 4th param is the `limit(1)`.
    expect(params.slice(0, 3)).toEqual(['conversation', 'conv_1', 'user_me'])
  })

  it('scopes every OTHER read by organization, so the exception stays an exception', async () => {
    const repository = await import('./repository')

    captured.length = 0
    await repository.listGrantsForResource('org_1', 'conversation', 'conv_1')
    await repository.listResourceIdsSharedWith('org_1', 'user_me', 'conversation')
    await repository.listGrantsForResources('org_1', 'conversation', ['conv_1'])

    expect(captured).toHaveLength(3)
    for (const query of captured) {
      expect(query.sql).toContain('"resource_shares"."organization_id" = $1')
      expect(query.params[0]).toBe('org_1')
    }
  })
})

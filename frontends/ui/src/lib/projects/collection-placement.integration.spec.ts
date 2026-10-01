/**
 * @vitest-environment node
 *
 * Moving documents into the collection their folder puts them in (ADR-0078),
 * against a REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/collection-placement.integration.spec.ts
 *
 * The backend is mocked; the rows are not. What is proven: the purge comes
 * before the re-point, a failed purge leaves the row where it is (and reports
 * it), a second placement moves nothing, the sweep finds the project and
 * finishes what an outage left, and lifting the restriction brings the
 * document back.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/documents/service', () => ({ dispatchDocument: vi.fn().mockResolvedValue({ jobId: 'job', status: 'pending' }) }))
vi.mock('@/lib/documents/collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/collection-file-ref')>()),
  purgeIngestedChunks: vi.fn(),
}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_placement_${Date.now()}`
const USER = 'user_placement'
const COLLECTION = `proj_placement_${Date.now()}`

describe.skipIf(!url)('collection placement against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let placement: typeof import('./collection-placement')
  let sweep: typeof import('./placement-sweep')
  let purge: typeof import('@/lib/documents/collection-file-ref').purgeIngestedChunks
  let dispatch: typeof import('@/lib/documents/service').dispatchDocument
  let restrictedCollectionName: typeof import('@/lib/authz/folder-access').restrictedCollectionName
  let projectId: string
  let folderId: string
  let documentId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: string }>): string => String(Array.from(rows)[0]?.id)
  const collectionOf = async (id: string): Promise<string> =>
    String(
      Array.from(
        await inTenant(() =>
          db.execute<{ c: string }>(sql`SELECT collection_name AS c FROM documents WHERE id = ${id}::uuid`)
        )
      )[0]?.c
    )
  const restrict = (roles: string[] | null) =>
    inTenant(() =>
      db.execute(sql`
        UPDATE project_folders
        SET restricted_roles = ${roles ? sql`ARRAY[${sql.join(roles.map((r) => sql`${r}`), sql`, `)}]::text[]` : sql`NULL`},
            restricted_by = ${roles ? USER : null}, restricted_at = ${roles ? sql`now()` : sql`NULL`}
        WHERE id = ${folderId}::uuid
      `)
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    placement = await import('./collection-placement')
    sweep = await import('./placement-sweep')
    purge = (await import('@/lib/documents/collection-file-ref')).purgeIngestedChunks
    dispatch = (await import('@/lib/documents/service')).dispatchDocument
    restrictedCollectionName = (await import('@/lib/authz/folder-access')).restrictedCollectionName

    projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${ORG}, 'Placement', ${USER}, ${COLLECTION}) RETURNING id
        `)
      )
    )
    folderId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (project_id, name, path) VALUES (${projectId}::uuid, 'Honorare', 'Honorare')
          RETURNING id
        `)
      )
    )
    documentId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES (${ORG}, ${USER}, 'Honorarnote.pdf', 'k/Honorarnote.pdf', ${COLLECTION}, 'completed', 'project',
                  ${projectId}::uuid, ${folderId}::uuid)
          RETURNING id
        `)
      )
    )
  })

  beforeEach(() => {
    vi.mocked(purge).mockReset()
    vi.mocked(dispatch).mockClear()
  })

  afterAll(async () => {
    await inTenant(() => db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`))
    await inTenant(() => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('leaves a document where it is when its old chunks could not be purged, and says so', async () => {
    await restrict(['org-geschaeftsfuehrung'])
    vi.mocked(purge).mockResolvedValue(false)

    const result = await placement.placeProjectDocuments(ORG, projectId)

    expect(result).toEqual({ moved: 0, failed: [documentId] })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is finished by the sweep: purge first, then the row, then the re-read into the folder collection', async () => {
    const order: string[] = []
    vi.mocked(purge).mockImplementation(async () => {
      order.push(`purge while row in ${await collectionOf(documentId)}`)
      return true
    })
    vi.mocked(dispatch).mockImplementation(async (input) => {
      order.push(`dispatch into ${input.collectionName}`)
      return { jobId: 'job', status: 'pending' } as Awaited<ReturnType<typeof dispatch>>
    })

    // As the internal route runs it: discovery is cross-tenant, stated as such.
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    const swept = await withPlatformAccess('test: placement sweep', () => sweep.sweepCollectionPlacement())

    const target = restrictedCollectionName(COLLECTION, folderId)
    expect(swept.moved).toBeGreaterThanOrEqual(1)
    expect(await collectionOf(documentId)).toBe(target)
    expect(order).toEqual([`purge while row in ${COLLECTION}`, `dispatch into ${target}`])
    expect(vi.mocked(purge).mock.calls[0]?.[1]).toMatchObject({ collectionName: COLLECTION, filename: 'Honorarnote.pdf' })
  })

  it('moves nothing the second time', async () => {
    vi.mocked(purge).mockResolvedValue(true)
    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 0, failed: [] })
    expect(purge).not.toHaveBeenCalled()
  })

  it('brings the document back to the open collection when the restriction is lifted', async () => {
    await restrict(null)
    vi.mocked(purge).mockResolvedValue(true)

    expect(await placement.placeProjectDocuments(ORG, projectId)).toEqual({ moved: 1, failed: [] })
    expect(await collectionOf(documentId)).toBe(COLLECTION)
  })
})

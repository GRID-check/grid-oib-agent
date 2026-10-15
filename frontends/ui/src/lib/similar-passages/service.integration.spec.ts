/**
 * @vitest-environment node
 *
 * „Im Büro behandelt" against a REAL Postgres, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/similar-passages/service.integration.spec.ts
 *
 * What it proves, each a claim about who may see what:
 *   - the backend is asked about the reader's project, the projects they may
 *     chat in, the office's closed projects and the Büroablage, and about no
 *     project they cannot read and no restricted folder they are not cleared
 *     for; the envelope is signed for exactly those plus the source's own;
 *   - a hit from a collection the call did not name is dropped, whatever the
 *     backend says;
 *   - a held document never comes back, not even to the person who uploaded
 *     it (the SCREENED_ONLY reader, through the real listing SQL);
 *   - the source document never comes back;
 *   - a held source document is refused before the backend is asked, and one
 *     the reader may not open is not found;
 *   - groups come back as the reader's project first, then by best passage.
 *
 * WorkOS and the Python backend are the only things stubbed: who holds a grant
 * on which project and folder, and what the nearest-neighbour query answers.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/** Projects the reader holds a grant on, by id (filled once the rows exist). */
const GRANTED = new Set<string>()
/** Folders the reader holds folder-reader on, by id. */
const CLEARED_FOLDERS = new Set<string>()

vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn(async () => ['member']) }))
vi.mock('@/lib/authz/org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn(async () => false) }))
vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    authorization: {
      check: vi.fn(async ({ resourceExternalId }: { resourceExternalId?: string }) => ({
        authorized: resourceExternalId !== undefined && GRANTED.has(resourceExternalId),
      })),
      listResourcesForMembership: vi.fn(async () => ({
        autoPagination: async () => [...CLEARED_FOLDERS].map((externalId) => ({ externalId, resourceTypeSlug: 'folder' })),
      })),
    },
  }),
}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_similar_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_similar_${STAMP}`
const COLLEAGUE = `user_colleague_${STAMP}`

describe('the similar-passages suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

/** What the stubbed backend was asked, and what it answers. */
interface BackendCall {
  body: { source: Record<string, unknown>; collections: string[] }
  scope: string[]
}

describe.skipIf(!url)('similar passages against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let service: typeof import('./service')
  let restrictedCollectionName: typeof import('@/lib/authz/folder-access').restrictedCollectionName
  let archiv = ''
  const calls: BackendCall[] = []
  /** Every collection the backend answers from, with the file names it claims: a liar's answer included. */
  let answer: Array<{ collection: string; file_name: string; score: number }> = []

  const ids = {
    current: '',
    neighbour: '',
    closed: '',
    unreadable: '',
    restricted: '',
    cleared: '',
    source: '',
    heldSource: '',
    unreadableDoc: '',
  }
  const collections = {
    current: `proj_sim_cur_${STAMP}`,
    neighbour: `proj_sim_nb_${STAMP}`,
    closed: `proj_sim_cl_${STAMP}`,
    unreadable: `proj_sim_un_${STAMP}`,
    restricted: '',
    cleared: '',
  }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const idOf = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  const session = {
    userId: USER,
    email: 'reader@buero.at',
    name: 'Reader',
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: `om_${STAMP}`,
    role: 'member',
    roles: ['member'],
    permissions: [],
    featureFlags: null,
  }

  async function project(organizationId: string, name: string, collection: string): Promise<string> {
    return idOf(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${collection}) returning id`)
      )
    )
  }

  /** Closed once its documents are in: a closed project takes no new document (migration 0115). */
  const close = (projectId: string) =>
    inOrg(ORG, () =>
      db.execute(sql`
        update projects set status = 'closed', closed_at = now(), closed_by = ${USER}, closed_outcome = 'completed',
                            ended_on = '2026-10-01'
        where id = ${projectId}::uuid`)
    )

  async function folder(projectId: string, name: string): Promise<string> {
    return idOf(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
          values (${ORG}, ${projectId}::uuid, ${name}, ${name}, 'custom', ${USER}, now()) returning id`)
      )
    )
  }

  let keys = 0
  /** A document; screened (`clean`) and read to the end unless `held`. */
  async function document(
    projectId: string | null,
    filename: string,
    collection: string,
    extra: { held?: 'quarantined' | 'in-flight'; createdBy?: string; folderId?: string; organizationId?: string } = {}
  ): Promise<string> {
    const status = extra.held === 'quarantined' ? 'quarantined' : extra.held === 'in-flight' ? 'processing' : 'completed'
    const outcome = extra.held === 'quarantined' ? 'quarantined' : extra.held === 'in-flight' ? null : 'clean'
    const organizationId = extra.organizationId ?? ORG
    return idOf(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome, folder_id)
          values (${organizationId}, ${projectId}::uuid, ${projectId ? 'project' : 'archiv'}, ${filename},
                  ${`k/${STAMP}/${(keys += 1)}`}, ${collection}, ${extra.createdBy ?? COLLEAGUE}, ${status},
                  ${outcome}, ${extra.folderId ?? null}::uuid) returning id`)
      )
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    service = await import('./service')
    restrictedCollectionName = (await import('@/lib/authz/folder-access')).restrictedCollectionName
    archiv = (await import('@/lib/archiv/collection')).archivCollectionName(ORG)

    ids.current = await project(ORG, 'Wohnhaus Mödling', collections.current)
    ids.neighbour = await project(ORG, 'Schule Baden', collections.neighbour)
    ids.closed = await project(ORG, 'Kindergarten Wien', collections.closed)
    ids.unreadable = await project(ORG, 'Fremdes Projekt', collections.unreadable)
    GRANTED.add(ids.current).add(ids.neighbour)

    ids.restricted = await folder(ids.current, `Honorare_${STAMP}`)
    ids.cleared = await folder(ids.current, `Verträge_${STAMP}`)
    CLEARED_FOLDERS.add(ids.cleared)
    collections.restricted = restrictedCollectionName(collections.current, ids.restricted)
    collections.cleared = restrictedCollectionName(collections.current, ids.cleared)

    ids.source = await document(ids.current, 'Brandschutzkonzept.pdf', collections.current)
    ids.heldSource = await document(ids.current, 'Eigener-Upload.pdf', collections.current, {
      held: 'in-flight',
      createdBy: USER,
    })
    await document(ids.current, 'Baubeschreibung.pdf', collections.current)
    await document(ids.current, 'Gesperrt.pdf', collections.current, { held: 'quarantined' })
    // The reader's own upload, still being read: they may open it in Files, it is not offered here.
    await document(ids.current, 'Noch-in-Prüfung.pdf', collections.current, { held: 'in-flight', createdBy: USER })
    await document(ids.current, 'Honorarnote.pdf', collections.restricted, { folderId: ids.restricted })
    await document(ids.current, 'Werkvertrag.pdf', collections.cleared, { folderId: ids.cleared })
    await document(ids.neighbour, 'Treppendetail.pdf', collections.neighbour)
    await document(ids.closed, 'Fluchtweg-Nachweis.pdf', collections.closed)
    await close(ids.closed)
    ids.unreadableDoc = await document(ids.unreadable, 'Fremd.pdf', collections.unreadable)
    await document(null, 'Musterdetail-Treppe.pdf', archiv)
    await document(null, 'Archiv-gesperrt.pdf', archiv, { held: 'quarantined' })
    const foreign = await project(OTHER_ORG, 'Anderes Büro', collections.current)
    await document(foreign, 'Baubeschreibung.pdf', collections.current, { organizationId: OTHER_ORG })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input)
        if (!target.endsWith('/v1/collections/similar')) throw new Error(`unexpected fetch ${target}`)
        const headers = new Headers(init?.headers)
        const envelope = headers.get('x-grid-request-context') ?? ''
        const scope = JSON.parse(Buffer.from(envelope, 'base64url').toString()).collectionScope as string[]
        calls.push({ body: JSON.parse(String(init?.body)), scope })
        return new Response(
          JSON.stringify({
            origin: 'point',
            documents: answer.map((hit) => ({
              collection: hit.collection,
              file_name: hit.file_name,
              passages: [{ chunk_id: `${hit.file_name}#1`, snippet: `Auszug aus ${hit.file_name}`, page_number: 3, score: hit.score }],
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      })
    )
  })

  afterEach(() => {
    calls.length = 0
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from documents where organization_id = ${organizationId}`)
        await db.execute(sql`delete from project_folders where organization_id = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
  })

  const cited = (documentId: string) => ({
    document: { kind: 'stored' as const, documentId },
    passage: { text: 'Die Fluchttreppe der Stiege 2 wird als offene Außentreppe ausgeführt.', page: 4, cited: true },
  })

  const ask = (request: ReturnType<typeof cited>) =>
    inOrg(ORG, () => service.findSimilarPassages(session, request))

  it('asks about what the reader may read and nothing else, signed for exactly that and the source', async () => {
    answer = []
    await ask(cited(ids.source))

    expect(calls).toHaveLength(1)
    const asked = calls[0].body.collections
    expect([...asked].sort()).toEqual(
      [collections.current, collections.cleared, collections.neighbour, collections.closed, archiv].sort()
    )
    expect(asked).not.toContain(collections.unreadable)
    expect(asked).not.toContain(collections.restricted)
    expect([...calls[0].scope].sort()).toEqual([...asked].sort())
    expect(calls[0].body.source).toMatchObject({
      collection: collections.current,
      file_name: 'Brandschutzkonzept.pdf',
      kind: 'cited',
      page: 4,
      document_id: ids.source,
    })
  })

  it('shows screened documents of every place in reach, and never a held one, the reader’s own upload included', async () => {
    answer = [
      { collection: archiv, file_name: 'Musterdetail-Treppe.pdf', score: 0.97 },
      { collection: collections.current, file_name: 'Gesperrt.pdf', score: 0.96 },
      { collection: collections.current, file_name: 'Noch-in-Prüfung.pdf', score: 0.95 },
      { collection: collections.current, file_name: 'Brandschutzkonzept.pdf', score: 0.94 },
      { collection: collections.neighbour, file_name: 'Treppendetail.pdf', score: 0.93 },
      { collection: collections.current, file_name: 'Baubeschreibung.pdf', score: 0.92 },
      { collection: collections.cleared, file_name: 'Werkvertrag.pdf', score: 0.91 },
      { collection: collections.closed, file_name: 'Fluchtweg-Nachweis.pdf', score: 0.9 },
      { collection: archiv, file_name: 'Archiv-gesperrt.pdf', score: 0.89 },
      // What a lying or confused backend might add: a project and a folder this reader may not read.
      { collection: collections.unreadable, file_name: 'Fremd.pdf', score: 0.99 },
      { collection: collections.restricted, file_name: 'Honorarnote.pdf', score: 0.98 },
    ]
    const response = await ask(cited(ids.source))

    const shown = response.groups.map((group) => [
      group.kind,
      group.project?.name ?? null,
      group.documents.map((document) => document.filename),
    ])
    expect(shown).toEqual([
      ['current', 'Wohnhaus Mödling', ['Baubeschreibung.pdf', 'Werkvertrag.pdf']],
      ['archiv', null, ['Musterdetail-Treppe.pdf']],
      ['project', 'Schule Baden', ['Treppendetail.pdf']],
      ['project', 'Kindergarten Wien', ['Fluchtweg-Nachweis.pdf']],
    ])
    expect(response.groups.find((group) => group.project?.name === 'Kindergarten Wien')?.project?.status).toBe('closed')
    expect(response.projectsSearched).toBe(2)
    expect(response.origin).toBe('point')
    const passage = response.groups[0].documents[0].passages[0]
    expect(passage).toEqual({ page: 3, snippet: 'Auszug aus Baubeschreibung.pdf', score: 0.92 })
  })

  it('refuses a held source before anything is searched: its words would reach the embedder first', async () => {
    answer = []
    await expect(ask(cited(ids.heldSource))).rejects.toMatchObject({ status: 400, details: { reason: 'held' } })
    expect(calls).toHaveLength(0)
  })

  it('does not find a source in a project the reader may not open', async () => {
    await expect(ask(cited(ids.unreadableDoc))).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(0)
  })

  it('searches a legal-corpus passage from the project the reader works in, the corpus signed as its source', async () => {
    answer = [{ collection: collections.current, file_name: 'Brandschutzkonzept.pdf', score: 0.9 }]
    const response = await inOrg(ORG, () =>
      service.findSimilarPassages(session, {
        document: { kind: 'base', fileName: 'OIB-Richtlinie_2.pdf' },
        passage: { text: 'Fluchtwege müssen eine lichte Breite von mindestens 1,20 m aufweisen.', page: 7, cited: true },
        projectId: ids.current,
      })
    )

    expect(calls[0].body.source).toMatchObject({ collection: 'oib_knowledge', file_name: 'OIB-Richtlinie_2.pdf' })
    expect(calls[0].scope).toContain('oib_knowledge')
    expect(calls[0].body.collections).not.toContain('oib_knowledge')
    // The cited corpus file is not an office document, so the project's own documents may all come back.
    expect(response.groups[0]).toMatchObject({ kind: 'current', documents: [{ filename: 'Brandschutzkonzept.pdf' }] })
  })
})

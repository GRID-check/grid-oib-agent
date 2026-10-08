/**
 * @vitest-environment node
 *
 * The hold (ADR-0083, amended 2026-10-08) against a REAL Postgres: the one
 * predicate, the one exit from quarantine, and the readers that used to forget.
 *
 *   - `documentVisibleTo` (SQL) and `mayReadDocument` (in memory) answer the
 *     same for every status, verdict, author, uploader and reader. The unit
 *     specs drive the services through the in-memory twin, so this is what
 *     makes them evidence about the database.
 *   - a quarantined row leaves quarantine through a release and no other write:
 *     the repository's status writers skip it, and migration 0120's trigger
 *     refuses any other UPDATE that tries.
 *   - the item read, the sharing probe, document roles, the upload history's
 *     counts and the IFC model header each see a held row only as its reader may.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/visibility.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  internalRead,
  mayReadDocument,
  memberReader,
  REVIEWER_READER,
  SCREENED_ONLY,
  type DocumentReader,
  type ReadableFacts,
} from './document-reader'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_visibility_${STAMP}`
const UPLOADER = 'user_vis_uploader'
const OTHER = 'user_vis_other'
const COLLECTION = `coll_visibility_${STAMP}`

const STATUSES = ['uploaded', 'pending', 'processing', 'completed', 'ready', 'failed', 'error', 'stored', 'quarantined']
const OUTCOMES = [null, 'clean', 'partial', 'unchecked', 'quarantined', 'released'] as const

type Row = ReadableFacts & { id: string }

describe.skipIf(!url)('the hold on a document, against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let schema: typeof import('@/lib/db/schema')
  let visibility: typeof import('./visibility')
  let repo: typeof import('./repository')
  let projectId: string
  const rows: Row[] = []

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: UPLOADER }, run)

  async function insert(fields: {
    scope: 'project' | 'archiv'
    status: string
    outcome: (typeof OUTCOMES)[number]
    authoredBy: 'user' | 'agent'
    createdBy: string
  }): Promise<Row> {
    const n = rows.length
    const agent = fields.authoredBy === 'agent'
    const [row] = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           screening_outcome, authored_by, authored_by_producer, authored_by_ref, authored_by_ref_kind, content_hash)
        VALUES
          (${ORG}, ${fields.createdBy}, ${`f-${n}.pdf`}, ${`k/${n}`},
           ${fields.scope === 'project' ? COLLECTION : `archiv_${ORG}`}, ${fields.status}, ${fields.scope},
           ${fields.scope === 'project' ? projectId : null}::uuid, ${fields.outcome},
           ${fields.authoredBy}, ${agent ? 'deep_research' : null}, ${agent ? `run-${n}` : null},
           ${agent ? 'backend_job' : null}, ${`sha256:${n}`})
        RETURNING id
      `)
    )
    const inserted: Row = {
      id: String(row.id),
      status: fields.status,
      authoredBy: fields.authoredBy,
      screeningOutcome: fields.outcome,
      createdBy: fields.createdBy,
      scope: fields.scope,
      projectId: fields.scope === 'project' ? projectId : null,
    }
    rows.push(inserted)
    return inserted
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    schema = await import('@/lib/db/schema')
    visibility = await import('./visibility')
    repo = await import('./repository')

    const projects = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Sichtbarkeit', ${UPLOADER}, ${COLLECTION})
        RETURNING id
      `)
    )
    projectId = String(Array.from(projects)[0].id)

    // Every status against every verdict, by a person and by Piloti, uploaded
    // by the reader and by somebody else, on the project shelf; and a slice of
    // it on the Büroablage, for the per-shelf readers.
    for (const status of STATUSES) {
      for (const outcome of OUTCOMES) {
        for (const createdBy of [UPLOADER, OTHER]) {
          await insert({ scope: 'project', status, outcome, authoredBy: 'user', createdBy })
          await insert({ scope: 'archiv', status, outcome, authoredBy: 'user', createdBy })
        }
        await insert({ scope: 'project', status, outcome, authoredBy: 'agent', createdBy: OTHER })
      }
    }
  }, 120_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM document_roles WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM bim_models WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  async function visibleIds(reader: DocumentReader): Promise<string[]> {
    const { documents } = schema
    const found = await inTenant(() =>
      db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.organizationId, ORG), visibility.documentVisibleTo(reader)))
    )
    return found.map((row) => row.id).sort()
  }

  const READERS: Array<[string, () => DocumentReader]> = [
    ['a member who uploaded some', () => memberReader(UPLOADER)],
    ['a member who uploaded none', () => memberReader('user_vis_nobody')],
    ['a reviewer', () => REVIEWER_READER],
    ['nobody in particular (screened-only)', () => SCREENED_ONLY],
    ['an internal read', () => internalRead('ingest')],
    ['a project reviewer reading the Büroablage as a member', () => ({
      kind: 'shelves',
      project: REVIEWER_READER,
      archiv: memberReader(UPLOADER),
    })],
    ['a curator reading the project as a member', () => ({
      kind: 'shelves',
      project: memberReader('user_vis_nobody'),
      archiv: REVIEWER_READER,
    })],
    ['the projects grid, reviewing this project', () => ({ kind: 'projects', userId: 'user_vis_nobody', reviewedProjectIds: [projectId] })],
    ['the projects grid, reviewing none', () => ({ kind: 'projects', userId: UPLOADER, reviewedProjectIds: [] })],
  ]

  it.each(READERS)('answers %s in SQL exactly as in memory', async (_label, reader) => {
    const expected = rows.filter((row) => mayReadDocument(row, reader())).map((row) => row.id).sort()
    expect(await visibleIds(reader())).toEqual(expected)
  })

  it('holds every upload without a passing verdict from a member who did not upload it', async () => {
    const seen = new Set(await visibleIds(memberReader('user_vis_nobody')))
    const held = rows.filter(
      (row) =>
        row.authoredBy === 'user' &&
        (row.status === 'quarantined' ||
          row.screeningOutcome === 'quarantined' ||
          (row.screeningOutcome === null && !['completed', 'ready', 'ingested', 'success', 'processed'].includes(row.status)))
    )
    expect(held.length).toBeGreaterThan(40)
    expect(held.filter((row) => seen.has(row.id))).toEqual([])
    // In flight with no verdict yet is held: nobody else sees a file before its screening.
    const pending = rows.find((row) => row.status === 'pending' && row.screeningOutcome === null && row.createdBy === OTHER)
    expect(pending && seen.has(pending.id)).toBe(false)
  })

  describe('the item read', () => {
    const pendingOf = (createdBy: string) =>
      rows.find(
        (row) =>
          row.scope === 'project' &&
          row.authoredBy === 'user' &&
          row.status === 'pending' &&
          row.screeningOutcome === null &&
          row.createdBy === createdBy
      )!

    it("is null for a member, the agent and the sharing probe; the uploader's and an internal read's otherwise", async () => {
      const held = pendingOf(OTHER)
      await expect(repo.findDocumentInOrg(held.id, ORG, memberReader(UPLOADER))).resolves.toBeNull()
      await expect(repo.findDocumentInOrg(held.id, ORG, SCREENED_ONLY)).resolves.toBeNull()
      await expect(inTenant(() => repo.findDocumentTenancy(held.id))).resolves.toBeNull()
      await expect(repo.findDocumentInOrg(held.id, ORG, memberReader(OTHER))).resolves.toMatchObject({ id: held.id })
      await expect(repo.findDocumentInOrg(held.id, ORG, internalRead('ingest'))).resolves.toMatchObject({ id: held.id })
    })

    it('is the row for everyone once it has passed', async () => {
      const passed = rows.find(
        (row) => row.scope === 'project' && row.authoredBy === 'user' && row.status === 'completed' && row.screeningOutcome === 'clean'
      )!
      await expect(repo.findDocumentInOrg(passed.id, ORG, SCREENED_ONLY)).resolves.toMatchObject({ id: passed.id })
      await expect(inTenant(() => repo.findDocumentTenancy(passed.id))).resolves.toMatchObject({ organizationId: ORG })
    })
  })

  describe('a quarantined row leaves quarantine through a release only', () => {
    let quarantinedId: string
    const statusOf = async (id: string): Promise<string> => {
      const found = await repo.findDocumentInOrg(id, ORG, internalRead('ingest'))
      return found?.status ?? 'gone'
    }

    beforeAll(async () => {
      quarantinedId = (
        await insert({ scope: 'project', status: 'quarantined', outcome: 'quarantined', authoredBy: 'user', createdBy: OTHER })
      ).id
    })

    it('is not reset to pending by a re-dispatch', async () => {
      await expect(repo.setDocumentIngestJob(quarantinedId, ORG, 'job-redispatch')).resolves.toBe(false)
      expect(await statusOf(quarantinedId)).toBe('quarantined')
    })

    it('is not moved by a local conversion or a failure either', async () => {
      await repo.markDocumentProcessing(quarantinedId, ORG)
      await repo.markDocumentIngestFailed(quarantinedId, ORG, 'boom')
      expect(await statusOf(quarantinedId)).toBe('quarantined')
    })

    it('refuses any other write that tries, at the database (migration 0120)', async () => {
      const refusal = { cause: { code: 'GQH01', message: expect.stringMatching(/only a release takes it out of quarantine/) } }
      await expect(
        inTenant(() => db.execute(sql`UPDATE documents SET status = 'pending' WHERE id = ${quarantinedId}::uuid`))
      ).rejects.toMatchObject(refusal)
      // A release of other bytes than the row holds is refused the same way.
      await expect(
        inTenant(() =>
          db.execute(sql`
            UPDATE documents
            SET status = 'uploaded', screening_outcome = 'released', screening_released_hash = 'sha256:other',
                screening_released_by = ${UPLOADER}, screening_released_at = now()
            WHERE id = ${quarantinedId}::uuid
          `)
        )
      ).rejects.toMatchObject(refusal)
      expect(await statusOf(quarantinedId)).toBe('quarantined')
    })

    it('lets a reviewer release the bytes they saw', async () => {
      const row = await repo.findDocumentInOrg(quarantinedId, ORG, internalRead('quarantine-review'))
      const released = await repo.markScreeningReleased(quarantinedId, ORG, {
        contentHash: row!.contentHash!,
        releasedBy: UPLOADER,
        releasedAt: new Date(),
      })
      expect(released).toBe(true)
      expect(await statusOf(quarantinedId)).toBe('uploaded')
      // And the dispatch after the release takes, as it always did.
      await expect(repo.setDocumentIngestJob(quarantinedId, ORG, 'job-after-release')).resolves.toBe(true)
      expect(await statusOf(quarantinedId)).toBe('pending')
    })

    it('still dispatches a row that is not quarantined', async () => {
      const uploaded = await insert({ scope: 'project', status: 'uploaded', outcome: null, authoredBy: 'user', createdBy: OTHER })
      await expect(repo.setDocumentIngestJob(uploaded.id, ORG, 'job-first')).resolves.toBe(true)
      expect(await statusOf(uploaded.id)).toBe('pending')
    })
  })

  describe('the readers that used to forget', () => {
    let heldId: string
    let passedId: string

    beforeAll(async () => {
      heldId = (await insert({ scope: 'project', status: 'processing', outcome: null, authoredBy: 'user', createdBy: OTHER })).id
      passedId = (await insert({ scope: 'project', status: 'completed', outcome: 'clean', authoredBy: 'user', createdBy: OTHER })).id
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO document_roles (organization_id, project_id, document_id, role, created_by)
          VALUES (${ORG}, ${projectId}::uuid, ${heldId}::uuid, 'bebauungsplan', ${OTHER}),
                 (${ORG}, ${projectId}::uuid, ${passedId}::uuid, 'lageplan', ${OTHER})
        `)
      )
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO bim_models (organization_id, project_id, document_id, status)
          VALUES (${ORG}, ${projectId}::uuid, ${heldId}::uuid, 'ready')
        `)
      )
    })

    it("names a held file's document role to its uploader and reviewers only, and to no prompt", async () => {
      const roles = await import('@/lib/document-roles/repository')
      const boundTo = async (documents: DocumentReader) =>
        (await inTenant(() => roles.listProjectDocumentRoles(projectId, { hiddenFolderIds: [], documents }))).map(
          (row) => row.documentId
        )
      expect(await boundTo(memberReader(UPLOADER))).toEqual([passedId])
      expect(await boundTo(SCREENED_ONLY)).toEqual([passedId])
      expect((await boundTo(memberReader(OTHER))).sort()).toEqual([heldId, passedId].sort())
      expect((await boundTo(REVIEWER_READER)).sort()).toEqual([heldId, passedId].sort())
      const bindable = (documents: DocumentReader) =>
        inTenant(() => roles.documentBelongsToProject(heldId, projectId, { hiddenFolderIds: [], documents }))
      await expect(bindable(memberReader(UPLOADER))).resolves.toBe(false)
      await expect(bindable(memberReader(OTHER))).resolves.toBe(true)
    })

    it("hands a held file's IFC model to its uploader and an internal read only", async () => {
      const bim = await import('@/lib/bim/repository')
      await expect(bim.findBimModelByDocument(heldId, ORG, memberReader(UPLOADER))).resolves.toBeNull()
      await expect(bim.findBimModelByDocument(heldId, ORG, SCREENED_ONLY)).resolves.toBeNull()
      await expect(bim.findBimModelByDocument(heldId, ORG, memberReader(OTHER))).resolves.toMatchObject({ documentId: heldId })
      const model = await bim.findBimModelByDocument(heldId, ORG, internalRead('reloaded'))
      await expect(bim.findBimModelById(model!.id, ORG, memberReader(UPLOADER))).resolves.toBeNull()
    })
  })
})

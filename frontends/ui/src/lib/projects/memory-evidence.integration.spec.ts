/**
 * @vitest-environment node
 *
 * The file names a memory item cites as evidence, as a reader may be shown
 * them now (`memory-evidence.ts`), against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/memory-evidence.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 * a decision drafted while its files were open keeps citing one only while
 * that file is open to the reader. A document moved into a restricted folder
 * after the extraction drops out for a reader not cleared for it and stays for
 * one who is; one in the Papierkorb, an archived one and a held upload drop
 * out for the agent; the decision itself stays. Through the agent's own read
 * (`searchProjectDecisions`) as through the helper.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
// No embedder: the token channel ranks, which is all the decisions read here needs.
vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge/embeddings')>()),
  embedNote: async () => null,
}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_evidence_${STAMP}`
const USER = `user_evidence_${STAMP}`
const UPLOADER = `uploader_evidence_${STAMP}`

describe('the memory evidence suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('memory evidence names against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let evidence: typeof import('./memory-evidence')
  let decisions: typeof import('@/lib/cross-project/decisions-repository')
  let visibility: typeof import('@/lib/documents/visibility')
  let projectId = ''
  let restricted = ''
  const collection = `proj_ev_${STAMP}`
  const DECISION = `Fluchttreppe außen in Stahl ${STAMP}`
  const CITED = ['Baubeschreibung.pdf', 'Honorare.pdf', 'Gesperrt.pdf', 'Weggeworfen.pdf', 'Archiviert.pdf', 'Nie_hochgeladen.pdf']

  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: USER }, run)
  const change = (statement: ReturnType<typeof sql>) => inOrg(() => db.execute(statement))
  const inserted = (statement: ReturnType<typeof sql>) => inOrg(() => db.execute<{ id: string }>(statement))
  const idOf = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  let keys = 0
  async function document(filename: string, extra: { status?: string; outcome?: string; createdBy?: string } = {}): Promise<string> {
    keys += 1
    return idOf(
      await inserted(sql`
        insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                               status, screening_outcome)
        values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${keys}`}, ${collection},
                ${extra.createdBy ?? USER}, ${extra.status ?? 'completed'}, ${extra.outcome ?? 'clean'}) returning id`)
    )
  }

  const fileTo = (documentId: string, folderId: string) =>
    change(sql`update documents set folder_id = ${folderId}::uuid where id = ${documentId}::uuid`)

  const names = (items: ReadonlyArray<{ evidence: ReadonlyArray<{ fileName: string }> | null }>) =>
    items.flatMap((item) => (item.evidence ?? []).map((entry) => entry.fileName)).sort()

  const item = (fileNames: readonly string[]) => ({
    projectId,
    content: DECISION,
    evidence: fileNames.map((fileName) => ({ fileName, page: '1' })),
  })

  const served = (reader: import('./memory-evidence').EvidenceReader, fileNames: readonly string[] = CITED) =>
    inOrg(() => evidence.withServedEvidence(ORG, [item(fileNames)], reader))

  const agentSearch = (readableFolderIds: string[]) =>
    inOrg(() => decisions.searchProjectDecisions(ORG, [{ projectId, readableFolderIds }], 'Fluchttreppe Stahl'))

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    evidence = await import('./memory-evidence')
    decisions = await import('@/lib/cross-project/decisions-repository')
    visibility = await import('@/lib/documents/visibility')
    projectId = idOf(
      await inserted(sql`
        insert into projects (organization_id, name, created_by, collection_name)
        values (${ORG}, 'Evidenz', ${USER}, ${collection}) returning id`)
    )

    // Every cited file was open when the closing extraction read it.
    await document('Baubeschreibung.pdf')
    const moved = await document('Honorare.pdf')
    await document('Gesperrt.pdf', { status: 'quarantined', outcome: 'quarantined', createdBy: UPLOADER })
    const binned = await document('Weggeworfen.pdf')
    const archived = await document('Archiviert.pdf')
    await change(sql`
      insert into project_memory (scope, project_id, organization_id, kind, content, provenance_type, verification, evidence)
      values ('project', ${projectId}::uuid, ${ORG}, 'decision', ${DECISION}, 'distillation', 'source_grounded',
              ${JSON.stringify(CITED.map((fileName) => ({ fileName, page: '1' })))}::jsonb)`)

    // Since then: one moved into a folder with its own list (placement has not moved its chunks),
    // one put in the Papierkorb, one archived.
    restricted = idOf(
      await inserted(sql`
        with folder as (
          insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
          values (${ORG}, ${projectId}::uuid, ${`Vertraulich_${STAMP}`}, ${`Vertraulich_${STAMP}`}, 'custom', ${USER}, now())
          returning id, project_id
        ), grants as (
          insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
          select ${ORG}, project_id, id, 'org-gf', 'read' from folder
        )
        select id from folder`)
    )
    await fileTo(moved, restricted)
    const bin = idOf(
      await inserted(sql`
        insert into project_folders (organization_id, project_id, name, path)
        values (${ORG}, ${projectId}::uuid, ${`Papierkorb_${STAMP}`}, ${`Papierkorb_${STAMP}`}) returning id`)
    )
    await fileTo(binned, bin)
    await change(sql`update project_folders set deleted_at = now(), bin_root_id = id where id = ${bin}::uuid`)
    await change(sql`update documents set lifecycle = 'archived' where id = ${archived}::uuid`)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('the agent’s decision read keeps the decision and cites only what is still open to everyone', async () => {
    const found = await agentSearch([])
    expect(found.map((decision) => decision.content)).toEqual([DECISION])
    expect(names(found)).toEqual(['Baubeschreibung.pdf'])
  })

  it('cites a file moved into a restricted folder after the extraction only for a reader cleared for it', async () => {
    expect(names(await agentSearch([restricted]))).toEqual(['Baubeschreibung.pdf', 'Honorare.pdf'])
    const uncleared = await served({ reader: visibility.SCREENED_ONLY, clearanceIn: () => [] })
    expect(names(uncleared)).toEqual(['Baubeschreibung.pdf'])
  })

  it('cites a held upload to the person who uploaded it, never to the agent', async () => {
    expect(names(await served({ reader: visibility.memberReader(UPLOADER), clearanceIn: () => [] }))).toEqual([
      'Baubeschreibung.pdf',
      'Gesperrt.pdf',
    ])
    expect(names(await served({ reader: visibility.memberReader(USER), clearanceIn: () => [] }))).toEqual([
      'Baubeschreibung.pdf',
    ])
  })

  it('keeps an item whose every name went, and passes an item without evidence untouched', async () => {
    const [cleared] = await served({ reader: visibility.SCREENED_ONLY, clearanceIn: () => [] }, ['Weggeworfen.pdf'])
    expect(cleared).toEqual({ projectId, content: DECISION, evidence: [] })
    const bare = { projectId, content: 'ohne Beleg', evidence: null }
    expect(await inOrg(() => evidence.withServedEvidence(ORG, [bare], { reader: visibility.SCREENED_ONLY, clearanceIn: () => [] }))).toEqual([bare])
  })
})

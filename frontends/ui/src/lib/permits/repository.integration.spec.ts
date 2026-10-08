/**
 * @vitest-environment node
 *
 * Permitting memory's rows (docs/design/permitting-memory.md), against a REAL
 * Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/permits/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - a document has one record: storing again replaces it and its
 *     requirements in one transaction, a failed replacement leaves the old one,
 *     deleting the record or the document takes the requirements with it;
 *   - the question's embedding is ranked against each requirement's stored one
 *     in SQL, and a vector from another model counts for nothing: a question
 *     in English finds a requirement written in German by meaning alone;
 *   - without an embedder the token channel answers, over the requirement, its
 *     evidence, and the record's authority and Gemeinde, and a question
 *     sharing nothing finds none;
 *   - records come back best first, each with only its matching requirements,
 *     and both lists are bounded;
 *   - a restricted record comes back only for a reader cleared for all of its
 *     folders, as restricted memory does;
 *   - only the projects asked about, and no other organization's rows.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/** The question's vector, as the embedder would return it; null is an embedder that is down. */
let queryVector: number[] | null = null
const MODEL = 'test-embedder'
vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/knowledge/embeddings')>()),
  embedNote: async () => (queryVector ? { vector: queryVector, fingerprint: MODEL } : null),
}))

// Three axes of meaning, so a test can say what a vector is about: structural proof, fire protection, fees.
const STATICS = [1, 0, 0]
const FIRE = [0, 1, 0]
const FEES = [0, 0, 1]

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_permits_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_permits_${STAMP}`

describe('the permit records suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('permit records against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  const ids = { baden: '', moedling: '', other: '', foreign: '' }
  const FOLDER = randomUUID()

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_prm_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(organizationId: string, projectId: string, filename: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by)
          values (${organizationId}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_prm_${projectId}`}, ${USER}) returning id`)
      )
    )
  }

  const requirement = (
    content: string,
    extra: { vector?: number[]; model?: string; evidence?: string | null; kind?: 'auflage' | 'nachforderung' | 'hinweis' } = {}
  ): import('./repository').PermitRequirementInput => ({
    kind: extra.kind ?? 'auflage',
    content,
    evidence: extra.evidence ?? null,
    legalBasis: null,
    page: 2,
    embedding: extra.vector ? { vector: extra.vector, fingerprint: extra.model ?? MODEL } : null,
  })

  async function store(
    organizationId: string,
    projectId: string,
    documentId: string,
    fileName: string,
    requirements: import('./repository').PermitRequirementInput[],
    extra: Partial<import('./repository').PermitRecordInput> = {}
  ) {
    await inOrg(organizationId, () =>
      repo.replacePermitRecord({
        organizationId,
        projectId,
        documentId,
        collectionName: `proj_prm_${projectId}`,
        fileName,
        restrictedFolderIds: null,
        model: 'summary-model',
        kind: 'nachforderung',
        authority: 'Magistratsabteilung 37',
        municipality: 'Wien',
        bundesland: 'wien',
        issuedOn: '2020-03-14',
        reference: 'MA37/1/2020',
        requirements,
        ...extra,
      })
    )
  }

  const counts = (organizationId: string, documentId: string) =>
    inOrg(organizationId, async () => {
      const [rows] = await db.execute<{ records: number; requirements: number }>(sql`
        select (select count(*)::int from permit_records where document_id = ${documentId}::uuid) as records,
               (select count(*)::int from permit_requirements r join permit_records p on p.id = r.record_id
                 where p.document_id = ${documentId}::uuid) as requirements`)
      return { records: Number(rows.records), requirements: Number(rows.requirements) }
    })

  const search = (
    organizationId: string,
    question: string,
    readable: Record<string, string[]> = {},
    options?: { maxRecords?: number; maxPerRecord?: number }
  ) =>
    inOrg(organizationId, () =>
      repo.searchPermitRequirements(
        organizationId,
        [ids.baden, ids.moedling].map((projectId) => ({ projectId, readableFolderIds: readable[projectId] ?? [] })),
        question,
        options
      )
    )

  const contents = (found: Awaited<ReturnType<typeof search>>) => found.flatMap((record) => record.requirements.map((item) => item.content))

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.baden = await project(ORG, 'Baden')
    ids.moedling = await project(ORG, 'Moedling')
    ids.other = await project(ORG, 'Nebenprojekt')
    ids.foreign = await project(OTHER_ORG, 'Fremd')

    await store(ORG, ids.baden, await document(ORG, ids.baden, 'Baubescheid_Baden.pdf'), 'Baubescheid_Baden.pdf', [
      requirement('Ein statischer Nachweis der Deckenkonstruktion ist vorzulegen.', { vector: STATICS, evidence: 'Gutachten eines Ziviltechnikers' }),
      requirement('Das Brandschutzkonzept ist für die Fluchtwege bis 40 m zu ergänzen.', { vector: FIRE }),
    ], { authority: 'Stadtgemeinde Baden', municipality: 'Baden' })
    await store(ORG, ids.moedling, await document(ORG, ids.moedling, 'Mängelbehebung_Moedling.pdf'), 'Mängelbehebung_Moedling.pdf', [
      requirement('Fluchtwegbreiten sind in allen Grundrissen zu bemaßen.', { vector: FIRE, kind: 'nachforderung' }),
      // The same meaning from another embedder: noise of the right shape, never compared.
      requirement('Tragwerk nachweisen.', { vector: STATICS, model: 'another-embedder' }),
    ], { authority: 'Stadtgemeinde Mödling', municipality: 'Mödling' })
    await store(ORG, ids.moedling, await document(ORG, ids.moedling, 'Honorar_Moedling.pdf'), 'Honorar_Moedling.pdf', [
      requirement('Das Honorar der Statikerin wurde pauschal vereinbart.', { vector: FEES }),
    ], { restrictedFolderIds: [FOLDER], authority: 'Gemeinde Moedling', municipality: null })
    await store(ORG, ids.other, await document(ORG, ids.other, 'Nebenprojekt.pdf'), 'Nebenprojekt.pdf', [
      requirement('Statischer Nachweis des Nebenprojekts.', { vector: STATICS }),
    ])
    await store(OTHER_ORG, ids.foreign, await document(OTHER_ORG, ids.foreign, 'Fremd.pdf'), 'Fremd.pdf', [
      requirement('Statischer Nachweis, fremdes Büro.', { vector: STATICS }),
    ])
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('replace, delete and cascade', () => {
    it('replaces the document’s record and its requirements, never adding a second', async () => {
      const documentId = await document(ORG, ids.other, 'Ersetzt.pdf')
      await store(ORG, ids.other, documentId, 'Ersetzt.pdf', [requirement('Erste Fassung eins.'), requirement('Erste Fassung zwei.')])
      expect(await counts(ORG, documentId)).toEqual({ records: 1, requirements: 2 })

      await store(ORG, ids.other, documentId, 'Ersetzt.pdf', [requirement('Zweite Fassung.', { vector: FEES })], { authority: 'Land NÖ' })

      expect(await counts(ORG, documentId)).toEqual({ records: 1, requirements: 1 })
      const [row] = await inOrg(ORG, () =>
        db.execute<{ content: string; authority: string; position: number; model: string }>(sql`
          select r.content, p.authority, r.position, r.embedding_model as model
          from permit_requirements r join permit_records p on p.id = r.record_id where p.document_id = ${documentId}::uuid`)
      )
      expect(row).toMatchObject({ content: 'Zweite Fassung.', authority: 'Land NÖ', position: 0, model: MODEL })
    })

    it('stores a notice whose authority the document does not name, as NULL', async () => {
      const documentId = await document(ORG, ids.other, 'Scan_ohne_Briefkopf.pdf')
      await store(ORG, ids.other, documentId, 'Scan_ohne_Briefkopf.pdf', [requirement('Ohne Briefkopf vorzulegen.')], { authority: null })

      const [row] = await inOrg(ORG, () =>
        db.execute<{ authority: string | null }>(sql`
          select p.authority from permit_records p where p.document_id = ${documentId}::uuid`)
      )
      expect(row).toEqual({ authority: null })
      expect(await counts(ORG, documentId)).toEqual({ records: 1, requirements: 1 })
    })

    it('keeps the previous record when the replacement fails', async () => {
      const documentId = await document(ORG, ids.other, 'Bleibt.pdf')
      await store(ORG, ids.other, documentId, 'Bleibt.pdf', [requirement('Bleibt bestehen.')])

      // 1001 characters: the 0126 CHECK refuses it, after the old record was deleted inside the transaction.
      await expect(store(ORG, ids.other, documentId, 'Bleibt.pdf', [requirement('x'.repeat(1001))])).rejects.toThrow()

      expect(await counts(ORG, documentId)).toEqual({ records: 1, requirements: 1 })
    })

    it('deletes the record with its requirements, and only this document’s', async () => {
      const documentId = await document(ORG, ids.other, 'Geloescht.pdf')
      await store(ORG, ids.other, documentId, 'Geloescht.pdf', [requirement('Weg damit.')])
      const keep = await document(ORG, ids.other, 'Bleibt2.pdf')
      await store(ORG, ids.other, keep, 'Bleibt2.pdf', [requirement('Bleibt.')])

      await inOrg(ORG, () => repo.deletePermitRecord(ORG, documentId))

      expect(await counts(ORG, documentId)).toEqual({ records: 0, requirements: 0 })
      expect(await counts(ORG, keep)).toEqual({ records: 1, requirements: 1 })
    })

    it('another organization’s delete finds nothing to delete', async () => {
      const documentId = await document(ORG, ids.other, 'Fremdzugriff.pdf')
      await store(ORG, ids.other, documentId, 'Fremdzugriff.pdf', [requirement('Gehört ORG.')])

      await inOrg(OTHER_ORG, () => repo.deletePermitRecord(OTHER_ORG, documentId))
      await inOrg(OTHER_ORG, () => repo.deletePermitRecord(ORG, documentId))

      expect(await counts(ORG, documentId)).toEqual({ records: 1, requirements: 1 })
    })

    it('goes with the document', async () => {
      const documentId = await document(ORG, ids.other, 'Dokument_weg.pdf')
      await store(ORG, ids.other, documentId, 'Dokument_weg.pdf', [requirement('Mit dem Dokument.'), requirement('Auch das.')])

      await inOrg(ORG, () => db.execute(sql`delete from documents where id = ${documentId}::uuid`))

      expect(await counts(ORG, documentId)).toEqual({ records: 0, requirements: 0 })
    })

    it('refuses a record for a document that does not exist', async () => {
      await expect(store(ORG, ids.other, randomUUID(), 'Nirgends.pdf', [requirement('Ohne Dokument.')])).rejects.toThrow()
    })

    it('finds the document by id and collection, or by collection and file name, in its organization, in a project', async () => {
      const documentId = await document(ORG, ids.baden, 'Suche.pdf')
      const collectionName = `proj_prm_${ids.baden}`
      const find = (organizationId: string, ref: import('./repository').PermitDocumentRef) =>
        inOrg(organizationId, () => repo.findPermitDocument(organizationId, ref))
      const found = { documentId, projectId: ids.baden, fileName: 'Suche.pdf', projectCollection: `proj_prm_Baden_${STAMP}` }

      expect(await find(ORG, { collectionName, documentId, fileName: 'Suche.pdf' })).toMatchObject(found)
      expect(await find(ORG, { collectionName, fileName: 'Suche.pdf' })).toMatchObject(found)
      // An id wins over the name: the id names the row.
      expect(await find(ORG, { collectionName, documentId, fileName: 'anderer-name.pdf' })).toMatchObject(found)
      expect(await find(ORG, { collectionName: 'proj_elsewhere', documentId, fileName: 'Suche.pdf' })).toBeNull()
      expect(await find(ORG, { collectionName: 'proj_elsewhere', fileName: 'Suche.pdf' })).toBeNull()
      expect(await find(ORG, { collectionName, fileName: 'Unbekannt.pdf' })).toBeNull()
      expect(await find(ORG, { collectionName, documentId: randomUUID(), fileName: 'Suche.pdf' })).toBeNull()
      expect(await find(OTHER_ORG, { collectionName, documentId, fileName: 'Suche.pdf' })).toBeNull()
      expect(await find(OTHER_ORG, { collectionName, fileName: 'Suche.pdf' })).toBeNull()
    })
  })

  describe('search', () => {
    it('ranks by meaning: a question in English finds the German requirement, and another model’s vector counts for nothing', async () => {
      queryVector = STATICS
      const found = await search(ORG, 'What structural proof do they ask for?')
      queryVector = null

      expect(found[0]).toMatchObject({
        projectId: ids.baden,
        fileName: 'Baubescheid_Baden.pdf',
        kind: 'nachforderung',
        authority: 'Stadtgemeinde Baden',
        municipality: 'Baden',
        issuedOn: '2020-03-14',
        reference: 'MA37/1/2020',
        restrictedFolderIds: null,
      })
      expect(found[0].requirements[0]).toEqual({
        kind: 'auflage',
        content: 'Ein statischer Nachweis der Deckenkonstruktion ist vorzulegen.',
        evidence: 'Gutachten eines Ziviltechnikers',
        legalBasis: null,
        page: 2,
      })
      // Its words share nothing with the question and its vector is another model's: not found.
      expect(contents(found)).not.toContain('Tragwerk nachweisen.')
    })

    it('without an embedder, the token channel answers, and finds nothing for a question sharing no word', async () => {
      queryVector = null

      expect((await search(ORG, 'Fluchtwegbreiten Grundrissen')).map((record) => record.projectId)).toEqual([ids.moedling])
      expect((await search(ORG, 'Deckenkonstruktion Ziviltechnikers'))[0]?.projectId).toBe(ids.baden)
      expect(await search(ORG, 'Photovoltaik Dachbegruenung')).toEqual([])
    })

    it('reads a German name as one word: „Mödling" finds Mödling, not every requirement in metres', async () => {
      // Folded to ASCII, „Mödling" was „m" + „dling", and „m" is in „40 m".
      queryVector = null

      expect((await search(ORG, 'Mödling')).map((record) => record.projectId)).toEqual([ids.moedling])
    })

    it('reads the record’s authority and Gemeinde as words of its requirements', async () => {
      queryVector = null

      const found = await search(ORG, 'Baden')

      expect(found.map((record) => record.projectId)).toEqual([ids.baden])
      expect(found[0].requirements).toHaveLength(2)
    })

    it('returns only the projects asked about, and no other organization’s rows', async () => {
      queryVector = STATICS
      const found = await search(ORG, 'Statischer Nachweis')
      queryVector = null

      expect(found.every((record) => [ids.baden, ids.moedling].includes(record.projectId))).toBe(true)
      expect(contents(found).join(' ')).not.toContain('Nebenprojekts')
      expect(contents(found).join(' ')).not.toContain('fremdes Büro')
      expect(await search(OTHER_ORG, 'Statischer Nachweis')).toEqual([])
    })

    it('returns each record with its matching requirements best first, and bounds both lists', async () => {
      queryVector = FIRE
      const found = await search(ORG, 'Brandschutz Fluchtwege')
      const one = await search(ORG, 'Brandschutz Fluchtwege', {}, { maxRecords: 1 })
      const single = await search(ORG, 'Brandschutz Fluchtwege', {}, { maxPerRecord: 1 })
      queryVector = null

      // Both records answer; each leads with the requirement about fire protection.
      expect(found.map((record) => record.projectId).sort()).toEqual([ids.baden, ids.moedling].sort())
      expect(found.find((record) => record.projectId === ids.baden)?.requirements[0].content).toBe('Das Brandschutzkonzept ist für die Fluchtwege bis 40 m zu ergänzen.')
      expect(found.find((record) => record.projectId === ids.moedling)?.requirements[0].content).toBe(
        'Fluchtwegbreiten sind in allen Grundrissen zu bemaßen.'
      )
      expect(one).toHaveLength(1)
      expect(single.every((record) => record.requirements.length === 1)).toBe(true)
    })

    it('serves a restricted record only to a reader cleared for its folder', async () => {
      queryVector = FEES
      const open = await search(ORG, 'Honorar Statikerin')
      const cleared = await search(ORG, 'Honorar Statikerin', { [ids.moedling]: [FOLDER] })
      const wrongFolder = await search(ORG, 'Honorar Statikerin', { [ids.moedling]: [randomUUID()] })
      queryVector = null

      expect(contents(open)).not.toContain('Das Honorar der Statikerin wurde pauschal vereinbart.')
      expect(contents(wrongFolder)).not.toContain('Das Honorar der Statikerin wurde pauschal vereinbart.')
      expect(cleared.find((record) => record.restrictedFolderIds !== null)).toMatchObject({
        fileName: 'Honorar_Moedling.pdf',
        restrictedFolderIds: [FOLDER],
      })
    })

    it('searches nothing for an empty scope or an empty question', async () => {
      expect(await inOrg(ORG, () => repo.searchPermitRequirements(ORG, [], 'Nachweis'))).toEqual([])
      expect(await search(ORG, '   ')).toEqual([])
    })
  })
})

/**
 * @vitest-environment node
 *
 * Restricted project memory (ADR-0086, ADR-0087, migration 0112) against a REAL Postgres
 * with the full migration chain applied, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/memory-restricted.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - the column's CHECK refuses an empty, oversized, NULL-holding or
 *     organization-scoped restriction;
 *   - an open and a restricted note saying the same thing can both be live
 *     (the 0111 index), and consolidation never merges, supersedes or retires
 *     across a restriction;
 *   - every read path serves a restricted note only to a reader who may read
 *     all of its source folders NOW: loosening a folder opens its notes,
 *     tightening one closes them, with no row rewritten;
 *   - the write stores a current restricted collection as its source folder,
 *     and refuses a collection that is not a current restricted one;
 *   - a restricted note keeps the memory judge's verdict, and the 0116 CHECK
 *     refuses one on an open note, where it would tell any member the chat
 *     could list a restricted folder;
 *   - the card decisions of a conversation that drew on a restricted folder stay
 *     out of the project-wide PROPOSAL_DECISIONS block.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs
 * this file with the other suites.
 */

import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { projectMemory } from '@/lib/db/schema'
import type { ProjectMemoryItem } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/knowledge/embeddings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/knowledge/embeddings')>()
  return { ...actual, embedNote: vi.fn(async () => null), embedNotes: vi.fn(async () => null) }
})

import { embedNote } from '@/lib/knowledge/embeddings'

const url = process.env.GRID_TEST_DATABASE_URL

const ORG = `org_memory_restricted_${Date.now()}`
const USER = `user_${ORG}`

describe('the restricted memory suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('restricted project memory against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let memory: typeof import('./memory-service')
  let folderAccess: typeof import('@/lib/authz/folder-access')
  let conversationsRepo: typeof import('@/lib/conversations/repository')

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)
  const firstId = (rows: Iterable<{ id: unknown }>): string => String(Array.from(rows)[0]?.id)

  interface Seeded {
    projectId: string
    collection: string
    /** The restricted folders' ids, in folder order: what a note is restricted to (ADR-0087). */
    restricted: [string, string]
    /** Their retrieval collections, as the agent names them. */
    collections: [string, string]
  }

  /** A project with two restricted folders, so a case's rows are its own. */
  async function seedProject(name: string): Promise<Seeded> {
    const collection = `proj_${name}_${Date.now()}`
    const projectId = firstId(
      await inTenant(() =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${ORG}, ${name}, ${USER}, ${collection}) returning id`)
      )
    )
    const folderIds: string[] = []
    for (const folder of ['Verträge', 'Personal']) {
      folderIds.push(
        firstId(
          await inTenant(() =>
            // One statement: the 0109 trigger wants the list in the same commit.
            db.execute<{ id: string }>(sql`
              with folder as (
                insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
                values (${ORG}, ${projectId}::uuid, ${folder}, ${folder}, 'custom', ${USER}, now())
                returning id, project_id
              ), grants as (
                insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
                select ${ORG}, project_id, id, 'org-gf', 'write' from folder
              )
              select id from folder`)
          )
        )
      )
    }
    const collections = folderIds.map((id) => folderAccess.restrictedCollectionName(collection, id))
    return {
      projectId,
      collection,
      restricted: [folderIds[0], folderIds[1]],
      collections: [collections[0], collections[1]],
    }
  }

  const write = (
    projectId: string,
    content: string,
    restrictedFolderIds: string[] | null = null,
    options: Parameters<typeof memory.createProjectMemoryItem>[1] = {},
    kind: ProjectMemoryItem['kind'] = 'decision'
  ) =>
    inTenant(() =>
      memory.createProjectMemoryItem(
        { scope: 'project', projectId, organizationId: ORG, kind, content, restrictedFolderIds },
        options
      )
    )

  const rowsOf = (projectId: string): Promise<ProjectMemoryItem[]> =>
    inTenant(() => db.select().from(projectMemory).where(eq(projectMemory.projectId, projectId)))
  const live = (rows: ProjectMemoryItem[]) => rows.filter((row) => row.status === 'active')

  /** The error text a statement fails with, the driver's cause included; '' when it succeeds. */
  async function failureOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run()
      return ''
    } catch (error) {
      const failure = error as { message?: string; cause?: { message?: string; constraint_name?: string } }
      return [failure.message, failure.cause?.message, failure.cause?.constraint_name].join(' ')
    }
  }

  const rawInsert = (projectId: string, scope: string, restricted: unknown) =>
    inTenant(() =>
      db.execute(sql`
        insert into project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids)
        values (${scope}, ${scope === 'project' ? projectId : null}::uuid, ${ORG}, 'decision',
                ${`raw ${Math.random()}`}, ${restricted})`)
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    memory = await import('./memory-service')
    folderAccess = await import('@/lib/authz/folder-access')
    conversationsRepo = await import('@/lib/conversations/repository')
  })

  afterEach(() => {
    vi.mocked(embedNote).mockReset()
    vi.mocked(embedNote).mockResolvedValue(null)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from project_memory where organization_id = ${ORG}`)
      await db.execute(sql`delete from messages where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversation_restricted_folders where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from project_folders where project_id in (select id from projects where organization_id = ${ORG})`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('the column and its CHECK', () => {
    it.each([
      ['an empty restriction', sql`'{}'::uuid[]`, 'project'],
      ['a NULL entry', sql`ARRAY['01234567-89ab-4cde-8f01-23456789abcd', NULL]::uuid[]`, 'project'],
      ['more than twenty', sql`array_fill('01234567-89ab-4cde-8f01-23456789abcd'::uuid, ARRAY[21])`, 'project'],
      // Without a project id, as organization memory is: 0008's scope CHECK
      // allows that, so only the restriction's own scope clause refuses it.
      ['organization scope', sql`ARRAY['01234567-89ab-4cde-8f01-23456789abcd']::uuid[]`, 'organization'],
    ])('refuses %s', async (_label, restricted, scope) => {
      const { projectId } = await seedProject('check')
      // The CHECK by name, not any error: an RLS refusal would also throw.
      expect(await failureOf(() => rawInsert(projectId, scope, restricted))).toContain(
        'project_memory_restricted_folders_check'
      )
    })

    it('accepts NULL (open) and one to twenty folders', async () => {
      const { projectId } = await seedProject('check_ok')
      await rawInsert(projectId, 'project', sql`NULL`)
      await rawInsert(projectId, 'project', sql`array_fill('01234567-89ab-4cde-8f01-23456789abcd'::uuid, ARRAY[20])`)
      expect(await rowsOf(projectId)).toHaveLength(2)
    })
  })

  describe('consolidation never crosses a restriction', () => {
    it('keeps an open and a restricted note saying the same thing as two live rows', async () => {
      const { projectId, restricted } = await seedProject('same_text')
      const content = 'Das Honorar für LP 5 bis 8 ist pauschal vereinbart'

      const open = await write(projectId, content)
      const secret = await write(projectId, content, [restricted[0]])
      const openAgain = await write(projectId, content)
      const secretAgain = await write(projectId, content, [restricted[0]])

      expect(secret.id).not.toBe(open.id)
      expect(openAgain.id).toBe(open.id)
      expect(secretAgain.id).toBe(secret.id)
      expect(live(await rowsOf(projectId))).toHaveLength(2)
    })

    it('stores a restriction canonical, so the same collections in another order are the same row', async () => {
      const { projectId, restricted } = await seedProject('canonical')
      const content = 'Die Gehälter steigen ab Jänner um drei Prozent'
      const first = await write(projectId, content, [restricted[1], restricted[0]])
      const second = await write(projectId, content, [restricted[0], restricted[1], restricted[0]])
      expect(second.id).toBe(first.id)
      expect(first.restrictedFolderIds).toEqual([...restricted].sort())
    })

    it('keeps different restrictions apart', async () => {
      const { projectId, restricted } = await seedProject('two_folders')
      const content = 'Die Vertragsstrafe beträgt ein Prozent pro Woche'
      const a = await write(projectId, content, [restricted[0]])
      const ab = await write(projectId, content, [restricted[0], restricted[1]])
      expect(ab.id).not.toBe(a.id)
      expect(live(await rowsOf(projectId))).toHaveLength(2)
    })

    it('never lets a restricted correction retire an open note, nor an open one a restricted note', async () => {
      const { projectId, restricted } = await seedProject('supersede')
      const openNote = await write(projectId, 'Die Bauherrschaft wünscht ein Flachdach über dem Zubau')
      const secretNote = await write(projectId, 'Das Honorar beträgt pauschal 184.000 Euro netto', [restricted[0]])
      const retired: string[] = []

      await write(projectId, 'Die Bauherrschaft wünscht kein Flachdach über dem Zubau', [restricted[0]], {
        supersedesContent: 'Die Bauherrschaft wünscht ein Flachdach über dem Zubau',
        onSuperseded: (id) => retired.push(id),
      })
      await write(projectId, 'Das Honorar beträgt pauschal 190.000 Euro netto', null, {
        supersedesContent: 'Das Honorar beträgt pauschal 184.000 Euro netto',
        onSuperseded: (id) => retired.push(id),
      })

      const rows = await rowsOf(projectId)
      expect(retired).toEqual([])
      expect(rows.find((row) => row.id === openNote.id)?.status).toBe('active')
      expect(rows.find((row) => row.id === secretNote.id)?.status).toBe('active')
      expect(live(rows)).toHaveLength(4)
    })

    it('never merges a paraphrase across the restriction, even when the embedder calls it the same', async () => {
      vi.mocked(embedNote).mockImplementation(async () => ({ vector: [1, 0, 0, 0], fingerprint: 'same' }))
      const { projectId, restricted } = await seedProject('semantic')
      const open = await write(projectId, 'Der Bauherr wünscht ein Flachdach')
      const secret = await write(projectId, 'Flachdach ist gewünscht', [restricted[0]])
      expect(secret.id).not.toBe(open.id)
      // Within one restriction the semantic gate still merges.
      const again = await write(projectId, 'Ein Flachdach ist gewünscht', [restricted[0]])
      expect(again.id).toBe(secret.id)
    })
  })

  describe('serving filters by clearance', () => {
    it("lets a down-vote lower only the notes its voter may see", async () => {
      vi.mocked(embedNote).mockImplementation(async () => ({ vector: [1, 0, 0, 0], fingerprint: 'vote' }))
      const { projectId, restricted } = await seedProject('implicate')
      const open = await write(projectId, 'Die Attika ist mit 1,10 m ausgeführt')
      const secret = await write(projectId, 'Das Honorar für die Attika ist pauschal', [restricted[0]])
      const implicate = (cleared: string[]) =>
        inTenant(() =>
          memory.implicateMemoryFromFeedback({
            organizationId: ORG,
            projectId,
            comment: 'Die Attika stimmt nicht',
            readableFolderIds: cleared,
          })
        )
      const byId = async () => new Map((await rowsOf(projectId)).map((row) => [row.id, row]))

      // A member not cleared for the folder: its note keeps its salience.
      expect(await implicate([])).toBe(1)
      let rows = await byId()
      expect(rows.get(open.id)?.confidence).toBe('low')
      expect(rows.get(secret.id)?.confidence).toBe(secret.confidence)
      expect(rows.get(secret.id)?.salience).toBe(secret.salience)

      // A member cleared for it reaches both.
      expect(await implicate([restricted[0]])).toBe(2)
      rows = await byId()
      expect(rows.get(secret.id)?.confidence).toBe('low')
    })

    it("stores a note masked against the office's policy (ADR-0085)", async () => {
      const { projectId } = await seedProject('masked')
      const note = await write(projectId, 'Lohnzettel an AT61 1904 3002 3457 3201 überweisen')
      expect(note.content).toBe('[Begriff entfernt] an [IBAN entfernt] überweisen')
    })

    it('serves a restricted note only to a reader who may read all of its folders', async () => {
      const { projectId, restricted } = await seedProject('serve')
      await write(projectId, 'Offene Notiz zum Brandschutz im Stiegenhaus')
      await write(projectId, 'Nur Verträge: Honorar pauschal vereinbart', [restricted[0]])
      await write(projectId, 'Verträge und Personal: Bauleitung durch Frau M.', [restricted[0], restricted[1]])

      const listed = async (cleared: string[]) =>
        (
          await inTenant(() =>
            memory.listProjectMemory(projectId, { organizationId: ORG, readableFolderIds: cleared })
          )
        )
          .map((item) => item.content)
          .sort()
      const digest = (cleared: string[]) =>
        inTenant(() =>
          memory.buildProjectMemoryDigest(projectId, ORG, {
            readableFolderIds: cleared,
            // Admission is the conversation's to make; here every folder offered is admitted.
            admitRestricted: async (ids) => new Set(ids),
          })
        )

      expect(await listed([])).toEqual(['Offene Notiz zum Brandschutz im Stiegenhaus'])
      expect(await listed([restricted[1]])).toEqual(['Offene Notiz zum Brandschutz im Stiegenhaus'])
      expect(await listed([restricted[0]])).toEqual([
        'Nur Verträge: Honorar pauschal vereinbart',
        'Offene Notiz zum Brandschutz im Stiegenhaus',
      ])
      expect(await listed([...restricted])).toHaveLength(3)

      const uncleared = await digest([])
      expect(uncleared).toContain('Offene Notiz')
      expect(uncleared).not.toContain('Honorar')
      // The "+N more notes" line is a count; a hidden note must not be in it.
      expect(uncleared).not.toContain('weitere Notizen')
      const cleared = await digest([restricted[0]])
      expect(cleared).toContain('[restricted | decision')
      expect(cleared).not.toContain('Bauleitung')
    })

    it('reaches a hidden note by id for nobody: update and delete answer as if it were missing', async () => {
      const { projectId, restricted } = await seedProject('by_id')
      const secret = await write(projectId, 'Honorarnotiz', [restricted[0]])
      const uncleared = { projectId, organizationId: ORG, readableFolderIds: [] }
      const cleared = { projectId, organizationId: ORG, readableFolderIds: [restricted[0]] }

      expect(await inTenant(() => memory.updateProjectMemoryItem(uncleared, secret.id, { pinned: true }))).toBeNull()
      expect(await inTenant(() => memory.deleteProjectMemoryItem(uncleared, secret.id))).toBe(false)
      expect(
        (await inTenant(() => memory.updateProjectMemoryItem(cleared, secret.id, { pinned: true })))?.pinned
      ).toBe(true)
      expect(await inTenant(() => memory.deleteProjectMemoryItem(cleared, secret.id))).toBe(true)
    })

    it('follows the folder at read time: loosening opens a note, tightening closes it, nothing is rewritten', async () => {
      const { projectId, restricted } = await seedProject('loosened')
      const note = await write(projectId, 'Notiz aus einem später geöffneten Ordner', [restricted[0]])
      const asMember = async () => {
        const readable = await folderAccess.readableFolderIdsFor(ORG, projectId, folderAccess.ANY_MEMBER)
        return inTenant(() => memory.listProjectMemory(projectId, { organizationId: ORG, readableFolderIds: readable }))
      }
      expect(await asMember()).toEqual([])

      // Opened to every member: the note is everyone's now.
      await inTenant(() =>
        db.execute(sql`
          with gone as (delete from project_folder_grants where folder_id = ${restricted[0]}::uuid)
          update project_folders set access_mode = 'inherit' where id = ${restricted[0]}::uuid`)
      )
      expect((await asMember()).map((item) => item.id)).toEqual([note.id])

      // Narrowed again: closed again, the same row unchanged.
      await inTenant(() =>
        db.execute(sql`
          with listed as (
            insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
            values (${ORG}, ${projectId}::uuid, ${restricted[0]}::uuid, 'org-gf', 'read')
          )
          update project_folders set access_mode = 'custom' where id = ${restricted[0]}::uuid`)
      )
      expect(await asMember()).toEqual([])
      expect((await rowsOf(projectId)).find((row) => row.id === note.id)?.restrictedFolderIds).toEqual([restricted[0]])
    })

    it('keeps judging a note by a deleted folder’s tombstone', async () => {
      const { projectId, restricted } = await seedProject('tombstone')
      await write(projectId, 'Notiz aus einem gelöschten Ordner', [restricted[0]])
      await inTenant(() =>
        db.execute(sql`update project_folders set deleted_at = now(), deleted_by = ${USER} where id = ${restricted[0]}::uuid`)
      )
      const readable = (roles: string[]) =>
        folderAccess.readableFolderIdsFor(ORG, projectId, { roles, seesEverything: false })
      const listed = async (roles: string[]) =>
        inTenant(async () =>
          memory.listProjectMemory(projectId, { organizationId: ORG, readableFolderIds: await readable(roles) })
        )
      expect(await listed([])).toEqual([])
      expect(await listed(['org-gf'])).toHaveLength(1)
    })
  })

  describe('the write validates the restriction', () => {
    it('stores a current restricted collection as its source folder and refuses anything else', async () => {
      const { projectId, restricted, collections } = await seedProject('validate')
      const stored = await inTenant(() =>
        memory.createProjectMemoryItemForProject(projectId, {
          kind: 'decision',
          content: 'Gültig eingeschränkt',
          restrictedCollections: [collections[0]],
        })
      )
      // Stored as the folder, not the collection (ADR-0087).
      expect(stored?.restrictedFolderIds).toEqual([restricted[0]])

      await expect(
        inTenant(() =>
          memory.createProjectMemoryItemForProject(projectId, {
            kind: 'decision',
            content: 'Unbekannter Ordner',
            restrictedCollections: ['proj_nowhere_r0123456789ab'],
          })
        )
      ).rejects.toThrow(/Not a restricted collection of this project/)
    })

    it('keeps the judge\'s verdict on a restricted note, and the CHECK refuses one on an open note', async () => {
      const { projectId, collections } = await seedProject('judged')
      const stored = await inTenant(() =>
        memory.createProjectMemoryItemForProject(projectId, {
          kind: 'decision',
          content: 'Vom Modell eingeschränkt',
          restrictedCollections: [collections[1]],
          restrictionJudge: 'drawn',
        })
      )
      expect(stored?.restrictionJudge).toBe('drawn')

      const onOpenNote = () =>
        inTenant(() =>
          db.execute(sql`
            insert into project_memory (scope, project_id, organization_id, kind, content, restriction_judge)
            values ('project', ${projectId}::uuid, ${ORG}, 'decision', 'Offen, aber beurteilt', 'none')`)
        )
      expect(await failureOf(onOpenNote)).toContain('project_memory_restriction_judge_check')
    })
  })

  describe('PROPOSAL_DECISIONS', () => {
    it('leaves out the card decisions of a conversation that drew on a restricted folder', async () => {
      const { projectId, restricted } = await seedProject('decisions')
      const decided = (content: string) => ({
        cards: [{ type: 'memory_proposal', content }],
        cardInteractions: { 'memory_proposal-0': { decision: 'savedProject', decidedAt: '2026-10-02T10:00:00Z' } },
      })
      for (const [id, content] of [
        [`open_${ORG}`, 'Offene Entscheidung'],
        [`restricted_${ORG}`, 'Honorar 184.000 Euro'],
      ] as const) {
        await inTenant(async () => {
          await db.execute(sql`
            insert into conversations (id, organization_id, created_by, project_id)
            values (${id}, ${ORG}, ${USER}, ${projectId}::uuid)`)
          await db.execute(sql`
            insert into messages (conversation_id, role, content, metadata)
            values (${id}, 'assistant', 'x', ${JSON.stringify(decided(content))}::jsonb)`)
        })
      }
      await inTenant(() =>
        db.execute(sql`
          insert into conversation_restricted_folders (organization_id, conversation_id, folder_id)
          values (${ORG}, ${`restricted_${ORG}`}, ${restricted[0]}::uuid)`)
      )

      const rows = await inTenant(() =>
        conversationsRepo.listRecentMessagesWithCardDecisions(projectId, ORG, 40)
      )
      const text = JSON.stringify(rows.map((row) => row.metadata))
      expect(text).toContain('Offene Entscheidung')
      expect(text).not.toContain('Honorar')
    })
  })
})

/**
 * @vitest-environment node
 *
 * Restricted project memory (ADR-0078, migration 0106) against a REAL Postgres
 * with the full migration chain applied, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/projects/memory-restricted.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - the column's CHECK refuses an empty, oversized, NULL-holding or
 *     organization-scoped restriction;
 *   - an open and a restricted note saying the same thing can both be live
 *     (the 0106 index), and consolidation never merges, supersedes or retires
 *     across a restriction;
 *   - every read path serves a restricted note only to a reader cleared for
 *     all of its collections, and a lifted restriction clears nobody;
 *   - the write refuses a collection that is not a current restricted one;
 *   - a restricted conversation's card decisions stay out of the project-wide
 *     PROPOSAL_DECISIONS block.
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
    /** Restricted collections of the project, in folder order. */
    restricted: [string, string]
    folderIds: [string, string]
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
            db.execute<{ id: string }>(sql`
              insert into project_folders (project_id, name, path, restricted_roles, restricted_by, restricted_at)
              values (${projectId}::uuid, ${folder}, ${folder}, ARRAY['org-gf']::text[], ${USER}, now())
              returning id`)
          )
        )
      )
    }
    const restricted = folderIds.map((id) => folderAccess.restrictedCollectionName(collection, id))
    return {
      projectId,
      collection,
      restricted: [restricted[0], restricted[1]],
      folderIds: [folderIds[0], folderIds[1]],
    }
  }

  const write = (
    projectId: string,
    content: string,
    restrictedCollections: string[] | null = null,
    options: Parameters<typeof memory.createProjectMemoryItem>[1] = {},
    kind: ProjectMemoryItem['kind'] = 'decision'
  ) =>
    inTenant(() =>
      memory.createProjectMemoryItem(
        { scope: 'project', projectId, organizationId: ORG, kind, content, restrictedCollections },
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
        insert into project_memory (scope, project_id, organization_id, kind, content, restricted_collections)
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
      await db.execute(sql`delete from conversation_restricted_turns where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from project_folders where project_id in (select id from projects where organization_id = ${ORG})`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('the column and its CHECK', () => {
    it.each([
      ['an empty restriction', sql`'{}'::text[]`, 'project'],
      ['a NULL entry', sql`ARRAY['a_r0123456789ab', NULL]::text[]`, 'project'],
      ['more than twenty', sql`array_fill('a_r0123456789ab'::text, ARRAY[21])`, 'project'],
      // Without a project id, as organization memory is: 0008's scope CHECK
      // allows that, so only 0106's scope clause refuses it.
      ['organization scope', sql`ARRAY['a_r0123456789ab']::text[]`, 'organization'],
    ])('refuses %s', async (_label, restricted, scope) => {
      const { projectId } = await seedProject('check')
      // The CHECK by name, not any error: an RLS refusal would also throw.
      expect(await failureOf(() => rawInsert(projectId, scope, restricted))).toContain(
        'project_memory_restricted_collections_check'
      )
    })

    it('accepts NULL (open) and one to twenty collections', async () => {
      const { projectId } = await seedProject('check_ok')
      await rawInsert(projectId, 'project', sql`NULL`)
      await rawInsert(projectId, 'project', sql`array_fill('a_r0123456789ab'::text, ARRAY[20])`)
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
      expect(first.restrictedCollections).toEqual([...restricted].sort())
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
            clearedRestrictedCollections: cleared,
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

    it("stores a note masked against the office's policy (ADR-0077)", async () => {
      const { projectId } = await seedProject('masked')
      const note = await write(projectId, 'Lohnzettel an AT61 1904 3002 3457 3201 überweisen')
      expect(note.content).toBe('[Begriff entfernt] an [IBAN entfernt] überweisen')
    })

    it('serves a restricted note only to a reader cleared for all of its collections', async () => {
      const { projectId, restricted } = await seedProject('serve')
      await write(projectId, 'Offene Notiz zum Brandschutz im Stiegenhaus')
      await write(projectId, 'Nur Verträge: Honorar pauschal vereinbart', [restricted[0]])
      await write(projectId, 'Verträge und Personal: Bauleitung durch Frau M.', [restricted[0], restricted[1]])

      const listed = async (cleared: string[]) =>
        (
          await inTenant(() =>
            memory.listProjectMemory(projectId, { organizationId: ORG, clearedRestrictedCollections: cleared })
          )
        )
          .map((item) => item.content)
          .sort()
      const digest = (cleared: string[]) =>
        inTenant(() =>
          memory.buildProjectMemoryDigest(projectId, ORG, { clearedRestrictedCollections: cleared })
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
      const uncleared = { projectId, organizationId: ORG, clearedRestrictedCollections: [] }
      const cleared = { projectId, organizationId: ORG, clearedRestrictedCollections: [restricted[0]] }

      expect(await inTenant(() => memory.updateProjectMemoryItem(uncleared, secret.id, { pinned: true }))).toBeNull()
      expect(await inTenant(() => memory.deleteProjectMemoryItem(uncleared, secret.id))).toBe(false)
      expect(
        (await inTenant(() => memory.updateProjectMemoryItem(cleared, secret.id, { pinned: true })))?.pinned
      ).toBe(true)
      expect(await inTenant(() => memory.deleteProjectMemoryItem(cleared, secret.id))).toBe(true)
    })

    it('clears nobody for a collection whose restriction was lifted', async () => {
      const { projectId, collection, restricted, folderIds } = await seedProject('lifted')
      await write(projectId, 'Notiz aus einem später geöffneten Ordner', [restricted[0]])
      await inTenant(() =>
        db.execute(sql`
          update project_folders set restricted_roles = null, restricted_by = null, restricted_at = null
          where id = ${folderIds[0]}::uuid`)
      )

      const current = await folderAccess.currentRestrictedCollections(ORG, projectId, collection)
      expect(current).toEqual([restricted[1]])
      // Every caller passes CURRENT clearances, so the lifted note is served to nobody.
      const listed = await inTenant(() =>
        memory.listProjectMemory(projectId, { organizationId: ORG, clearedRestrictedCollections: current })
      )
      expect(listed).toEqual([])
    })
  })

  describe('the write validates the restriction', () => {
    it('stores a current restricted collection and refuses anything else', async () => {
      const { projectId, restricted } = await seedProject('validate')
      const stored = await inTenant(() =>
        memory.createProjectMemoryItemForProject(projectId, {
          kind: 'decision',
          content: 'Gültig eingeschränkt',
          restrictedCollections: [restricted[0]],
        })
      )
      expect(stored?.restrictedCollections).toEqual([restricted[0]])

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
  })

  describe('PROPOSAL_DECISIONS', () => {
    it('leaves out the card decisions of a conversation that ran a restricted turn', async () => {
      const { projectId } = await seedProject('decisions')
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
          insert into conversation_restricted_turns (organization_id, conversation_id)
          values (${ORG}, ${`restricted_${ORG}`})`)
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

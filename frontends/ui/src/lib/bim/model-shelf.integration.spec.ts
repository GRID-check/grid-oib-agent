/**
 * @vitest-environment node
 *
 * Which models a project can see, against a REAL Postgres.
 *
 * `listBimModels(..., { includeArchiv: true })` is the predicate behind three
 * surfaces: the project's model list, the agent's model resolution
 * (`/api/internal/bim/query`), and the revision series a compliance
 * confirmation is scoped to. It used to spell "the org-wide Archiv" as
 * `project_id IS NULL`, which was an exact description of the Archiv for
 * exactly as long as the Archiv was the only project-less shelf.
 *
 * ADR-0047 Phase 2 added a second one. A file dropped into a chat is
 * `scope = 'session'` with a NULL project and goes through the same extraction
 * dispatcher, so every IFC anyone attached to a private conversation became a
 * row this predicate returned — to every project in the organization, and to
 * the agent in every other conversation. Filename, storey counts, floor area,
 * and a model id that the query and source routes would then serve.
 *
 * A mock cannot show that: the thing under test is the SQL. So this runs
 * against the real migration chain, through the restricted runtime role, like
 * the rest of the BIM SQL suite (ADR-0041, `task db:test:rls`).
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/bim/model-shelf.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_shelf_${Date.now()}`

describe('the model-shelf suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(
      url,
      'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set, so the ' +
        'model-shelf suite skipped and nothing verified the SQL. Check `task db:test:rls`.'
    ).toBeTruthy()
  })
})

describe.skipIf(!url)('listBimModels shelf scoping', () => {
  let listBimModels: typeof import('./repository').listBimModels
  let closeDb: typeof import('@/lib/db').closeDb

  /** The models seeded below, by the shelf their document sits on. */
  const models: { project: string; otherProject: string; archiv: string; session: string } = {
    project: '',
    otherProject: '',
    archiv: '',
    session: '',
  }
  let PROJECT: string
  let OTHER_PROJECT: string

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const { getDb, closeDb: close } = await import('@/lib/db')
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    const repository = await import('./repository')
    listBimModels = repository.listBimModels
    closeDb = close
    const db = getDb()

    // Seeded through the platform role: a tenant-scoped insert cannot create
    // the projects and conversations the document rows point at, and
    // `documents.organization_id` has no FK (WorkOS owns org identity).
    const seedProject = async (name: string): Promise<string> => {
      const rows = await withPlatformAccess('seed a project', () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, collection_name, created_by)
          VALUES (${ORG}, ${name}, ${`proj_${name}`}, 'seed')
          RETURNING id
        `)
      )
      return Array.from(rows)[0].id
    }

    const seedConversation = async (id: string): Promise<string> => {
      await withPlatformAccess('seed a conversation', () =>
        db.execute(sql`
          INSERT INTO conversations (id, organization_id, created_by)
          VALUES (${id}, ${ORG}, 'seed')
        `)
      )
      return id
    }

    /**
     * A document on a named shelf. The scope/owner pairing is what migration
     * 0049's CHECK constraint insists on, so a row that gets it wrong fails
     * here rather than being quietly seeded into a state production cannot
     * reach — which would make the test prove nothing.
     */
    const seedDocument = async (input: {
      filename: string
      scope: 'project' | 'archiv' | 'session'
      projectId: string | null
      conversationId: string | null
    }): Promise<string> => {
      const rows = await withPlatformAccess('seed a document', () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status,
             scope, project_id, conversation_id)
          VALUES
            (${ORG}, 'seed', ${input.filename}, ${`seed/${input.filename}`}, 'seed', 'completed',
             ${input.scope}, ${input.projectId}::uuid, ${input.conversationId})
          RETURNING id
        `)
      )
      return Array.from(rows)[0].id
    }

    const seedModel = async (documentId: string, projectId: string | null): Promise<string> => {
      const rows = await withPlatformAccess('seed a model', () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO bim_models (organization_id, project_id, document_id, status)
          VALUES (${ORG}, ${projectId}::uuid, ${documentId}::uuid, 'ready')
          RETURNING id
        `)
      )
      return Array.from(rows)[0].id
    }

    PROJECT = await seedProject('haus-a')
    OTHER_PROJECT = await seedProject('haus-b')
    const conversation = await seedConversation(`s_shelf_${Date.now()}`)

    models.project = await seedModel(
      await seedDocument({
        filename: 'projekt.ifc',
        scope: 'project',
        projectId: PROJECT,
        conversationId: null,
      }),
      PROJECT
    )
    models.otherProject = await seedModel(
      await seedDocument({
        filename: 'anderes-projekt.ifc',
        scope: 'project',
        projectId: OTHER_PROJECT,
        conversationId: null,
      }),
      OTHER_PROJECT
    )
    models.archiv = await seedModel(
      await seedDocument({
        filename: 'buero-archiv.ifc',
        scope: 'archiv',
        projectId: null,
        conversationId: null,
      }),
      null
    )
    models.session = await seedModel(
      await seedDocument({
        filename: 'privater-chat.ifc',
        scope: 'session',
        projectId: null,
        conversationId: conversation,
      }),
      null
    )
  }, 60_000)

  afterAll(async () => {
    await closeDb?.()
  })

  it('gives a project its own models and the Archiv’s, and nobody else’s', async () => {
    const listed = await listBimModels(ORG, { projectId: PROJECT, includeArchiv: true })
    const ids = listed.map((model) => model.id).sort()

    expect(ids).toEqual([models.archiv, models.project].sort())
  })

  it('never hands a private chat’s model to a project', async () => {
    // The regression this suite exists for. `privater-chat.ifc` is readable
    // only inside its conversation; before the predicate read the SHELF it
    // appeared here, in every project in the organization.
    const listed = await listBimModels(ORG, { projectId: PROJECT, includeArchiv: true })

    expect(listed.map((model) => model.filename)).not.toContain('privater-chat.ifc')
    expect(listed.map((model) => model.id)).not.toContain(models.session)
  })

  it('never hands a private chat’s model to a project-less caller either', async () => {
    // What `/api/internal/bim/query` passes for a conversation with no project:
    // the org Archiv is what such a chat is entitled to, and nothing more.
    const listed = await listBimModels(ORG, { projectId: null, includeArchiv: true })

    expect(listed.map((model) => model.id)).toEqual([models.archiv])
  })

  it('keeps a project’s own scoping exact when the Archiv is not included', async () => {
    const listed = await listBimModels(ORG, { projectId: OTHER_PROJECT })

    expect(listed.map((model) => model.id)).toEqual([models.otherProject])
  })
})

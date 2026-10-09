/**
 * @vitest-environment node
 *
 * A revision task is judged when it is read, by the folder its document is in
 * NOW (ADR-0092), against a REAL Postgres through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/tasks/subject-access.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * Who holds which WorkOS role, and the project gate, are the things faked; the
 * folders, the document, the task runs and the thread are real rows. What it
 * proves, for a task opened while its document sat in an open folder and the
 * document since moved into a folder only some roles read:
 *   - the task list leaves it out for a member who may not read that folder,
 *     opening it answers 404, and the inbox redacts the rows naming its run,
 *     while a cleared member sees and opens it;
 *   - its thread reads as a conversation that drew on that folder, so the
 *     shared-chat lock closes it for the same member;
 *   - moving the document back opens both again: nothing was stored;
 *   - the staff views ask the database's rule (`grid_conversation_restricted_use`):
 *     a vote in the thread is shown, and the profiler names the thread, while
 *     the document sits at the project's root, and both are withheld once it
 *     sits in a folder of a project with an access list of its own;
 *   - that move marks the thread's messages and votes, so the staff views keep
 *     withholding them, and Langfuse their words, after the document moves
 *     back and after the thread is deleted (marks are sticky, ADR-0092).
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { FolderClearance } from '@/lib/authz/folder-access'
import { NO_RATINGS_FILTERS, type FeedbackQuery } from '@/lib/feedback/filters'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_subj_${STAMP}`

/** This organization's down-votes, over a range that holds every seeded vote. */
const DOWN_IN_ORG: FeedbackQuery = {
  scope: {
    from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    organizationIds: [ORG],
    projectIds: [],
  },
  ratings: { ...NO_RATINGS_FILTERS, verdict: 'down' },
}

/** Today's profiled turns in this organization, for the staff directory. */
const PROFILER_SCOPE = {
  start: new Date(Date.now() - 86_400_000),
  endExclusive: new Date(Date.now() + 86_400_000),
  organizationIds: [ORG],
  projectIds: [],
}
const CLEARED = `user_subj_cleared_${STAMP}`
const UNCLEARED = `user_subj_uncleared_${STAMP}`
const THREAD = `s_subj_thread_${STAMP}`

const clearances = new Map<string, FolderClearance>([
  [CLEARED, { roles: ['org-buchhaltung'], seesEverything: false }],
  [UNCLEARED, { roles: [], seesEverything: false }],
])

vi.mock('@/lib/authz/folder-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/folder-access')>()
  return {
    ...actual,
    clearanceOf: vi.fn(async (session: AuthorizedSession) => clearances.get(session.userId) ?? { roles: [], seesEverything: false }),
  }
})
vi.mock('@/lib/authz/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/authz/projects')>()
  return { ...actual, requireProjectAccess: vi.fn(async () => ({ closed: false, readsBecauseClosed: false })) }
})

const url = process.env.GRID_TEST_DATABASE_URL

describe('the revision-subject suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

function sessionOf(userId: string): AuthorizedSession {
  return {
    userId,
    email: `${userId}@grid.test`,
    name: userId,
    accessToken: 'token',
    organizationId: ORG,
    organizationMembershipId: `om_${userId}`,
    role: 'member',
    roles: [],
    permissions: [],
    featureFlags: null,
  }
}

describe.skipIf(!url)('revision tasks judged by their document’s current folder, against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let projectId = ''
  let restrictedFolder = ''
  let openFolder = ''
  let documentId = ''
  let revisionRun = ''
  let plainRun = ''

  const inOrg = <T>(fn: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: CLEARED }, fn)
  const first = <T>(rows: Iterable<T>): T => Array.from(rows)[0]

  const moveDocumentTo = (folderId: string | null) =>
    inOrg(() => db.execute(sql`update documents set folder_id = ${folderId}::uuid where id = ${documentId}::uuid`))

  /** What platform staff read of this organization: the drill-in, the lessons input, the profiler row of the thread. */
  async function staffSees() {
    const { listFeedbackTurns } = await import('@/lib/feedback/repository')
    const { listUnprocessedDownvotes } = await import('@/lib/platform-lessons/repository')
    const { listProfiledConversations } = await import('@/lib/profiler/repository')
    const turns = await withPlatformAccess('test: feedback drill-in', () =>
      listFeedbackTurns(DOWN_IN_ORG)
    )
    const reports = (await withPlatformAccess('test: lessons sweep input', () => listUnprocessedDownvotes(500))).filter(
      (report) => report.organizationId === ORG
    )
    const profiled = (await listProfiledConversations(PROFILER_SCOPE, THREAD)).rows.find((row) => row.conversationId === THREAD)
    return {
      answers: turns.map((turn) => turn.answer),
      titles: turns.map((turn) => turn.conversationTitle),
      reports: reports.map((report) => report.answer),
      profiled: profiled ? { title: profiled.title, titleWithheld: profiled.titleWithheld } : null,
    }
  }

  const threadMarks = async () =>
    Number(
      first(
        await inOrg(() =>
          db.execute<{ n: number }>(
            sql`select count(*)::int as n from message_restricted_use where organization_id = ${ORG} and conversation_id = ${THREAD}`
          )
        )
      ).n
    )

  /** Whether the thread's vote is scored in Langfuse without its words (`isRestrictedUseVote`, the same rule). */
  async function scoredWithoutWords(): Promise<boolean> {
    const { isRestrictedUseVote } = await import('@/lib/feedback/repository')
    const vote = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`select id from answer_feedback where organization_id = ${ORG} limit 1`)
      )
    )
    return inOrg(() => isRestrictedUseVote(String(vote.id), ORG))
  }

  async function seen(userId: string) {
    const { listTasks } = await import('./service')
    const { getRunView } = await import('@/lib/runs/service')
    const { lockedConversationIds } = await import('@/lib/conversations/restricted-use')
    const { unreadableRunIds } = await import('./subject-access')
    const session = sessionOf(userId)
    return inOrg(async () => ({
      listed: (await listTasks(session, projectId)).map((run) => run.id).sort(),
      inboxWithheld: [
        ...(await unreadableRunIds(session, [
          { projectId, runId: revisionRun },
          { projectId, runId: plainRun },
        ])),
      ],
      opened: await getRunView(session, projectId, revisionRun).then(
        () => 'opened',
        (error: unknown) => (error instanceof NotFoundError ? 'not found' : String(error))
      ),
      threadLocked: (await lockedConversationIds(session, [{ id: THREAD, projectId }])).has(THREAD),
    }))
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    const collection = `proj_subj_${STAMP}`
    projectId = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, 'Revision subjects', ${CLEARED}, ${collection}) returning id`)
        )
      ).id
    )
    // One statement: the 0110 trigger checks at commit that a custom list is not empty.
    restrictedFolder = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            with folder as (
              insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
              values (${ORG}, ${projectId}::uuid, 'Honorare', 'Honorare', 'custom', ${CLEARED}, now())
              returning id, project_id
            ), grants as (
              insert into project_folder_grants (organization_id, project_id, folder_id, role_slug, level)
              select ${ORG}, project_id, id, 'org-buchhaltung', 'read' from folder
            )
            select id from folder`)
        )
      ).id
    )
    openFolder = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into project_folders (organization_id, project_id, name, path)
            values (${ORG}, ${projectId}::uuid, 'Pläne', 'Pläne') returning id`)
        )
      ).id
    )
    documentId = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
            values (${ORG}, ${CLEARED}, 'angebot.md', ${`k/subj/${STAMP}`}, ${collection}, 'completed', 'project', ${projectId}::uuid, ${openFolder}::uuid)
            returning id`)
        )
      ).id
    )
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility, title)
        values (${THREAD}, ${ORG}, ${CLEARED}, ${projectId}::uuid, 'project', 'Aufgabe: Überarbeitung')`)
    )
    const plan = {
      prompt: 'Überarbeite den Entwurf: Zimmerer 48.000 EUR',
      skill: {},
      dataSources: null,
      goal: 'Honorar korrigieren',
      subject: { documentId, versionId: documentId, comment: 'Honorar korrigieren' },
    }
    revisionRun = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot, conversation_id)
            values (${ORG}, ${projectId}::uuid, 'revision', 'Überarbeitung: Honorar korrigieren', ${JSON.stringify(plan)}::jsonb,
                    ${CLEARED}, 'delegated', 'succeeded', '{}'::jsonb, ${THREAD})
            returning id`)
        )
      ).id
    )
    plainRun = String(
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot)
            values (${ORG}, ${projectId}::uuid, 'document', 'Aktenvermerk', '{"prompt":"Schreibe","skill":{},"dataSources":null}'::jsonb,
                    ${CLEARED}, 'delegated', 'succeeded', '{}'::jsonb)
            returning id`)
        )
      ).id
    )
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from answer_feedback where organization_id = ${ORG}`)
      await db.execute(sql`delete from agent_profiler_spans where organization_id = ${ORG}`)
      await db.execute(sql`delete from task_runs where organization_id = ${ORG}`)
      await db.execute(sql`delete from conversations where organization_id = ${ORG}`)
      await db.execute(sql`delete from documents where organization_id = ${ORG}`)
      await db.execute(sql`delete from project_folders where project_id = ${projectId}::uuid`)
      await db.execute(sql`delete from projects where organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('shows a task to everyone while its document sits in an open folder', async () => {
    const both = [plainRun, revisionRun].sort()
    expect(await seen(UNCLEARED)).toEqual({ listed: both, inboxWithheld: [], opened: 'opened', threadLocked: false })
    expect(await seen(CLEARED)).toEqual({ listed: both, inboxWithheld: [], opened: 'opened', threadLocked: false })
  })

  it('withholds it, and closes its thread, once the document moves into a folder the reader may not read', async () => {
    await moveDocumentTo(restrictedFolder)
    expect(await seen(UNCLEARED)).toEqual({
      listed: [plainRun],
      inboxWithheld: [revisionRun],
      opened: 'not found',
      threadLocked: true,
    })
    expect(await seen(CLEARED)).toEqual({
      listed: [plainRun, revisionRun].sort(),
      inboxWithheld: [],
      opened: 'opened',
      threadLocked: false,
    })
  })

  it('shows it again when the document moves back: nothing was stored', async () => {
    await moveDocumentTo(openFolder)
    expect(await seen(UNCLEARED)).toEqual({
      listed: [plainRun, revisionRun].sort(),
      inboxWithheld: [],
      opened: 'opened',
      threadLocked: false,
    })
  })

  /**
   * Staff read across organizations and hold no clearance to ask, so the
   * database answers with a superset of the folder rule. Nothing is marked
   * while the document sits at the project's root; moving it is enough, and
   * the move marks the thread.
   */
  it('keeps the thread out of the staff views once its document sits in a folder of a project with an access list', async () => {
    await moveDocumentTo(null)
    const draft = `Überarbeiteter Entwurf: Zimmerer 48.000 EUR ${STAMP}`
    await inOrg(async () => {
      await db.execute(sql`
        insert into messages (conversation_id, organization_id, role, content, created_at)
        values (${THREAD}, ${ORG}, 'user', 'Bitte das Honorar prüfen', now() - interval '2 minutes')`)
      const answer = first(
        await db.execute<{ id: string }>(sql`
          insert into messages (conversation_id, organization_id, role, content, created_at)
          values (${THREAD}, ${ORG}, 'assistant', ${draft}, now() - interval '1 minute') returning id`)
      )
      await db.execute(sql`
        insert into answer_feedback (organization_id, conversation_id, message_id, user_id, verdict, reason, comment)
        values (${ORG}, ${THREAD}, ${String(answer.id)}, ${CLEARED}, 'down', 'inaccurate', 'Honorar Zimmerer falsch')`)
      await db.execute(sql`
        insert into agent_profiler_spans (organization_id, conversation_id, turn_id, span_id, kind, name, started_at, ended_at, duration_ms)
        values (${ORG}, ${THREAD}, ${`turn_${THREAD}`}, ${`span_${THREAD}`}, 'turn', 'turn', now(), now(), 10)`)
    })

    expect(await staffSees()).toEqual({
      answers: [draft],
      titles: ['Aufgabe: Überarbeitung'],
      reports: [draft],
      profiled: { title: 'Aufgabe: Überarbeitung', titleWithheld: false },
    })

    expect(await threadMarks()).toBe(0)
    await moveDocumentTo(restrictedFolder)
    expect(await staffSees()).toEqual({
      answers: [],
      titles: [],
      reports: [],
      profiled: { title: null, titleWithheld: true },
    })
    // The question, the answer and the vote's message id: one mark each, the
    // answer's shared by the message and the vote.
    expect(await threadMarks()).toBe(2)
  })

  /**
   * The rule's revision branch is asked at read time, and forgets the thread
   * once the document moves back or the thread is deleted (its task's
   * `conversation_id` is set null). The marks the move wrote do not, and the
   * rule asks them: ordinary chats and revision threads are both sticky.
   */
  it('keeps the thread out of the staff views and Langfuse after the document moves back and the thread is deleted', async () => {
    const hidden = { answers: [], titles: [], reports: [] }
    await moveDocumentTo(null)
    expect(await staffSees()).toEqual({ ...hidden, profiled: { title: null, titleWithheld: true } })
    expect(await scoredWithoutWords()).toBe(true)

    await inOrg(() => db.execute(sql`delete from conversations where id = ${THREAD}`))
    expect(
      Number(
        first(
          await inOrg(() =>
            db.execute<{ n: number }>(sql`select count(*)::int as n from messages where conversation_id = ${THREAD}`)
          )
        ).n
      )
    ).toBe(0)
    expect(await staffSees()).toEqual({ ...hidden, profiled: { title: null, titleWithheld: true } })
    expect(await scoredWithoutWords()).toBe(true)
    expect(await threadMarks()).toBe(2)
  })
})

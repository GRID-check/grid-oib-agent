/**
 * @vitest-environment node
 */
/**
 * The one route a machine may delegate work through (ADR-0051, ADR-0055).
 *
 * The assertions that matter are the same four this repo already pays for on
 * the document route, because it is the same door: an unsigned request must not
 * get in, a replayed envelope must not work forever, the BODY must not be able
 * to name its own acting user, and the op set must be closed. The fifth is this
 * route's own: the tenant slot comes from the verified envelope, so a body
 * naming another organization changes nothing about which tenant is entered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/tasks/delegation', () => ({ delegateTask: vi.fn(), commissionResearchRun: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
// Partial: the factory itself opens a request-scoped slot, and replacing that
// would test a handler the app does not run.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { withTenant } from '@/lib/db/tenant-context'
import {
  GRID_HEADER_NAMES,
  buildGridRequestContextEnvelope,
  GRID_REQUEST_CONTEXT_MAX_AGE_MS,
} from '@/lib/request-context'
import { DELEGATABLE_TASK_KINDS } from '@/lib/db/schema'
import { commissionResearchRun, delegateTask } from '@/lib/tasks/delegation'
import { internalTaskRequestSchema, parseTaskDue } from '@/lib/tasks/wire'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const PROJECT = '33333333-3333-4333-8333-333333333333'

const session = {
  userId: 'user_requester',
  email: 'r@grid.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}

const task = {
  id: 'task-1',
  title: 'Einreichcheck: Bauansuchen Haus A',
  status: 'running',
  conversationId: 's_conv_2',
  deadlineAt: new Date('2026-09-18T23:59:59.999Z'),
}

/**
 * A one-off definition, the default answer `delegateTask` gives: the run beside
 * it is the attempt, and there is no next fire to serialize.
 */
const oneOffDefinition = {
  id: 'task-1',
  title: 'Einreichcheck: Bauansuchen Haus A',
  dueAt: new Date('2026-09-18T23:59:59.999Z'),
  nextRunAt: null,
}

/** A scheduled definition: no run yet, but a first fire the reader can see. */
const scheduledDefinition = {
  ...oneOffDefinition,
  nextRunAt: new Date('2026-09-21T08:00:00.000Z'),
}

function envelopeHeaders(
  overrides: {
    issuedAt?: number
    userId?: string
    organizationId?: string
    projectId?: string | null
  } = {},
) {
  const { header, signature } = buildGridRequestContextEnvelope(
    {
      organizationId: overrides.organizationId ?? 'org_1',
      userId: overrides.userId ?? 'user_requester',
      ...(overrides.projectId === null ? {} : { projectId: overrides.projectId ?? PROJECT }),
      conversationId: 's_conv_1',
      issuedAt: overrides.issuedAt ?? Date.now(),
    },
    SECRET,
  )
  return {
    [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
    [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
  }
}

function call(body: unknown, headers: Record<string, string> = envelopeHeaders()) {
  return POST(
    new Request('https://grid.test/api/internal/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grid-internal-token': SECRET, ...headers },
      body: JSON.stringify(body),
    }),
  )
}

const CREATE = { op: 'create', projectId: PROJECT, kind: 'einreichcheck', goal: 'Prüf die Einreichung' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(delegateTask).mockResolvedValue({ definition: oneOffDefinition, run: task } as never)
  vi.mocked(commissionResearchRun).mockResolvedValue({
    runId: 'run-1',
    runMessageId: 'msg-run-1',
    conversationId: 's_conv_1',
    status: 'running',
  })
})

describe('identity', () => {
  it('refuses a call with no envelope, before it reads the body', async () => {
    // The internal token alone gets nothing: it authenticates the SERVICE, and
    // the agent's principal is wider than any human's.
    const response = await call(CREATE, {})
    expect(response.status).toBe(401)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('refuses a tampered signature', async () => {
    const headers = envelopeHeaders()
    headers[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG] = 'f'.repeat(64)
    expect((await call(CREATE, headers)).status).toBe(401)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('refuses an envelope older than its window', async () => {
    const stale = envelopeHeaders({ issuedAt: Date.now() - GRID_REQUEST_CONTEXT_MAX_AGE_MS - 1000 })
    expect((await call(CREATE, stale)).status).toBe(401)
  })

  it('creates the task in the session of the person the ENVELOPE names', async () => {
    await call(CREATE, envelopeHeaders({ userId: 'user_someone_else' }))

    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user_someone_else',
      email: null,
      organizationId: 'org_1',
    })
    expect(vi.mocked(delegateTask).mock.calls[0][0]).toBe(session)
  })

  it('refuses a requester who is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect((await call(CREATE)).status).toBe(403)
    expect(delegateTask).not.toHaveBeenCalled()
  })
})

describe('tenancy', () => {
  it('opens the tenant slot from the verified envelope, never from the body', async () => {
    await call({ ...CREATE, organizationId: 'org_2' }, envelopeHeaders({ organizationId: 'org_1' }))
    // `.strict()` refuses the extra field outright, which is the stronger
    // answer: there is no body field the tenant could be read from at all.
    expect(delegateTask).not.toHaveBeenCalled()

    await call(CREATE, envelopeHeaders({ organizationId: 'org_1' }))
    expect(vi.mocked(withTenant).mock.calls[0][0]).toEqual({ organizationId: 'org_1' })
  })
})

describe('the op set', () => {
  it('is the two asking verbs and nothing else', () => {
    // A machine may ASK for work, in either shape. Judging it is `reviewTask`,
    // a session route: a machine that could accept its own output would close
    // the loop ADR-0051 exists to open.
    expect(internalTaskRequestSchema.options.map((option) => option.shape.op.value)).toEqual([
      'create',
      'research',
    ])
  })

  it('refuses an unknown op and an unknown kind', async () => {
    expect((await call({ ...CREATE, op: 'review' })).status).toBe(400)
    expect(commissionResearchRun).not.toHaveBeenCalled()
    expect((await call({ ...CREATE, kind: 'kostenschaetzung' })).status).toBe(400)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('accepts every delegatable kind and no job output', async () => {
    for (const kind of DELEGATABLE_TASK_KINDS) {
      expect((await call({ ...CREATE, kind })).status).toBe(201)
    }
    expect((await call({ ...CREATE, kind: 'deep-research' })).status).toBe(400)
  })
})

describe('the answer', () => {
  it('names the row, the thread and the deadline it actually stored', async () => {
    const response = await call({ ...CREATE, due: '2026-09-18' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      taskId: 'task-1',
      kind: 'einreichcheck',
      title: 'Einreichcheck: Bauansuchen Haus A',
      status: 'running',
      conversationId: 's_conv_2',
      dueAt: '2026-09-18T23:59:59.999Z',
      scheduled: false,
      nextRunAt: null,
    })
  })

  it('answers a cadence with the schedule and its first fire, and no run', async () => {
    vi.mocked(delegateTask).mockResolvedValue({ definition: scheduledDefinition, run: null } as never)

    const response = await call({ ...CREATE, cadence: '0 8 * * 1' })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      taskId: 'task-1',
      status: 'scheduled',
      conversationId: null,
      scheduled: true,
      nextRunAt: '2026-09-21T08:00:00.000Z',
    })
    // The cadence and its zone travel to the service; the default zone is the
    // BFF's (`delegateTask`), not a second one invented here.
    expect(vi.mocked(delegateTask).mock.calls[0][1]).toMatchObject({
      cadence: { cron: '0 8 * * 1', timezone: undefined },
    })
  })

  it('refuses a cadence with an empty string rather than sending it', async () => {
    expect((await call({ ...CREATE, cadence: '   ' })).status).toBe(400)
  })
})

describe('parseTaskDue', () => {
  it('reads a bare date as the END of that day', () => {
    // „bis Freitag" means the whole of Friday; midnight-at-the-start would make
    // every date-only deadline a day early.
    expect(parseTaskDue('2026-09-18')?.toISOString()).toBe('2026-09-18T23:59:59.999Z')
  })

  it('keeps a full instant as it is, and drops what is not a date at all', () => {
    expect(parseTaskDue('2026-09-18T09:00:00.000Z')?.toISOString()).toBe('2026-09-18T09:00:00.000Z')
    // A task with no deadline still does the work; refusing the whole
    // delegation over a mistyped date would lose the work to fix a field
    // nothing enforces yet.
    expect(parseTaskDue('bis Freitag')).toBeNull()
    expect(parseTaskDue(undefined)).toBeNull()
  })
})

describe('the project the body names must be the project the envelope names', () => {
  it('queues the work when both agree', async () => {
    expect((await call(CREATE)).status).toBe(201)
  })

  it('refuses a body pointed at a DIFFERENT project, and queues nothing', async () => {
    // A task queues a run that FILES as this person and spends their budget, so
    // a replayed envelope pointed at a second project would be work nobody
    // asked for, attributed to somebody who did not ask for it.
    const other = '99999999-9999-4999-8999-999999999999'
    const response = await call({ ...CREATE, projectId: other })

    expect(response.status).toBe(400)
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('constrains nothing when the envelope names no project', async () => {
    const other = '99999999-9999-4999-8999-999999999999'
    const response = await call(
      { ...CREATE, projectId: other },
      envelopeHeaders({ projectId: null }),
    )

    expect(response.status).toBe(201)
    expect(vi.mocked(delegateTask).mock.calls[0][1]).toMatchObject({ projectId: other })
  })
})


describe('the research op — an escalated question becomes a run', () => {
  const RESEARCH = {
    op: 'research',
    projectId: PROJECT,
    question: 'Gilt für das Atrium OIB 2 oder OIB 2.3?',
  }

  it('commissions the run in the thread the ENVELOPE names, and answers with where it narrates', async () => {
    const response = await call(RESEARCH)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      runId: 'run-1',
      runMessageId: 'msg-run-1',
      conversationId: 's_conv_1',
      status: 'running',
    })
    expect(vi.mocked(commissionResearchRun).mock.calls[0][1]).toEqual({
      projectId: PROJECT,
      // From the signed envelope, never the body: a thread a caller could name
      // would be a block written into a conversation nobody asked about.
      conversationId: 's_conv_1',
      question: RESEARCH.question,
      // Absent here: this turn settled nothing with the person first.
      context: null,
    })
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('refuses a body that names its own thread or a second project', async () => {
    expect((await call({ ...RESEARCH, conversationId: 's_somewhere_else' })).status).toBe(400)
    expect(
      (await call({ ...RESEARCH, projectId: '44444444-4444-4444-8444-444444444444' })).status,
    ).toBe(400)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })

  it('carries what the turn already settled with the person, when it has some', async () => {
    await call({ ...RESEARCH, context: 'Frage: Welches Geschoss? Antwort: Erdgeschoss.' })

    expect(vi.mocked(commissionResearchRun).mock.calls[0][1]).toMatchObject({
      context: 'Frage: Welches Geschoss? Antwort: Erdgeschoss.',
    })
  })

  it('refuses a question that says nothing', async () => {
    expect((await call({ ...RESEARCH, question: '   ' })).status).toBe(400)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })

  it('answers 409 when the envelope carries no thread: there is nowhere to narrate', async () => {
    const { header, signature } = buildGridRequestContextEnvelope(
      { organizationId: 'org_1', userId: 'user_requester', projectId: PROJECT, issuedAt: Date.now() },
      SECRET,
    )
    const response = await call(RESEARCH, {
      [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
      [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
    })

    expect(response.status).toBe(409)
    expect(commissionResearchRun).not.toHaveBeenCalled()
  })
})

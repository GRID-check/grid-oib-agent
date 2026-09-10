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

vi.mock('@/lib/tasks/delegation', () => ({ delegateTask: vi.fn() }))
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
import { delegateTask } from '@/lib/tasks/delegation'
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
  vi.mocked(delegateTask).mockResolvedValue(task as never)
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
  it('is `create` and nothing else', () => {
    // A machine may ASK for work. Judging it is `reviewTask`, a session route:
    // a machine that could accept its own output would close the loop ADR-0051
    // exists to open.
    expect(internalTaskRequestSchema.options).toHaveLength(1)
    expect(internalTaskRequestSchema.options[0].shape.op.value).toBe('create')
  })

  it('refuses an unknown op and an unknown kind', async () => {
    expect((await call({ ...CREATE, op: 'review' })).status).toBe(400)
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
    })
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

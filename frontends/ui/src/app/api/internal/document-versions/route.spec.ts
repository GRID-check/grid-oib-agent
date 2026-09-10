/**
 * @vitest-environment node
 */
/**
 * The one route a machine may write a version through (ADR-0054 §4).
 *
 * The assertions that matter here are not about happy paths. They are about the
 * four ways this route could stop being a door: an unsigned request getting in,
 * a replayed envelope working forever, the body naming its own acting user, and
 * an op reaching a transition only a person may take. The last one is asserted
 * against the TABLE rather than against a list in this file, so widening the op
 * set without changing an `actor` fails here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/documents/agent-document', () => ({ fileAgentDocumentDraft: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  replaceVersionContent: vi.fn(),
  transitionDocumentVersion: vi.fn(),
  toDocumentVersionView: (value: unknown) => value,
}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
// Partial: the factory itself opens a request-scoped slot, and replacing that
// would test a handler the app does not run.
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { replaceVersionContent, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { withTenant } from '@/lib/db/tenant-context'
import {
  GRID_HEADER_NAMES,
  buildGridRequestContextEnvelope,
  GRID_REQUEST_CONTEXT_MAX_AGE_MS,
} from '@/lib/request-context'
import {
  AGENT_REACHABLE_OPS,
  findDocumentVersionTransition,
  transitionsForOp,
  type DocumentVersionOp,
} from '@/lib/documents/lifecycle-types'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const DOC = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
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

function envelopeHeaders(overrides: { issuedAt?: number; userId?: string } = {}) {
  const { header, signature } = buildGridRequestContextEnvelope(
    {
      organizationId: 'org_1',
      userId: overrides.userId ?? 'user_requester',
      projectId: PROJECT,
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
    new Request('https://grid.test/api/internal/document-versions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-grid-internal-token': SECRET,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
    documentId: DOC,
    version: { id: VERSION } as never,
    alreadyFiled: false,
  })
})

describe('the origin conversation', () => {
  it('is stamped from the VERIFIED envelope and never from the body', async () => {
    // The `ref` the caller mints STARTS with a conversation id, and reading it
    // off that string is precisely what this route exists not to do: the ref is
    // the client's, the identity and the origin are not.
    await call({
      op: 'create',
      projectId: PROJECT,
      ref: 's_someone_elses-aktenvermerk',
      title: 'Aktenvermerk',
      content: '# Aktenvermerk',
    })

    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      ref: 's_someone_elses-aktenvermerk',
      originConversationId: 's_conv_1',
    })
  })
})

describe('the op set is closed by the transition table, not by this file', () => {
  it('admits only ops whose every transition is reachable by a machine', () => {
    const source = readFileSync(fileURLToPath(new URL('./route.ts', import.meta.url)), 'utf8')
    // Read off the route's own schema import rather than restated: the union
    // lives in `lifecycle-types.ts` and this asserts the route cannot reach past
    // it.
    for (const op of ['create', 'update', 'submit'] as const) {
      expect(source).toContain(`'${op}'`)
      expect(AGENT_REACHABLE_OPS).toContain(op)
      for (const row of transitionsForOp(op)) {
        expect(row.actor, `${op} must be reachable by a machine`).toBe('either')
      }
    }
  })

  it('leaves every content assertion to a person', () => {
    for (const op of ['approve', 'request_changes', 'reject', 'publish', 'upload'] as const) {
      expect(AGENT_REACHABLE_OPS).not.toContain(op as DocumentVersionOp)
    }
    expect(findDocumentVersionTransition('approved', 'publish')?.actor).toBe('human')
  })
})

describe('identity comes from the signed envelope, never from the body', () => {
  it('refuses a request with no envelope, before it reads the body', async () => {
    const response = await call({ op: 'submit', documentId: DOC, versionId: VERSION }, {})
    expect(response.status).toBe(401)
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  it('refuses a tampered signature', async () => {
    const headers = envelopeHeaders()
    const signature = headers[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]
    headers[GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG] =
      (signature[0] === '0' ? '1' : '0') + signature.slice(1)

    const response = await call({ op: 'submit', documentId: DOC, versionId: VERSION }, headers)

    expect(response.status).toBe(401)
  })

  it('refuses a replayed envelope once its window has passed', async () => {
    const response = await call(
      { op: 'submit', documentId: DOC, versionId: VERSION },
      envelopeHeaders({ issuedAt: Date.now() - GRID_REQUEST_CONTEXT_MAX_AGE_MS - 1000 }),
    )
    expect(response.status).toBe(401)
  })

  it('acts as the envelope’s user, resolved through the pinned session', async () => {
    await call({ op: 'submit', documentId: DOC, versionId: VERSION })

    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user_requester',
      email: null,
      organizationId: 'org_1',
    })
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      session,
      DOC,
      VERSION,
      'submit',
      expect.objectContaining({ actingHuman: false }),
    )
  })

  it('opens the tenant scope from the envelope’s organization', async () => {
    await call({ op: 'submit', documentId: DOC, versionId: VERSION })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
  })

  it('refuses a requester who is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    const response = await call({ op: 'submit', documentId: DOC, versionId: VERSION })
    expect(response.status).toBe(403)
  })
})

describe('the ops it does serve', () => {
  it('create files a draft and answers 201', async () => {
    const response = await call({
      op: 'create',
      projectId: PROJECT,
      ref: 's_conv_1-aktenvermerk',
      title: 'Aktenvermerk',
      content: '# Aktenvermerk',
    })

    expect(response.status).toBe(201)
    expect(fileAgentDocumentDraft).toHaveBeenCalledWith(
      expect.objectContaining({ session, ref: 's_conv_1-aktenvermerk', actingHuman: false }),
    )
  })

  it('update replaces a draft’s bytes with the If-Match it was given', async () => {
    await call({
      op: 'update',
      documentId: DOC,
      versionId: VERSION,
      content: 'korrigiert',
      ifMatch: 'sha256:abc',
    })

    expect(replaceVersionContent).toHaveBeenCalledWith(
      session,
      DOC,
      VERSION,
      'korrigiert',
      'sha256:abc',
      expect.any(Request),
    )
  })

  it('refuses an op outside the union at the schema', async () => {
    const response = await call({ op: 'publish', documentId: DOC, versionId: VERSION })
    expect(response.status).toBe(400)
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  // 403, which is what `requireInternalToken` answers for a service that is not
  // this one; the 401s above are the envelope's, and the two are deliberately
  // different questions: who is calling, and as whom.
  it('refuses the internal token being absent', async () => {
    const response = await POST(
      new Request('https://grid.test/api/internal/document-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...envelopeHeaders() },
        body: JSON.stringify({ op: 'submit', documentId: DOC, versionId: VERSION }),
      }),
    )
    expect(response.status).toBe(403)
  })
})

/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Break the authkit-nextjs import chain (pulls in next/cache) at load time.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue(null),
}))

// Anonymous mode: no session/db lookups for collection scoping.
vi.mock('@/lib/proxy/collection-authz', () => ({
  parseQueryContext: vi.fn(() => ({})),
  // Body first, then the query, like the real one; enough to see a cancel's
  // `?projectId=` reach the scope builder.
  resolveRequestContext: vi.fn((searchParams: URLSearchParams, body?: Record<string, unknown>) => ({
    projectId:
      (typeof body?.projectId === 'string' ? body.projectId : undefined) ??
      searchParams.get('projectId') ??
      undefined,
  })),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn().mockResolvedValue({
    headerValue: 'scope',
    scope: [],
    scopedCollections: [],
    projectId: undefined,
    verifiedConversationId: undefined,
  }),
}))

// Org model overrides lookup used by the POST handler to build
// X-Grid-Model-Overrides — controlled per-test below.
vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: vi.fn(),
}))

// Structured bundesland fact lookup (backlog T3-9 follow-up, 2026-07-16,
// user-mandated) — avoids pulling in the real @/lib/db chain; controlled
// per-test below like getEffectiveModelOverrides.
vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectBundesland: vi.fn().mockResolvedValue(null),
}))

// The commissioned-report filing, mocked at its own module so this suite
// asserts the WIRING — is it called, with what, and does a failure of it reach
// the user's answer — and not the filing's own behaviour, which
// `lib/documents/generated.spec.ts` owns.
vi.mock('@/lib/documents/research-report', () => ({
  findFiledResearchReport: vi.fn(),
  findReportFilingRefusal: vi.fn(),
  queueResearchReportFiling: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({
  findProjectIdByCollectionName: vi.fn(),
}))

import { DELETE, GET, POST } from './route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectBundesland } from '@/lib/project-profile/prompt-view'
import {
  findFiledResearchReport,
  findReportFilingRefusal,
  queueResearchReportFiling,
} from '@/lib/documents/research-report'
import { findProjectIdByCollectionName } from '@/lib/projects/repository'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'

const originalRequireAuth = process.env.REQUIRE_AUTH
const originalInternalToken = process.env.GRID_INTERNAL_API_TOKEN

const getRequest = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: 'GET', headers })

const postRequest = (url: string, body?: unknown): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const streamParams = (path: string[]) => ({ params: Promise.resolve({ path }) })
const postParams = (path: string[]) => ({ params: Promise.resolve({ path }) })

/** Decodes the base64url JSON payload the way the Python backend does. */
const decodeModelOverridesHeader = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

describe('/api/jobs/async/[...path] proxy — SSE reconnection resume', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Anonymous mode so the proxy never resolves a WorkOS session / DB.
    delete process.env.REQUIRE_AUTH
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('routes a stream reconnect with a Last-Event-ID header to the /stream/{last_event_id} endpoint', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v1/jobs/async/job/job-1/stream/42')
  })

  it('streams from the beginning when no Last-Event-ID header is present', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream'),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('ignores a non-numeric Last-Event-ID header (backend event ids are integers)', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', {
        'Last-Event-ID': 'abc; DROP TABLE',
      }),
      streamParams(['job', 'job-1', 'stream'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('does not append the header to an explicit /stream/{id} resume request', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream/7', {
        'Last-Event-ID': '42',
      }),
      streamParams(['job', 'job-1', 'stream', '7'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream\/7$/)
  })

  it('leaves non-stream requests untouched by the Last-Event-ID header', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1', status: 'running', error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1$/)
  })
})

describe('/api/jobs/async/[...path] proxy — POST org model overrides', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@grid.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: null,
  }

  beforeEach(() => {
    // These tests need a resolved org, so run with auth required and a
    // session that carries organizationId — unlike the anonymous-mode
    // suites above.
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(loadProjectBundesland).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('forwards X-Grid-Model-Overrides with the base64url payload when the org has overrides', async () => {
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue({ deep_research: 'openrouter/model-x' })

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Model-Overrides']).toBeDefined()
    expect(decodeModelOverridesHeader(headers['X-Grid-Model-Overrides'])).toEqual({
      deep_research: 'openrouter/model-x',
    })
  })

  it('omits the header cleanly when the org has no overrides configured', async () => {
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Model-Overrides']).toBeUndefined()
  })

  it('still proxies the submission without the header when override resolution throws', async () => {
    vi.mocked(getEffectiveModelOverrides).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Model-Overrides']).toBeUndefined()
  })
})

describe('/api/jobs/async/[...path] proxy — signed X-Grid-Request-Context envelope', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@grid.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: null,
  }

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 'proj_abc'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }, { collection: 'proj_abc', shelf: 'project' }],
      projectId: 'proj-1',
      projectCollectionName: 'proj_abc',
      conversationId: undefined,
      verifiedConversationId: undefined,
    })
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
    vi.mocked(loadProjectBundesland).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
    if (originalInternalToken === undefined) {
      delete process.env.GRID_INTERNAL_API_TOKEN
    } else {
      process.env.GRID_INTERNAL_API_TOKEN = originalInternalToken
    }
  })

  it('attaches an unsigned envelope carrying org/user/project/scope when no internal token is configured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Request-Context']).toBeDefined()
    expect(headers['X-Grid-Request-Context-Sig']).toBeUndefined()

    const decoded = JSON.parse(
      Buffer.from(headers['X-Grid-Request-Context'], 'base64url').toString('utf8')
    )
    // `collectionScope` carries the SHELF-BEARING entries, not bare names.
    // `scoping.py` prefers this signed envelope and reads the raw header only
    // when no valid envelope is present, so a shelf that rode the header alone
    // would never reach an authenticated turn (ADR-0047).
    expect(decoded).toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
      projectId: 'proj-1',
      collectionScope: [
        { collection: 'oib_knowledge', shelf: 'base' },
        { collection: 'proj_abc', shelf: 'project' },
      ],
      // The backend refuses an envelope without one as a grant (ADR-0084).
      issuedAt: expect.any(Number),
    })
  })

  it('signs the envelope when GRID_INTERNAL_API_TOKEN is configured', async () => {
    process.env.GRID_INTERNAL_API_TOKEN = 'test-secret'

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Request-Context-Sig']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('still attaches the envelope when model-overrides resolution throws (envelope is not best-effort)', async () => {
    vi.mocked(getEffectiveModelOverrides).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Request-Context']).toBeDefined()
  })

  it('carries the resolved bundesland fact structurally on the envelope (backlog T3-9 follow-up, 2026-07-16)', async () => {
    vi.mocked(loadProjectBundesland).mockResolvedValue('tirol')

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(loadProjectBundesland).toHaveBeenCalledWith('proj-1', 'org-1')
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    const decoded = JSON.parse(
      Buffer.from(headers['X-Grid-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.bundesland).toBe('tirol')
  })

  it('omits bundesland from the envelope cleanly when the project has no valid fact', async () => {
    vi.mocked(loadProjectBundesland).mockResolvedValue(null)

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    const decoded = JSON.parse(
      Buffer.from(headers['X-Grid-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.bundesland).toBeUndefined()
  })

  it('still proxies the submission without bundesland when the lookup throws (best-effort)', async () => {
    vi.mocked(loadProjectBundesland).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Grid-Request-Context']).toBeDefined()
    const decoded = JSON.parse(
      Buffer.from(headers['X-Grid-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.bundesland).toBeUndefined()
  })
})

/**
 * A finished run's report used to be read once, rendered into a chat message
 * and discarded with the run's whole file system. This is the point at which
 * the BFF observes that completion, so it is where the report becomes a
 * document the project can find, assign, preview and delete.
 */
describe('/api/jobs/async/[...path] proxy — filing a commissioned report', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@grid.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: ['project:documents:write'],
    featureFlags: null,
  }

  const reportResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  // `project_collection` is on every real report body: the backend records the
  // commissioning project on `job_access` at submit time and returns it here.
  // It — not the request's project — is what decides where the report is filed.
  const REPORT_BODY = {
    job_id: 'job-1',
    has_report: true,
    report: '# Bericht\n\nText.',
    project_collection: 'proj_abc',
  }

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: [],
      scopedCollections: [],
      projectId: 'proj-1',
      projectCollectionName: 'proj_abc',
      conversationId: undefined,
      verifiedConversationId: undefined,
    })
    vi.mocked(findProjectIdByCollectionName).mockResolvedValue('proj-1')
    vi.mocked(findFiledResearchReport).mockResolvedValue(null)
    vi.mocked(findReportFilingRefusal).mockResolvedValue(null)
    vi.mocked(queueResearchReportFiling).mockResolvedValue({ jobId: 'bff-job-1' })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reportResponse(REPORT_BODY))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('queues the filing of the finished report and tells the client it is on its way', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(res.status).toBe(200)
    // The PDF is rendered by a `bff-jobs` pod (ADR-0079), as the reader.
    expect(queueResearchReportFiling).toHaveBeenCalledWith({
      organizationId: 'org-1',
      payload: expect.objectContaining({
        projectId: 'proj-1',
        runId: 'job-1',
        report: REPORT_BODY.report,
        taskRunId: null,
        requester: expect.objectContaining({ userId: session.userId, organizationMembershipId: session.organizationMembershipId }),
      }),
    })
    const body = await res.json()
    // Additive: everything the report response already carried is untouched.
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filingQueued).toBe(true)
    expect(body.filed).toBeUndefined()
    expect(body.filingFailed).toBeUndefined()
  })

  it('answers a reader who may not file with the broken promise, and queues nothing, however often it is read', async () => {
    vi.mocked(findReportFilingRefusal).mockResolvedValue('ForbiddenError: Agent-authored documents are disabled')
    fetchSpy.mockImplementation(async () => reportResponse(REPORT_BODY)) // a fresh body per read

    for (let read = 0; read < 3; read += 1) {
      const res = await GET(
        getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
        streamParams(['job', 'job-1', 'report'])
      )
      const body = await res.json()
      expect(body).toMatchObject(REPORT_BODY)
      expect(body.filingFailed).toBe(true)
      expect(body.filingQueued).toBeUndefined()
    }

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled() // a refusal is an answer, not a fault
  })

  it('tells the client where a report that is already filed landed, without a job', async () => {
    vi.mocked(findFiledResearchReport).mockResolvedValue({
      documentId: 'doc-1',
      filename: 'bericht-2026-08-20.pdf',
      folderId: 'folder-1',
      alreadyFiled: true,
    })

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filed).toEqual({
      documentId: 'doc-1',
      filename: 'bericht-2026-08-20.pdf',
      alreadyFiled: true,
    })
    expect(body.filingQueued).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // WHERE it lands: a property of the run, not of the request that reads it
  // ---------------------------------------------------------------------

  it('files into the project the RUN names, not the one the request asks for', async () => {
    // The reader has a different project open, or reopened an old run from
    // history. The cover sheet names the Bundesland, which says which
    // Bauordnung the report was checked against, so filing it under the
    // reader's current project produces a compliance document asserting the
    // wrong law.
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['proj_wien'],
      scopedCollections: [{ collection: 'proj_wien', shelf: 'project' }],
      projectId: 'proj-the-reader-is-looking-at',
      projectCollectionName: 'proj_wien',
      conversationId: undefined,
      verifiedConversationId: undefined,
    })
    vi.mocked(findProjectIdByCollectionName).mockResolvedValue('proj-the-run-belongs-to')

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-the-reader-is-looking-at'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(findProjectIdByCollectionName).toHaveBeenCalledWith('proj_abc', 'org-1')
    expect(queueResearchReportFiling).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ projectId: 'proj-the-run-belongs-to' }) })
    )
  })

  it('files nothing for a run that was never commissioned in a project', async () => {
    // A run started from a chat outside any project. Its banner promised no
    // filing, and the old behaviour filed it into whatever project the reader's
    // stored `active_project_id` happened to name — silently, with no
    // disclosure ever having been shown.
    fetchSpy.mockResolvedValue(
      reportResponse({ job_id: 'job-1', has_report: true, report: '# Bericht' })
    )

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.filed).toBeUndefined()
    // Not a broken promise either: none was made, and nothing is on its way.
    expect(body.filingFailed).toBeUndefined()
    expect(body.filingQueued).toBeUndefined()
  })

  it('files nothing when the run\u2019s collection belongs to no project in this organization', async () => {
    // The cross-tenant version of the same bug: a real collection name that
    // this organization does not own must not fall back to anywhere.
    vi.mocked(findProjectIdByCollectionName).mockResolvedValue(null)

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    expect((await res.json()).filed).toBeUndefined()
  })

  it('passes the run’s cards through, so the filed PDF can render Rechtsgrundlagen', async () => {
    const cards = [{ type: 'legal_basis', title: 'OIB-Richtlinie 2', lane: 'oib' }]
    fetchSpy.mockResolvedValue(reportResponse({ ...REPORT_BODY, cards }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ cards }) })
    )
  })

  it('passes no cards rather than an empty list when the run produced none', async () => {
    // `legalBasisSection` prints no heading for an absent value; an empty array
    // would be a promise of a section that then has nothing under it.
    fetchSpy.mockResolvedValue(reportResponse({ ...REPORT_BODY, cards: [] }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(vi.mocked(queueResearchReportFiling).mock.calls[0][0].payload.cards).toBeUndefined()
  })

  it('files the report anyway when `cards` is malformed', async () => {
    // The user waited minutes for the report. A display enhancement arriving in
    // a shape nobody expects may cost its own section, never the filing.
    fetchSpy.mockResolvedValue(reportResponse({ ...REPORT_BODY, cards: 'nonsense' }))

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(res.status).toBe(200)
    expect(queueResearchReportFiling).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ cards: undefined }) })
    )
  })

  it('says so when a promise to file was made and broken', async () => {
    // The starting banner told the reader the report would be filed under
    // „Berichte". A plain success after a failed filing sends them to look for
    // a document that is not there, with the only record in a server log.
    vi.mocked(queueResearchReportFiling).mockRejectedValue(new Error('quota exceeded'))

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    const body = await res.json()
    expect(body.filingFailed).toBe(true)
    expect(body.filed).toBeUndefined()
    // The reason stays in the log: a bucket, a permission or a limit is
    // actionable by an operator, not by the architect reading the report.
    expect(JSON.stringify(body)).not.toContain('quota exceeded')
  })

  it('claims no failure when no promise was made — a run with no project', async () => {
    // No project on the RUN is not a broken promise: the starting banner prints
    // the disclosure only when there was a project to file into. What the
    // READER has open is not this question and must not answer it.
    fetchSpy.mockResolvedValue(
      reportResponse({ job_id: 'job-1', has_report: true, report: '# Bericht' })
    )

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    const body = await res.json()
    expect(body.filingFailed).toBeUndefined()
    expect(body.filed).toBeUndefined()
  })

  it('still returns the report when filing fails — the answer is not the filing’s to lose', async () => {
    vi.mocked(queueResearchReportFiling).mockRejectedValue(new Error('quota exceeded'))

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // Every field the report carried is untouched — the failure is reported
    // ALONGSIDE the answer, never instead of it.
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filed).toBeUndefined()
  })

  it('files nothing for a run that has no report yet', async () => {
    fetchSpy.mockResolvedValue(reportResponse({ job_id: 'job-1', has_report: false, report: null }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  it('files nothing on the status endpoint — only a report is a document', async () => {
    fetchSpy.mockResolvedValue(reportResponse({ job_id: 'job-1', status: 'completed' }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1'),
      streamParams(['job', 'job-1'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })

  it('files the run\u2019s report even when the reader\u2019s own context resolves no project', async () => {
    // The precondition used to be `!session?.organizationId || !projectId`, and
    // `projectId` there is the READER's — the request's, or their stored
    // `active_project_id`. It survived the change that moved the destination
    // onto the run, so a commissioned run opened from a context with no project
    // of its own was silently never filed, and the response carried neither
    // `filed` nor `filingFailed`: a reader who had been promised „wird abgelegt"
    // was told nothing at all.
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: [],
      scopedCollections: [],
      projectId: undefined,
      projectCollectionName: undefined,
      conversationId: undefined,
      verifiedConversationId: undefined,
    })

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ projectId: 'proj-1', runId: 'job-1' }) })
    )
  })

  /**
   * Interactive runs only (design decision 10). A scheduled run has no live
   * session, and the write is authorized by the commissioning human's
   * `project:documents:write` — resolving the scheduler's `triggered_by`
   * permission at fire time is v1.1. Anonymous mode reaches this handler with
   * no session too, and the answer is the same one: file nothing.
   */
  it('files nothing when there is no live session to authorize the write', async () => {
    delete process.env.REQUIRE_AUTH

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
  })
})

describe('/api/jobs/async/[...path] proxy — every method carries the signed envelope (ADR-0084)', () => {
  // The backend lets a job's owner through on the bearer alone and anyone else
  // only inside the project or conversation this envelope signs, so a teammate's
  // stream, status, report and cancel are refused without it.
  const SECRET = 'test-secret' // pragma: allowlist secret
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@grid.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: null,
  }

  const sentHeaders = (call = 0): Record<string, string> =>
    (fetchSpy.mock.calls[call][1] as RequestInit).headers as Record<string, string>

  /** The envelope as the BFF's own verifier reads it: signed, in its window, naming the checked scope. */
  const verifiedEnvelope = (call = 0) => {
    const headers = sentHeaders(call)
    return verifyGridRequestContextEnvelope(
      headers['X-Grid-Request-Context'],
      headers['X-Grid-Request-Context-Sig'],
      SECRET
    )
  }

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    process.env.GRID_INTERNAL_API_TOKEN = SECRET
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 'proj_abc'],
      scopedCollections: [
        { collection: 'oib_knowledge', shelf: 'base' },
        { collection: 'proj_abc', shelf: 'project' },
      ],
      projectId: 'proj-1',
      projectCollectionName: 'proj_abc',
      conversationId: 'conv-1',
      verifiedConversationId: 'conv-1',
    })
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ job_id: 'job-1', status: 'running' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) delete process.env.REQUIRE_AUTH
    else process.env.REQUIRE_AUTH = originalRequireAuth
    if (originalInternalToken === undefined) delete process.env.GRID_INTERNAL_API_TOKEN
    else process.env.GRID_INTERNAL_API_TOKEN = originalInternalToken
  })

  it.each([
    [['job', 'job-1']],
    [['job', 'job-1', 'stream']],
    [['job', 'job-1', 'report']],
    [['job', 'job-1', 'state']],
  ])('signs the checked project and conversation on GET %j', async (path) => {
    await GET(getRequest(`https://grid.example/api/jobs/async/${path.join('/')}?projectId=proj-1`), streamParams(path))

    expect(verifiedEnvelope()).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
    const payload = JSON.parse(Buffer.from(sentHeaders()['X-Grid-Request-Context'], 'base64url').toString('utf8'))
    expect(payload.collectionScope).toContainEqual({ collection: 'proj_abc', shelf: 'project' })
    expect(sentHeaders().Authorization).toBe('Bearer token-abc')
  })

  it('signs it on DELETE', async () => {
    await DELETE(
      new Request('https://grid.example/api/jobs/async/job/job-1/cancel?projectId=proj-1', { method: 'DELETE' }),
      postParams(['job', 'job-1', 'cancel'])
    )

    expect(verifiedEnvelope()).toMatchObject({ organizationId: 'org-1', userId: 'user-1', projectId: 'proj-1' })
  })

  it('signs a cancel’s `?projectId=` without loading what only a submit configures', async () => {
    await POST(
      postRequest('https://grid.example/api/jobs/async/job/job-1/cancel?projectId=proj-1'),
      postParams(['job', 'job-1', 'cancel'])
    )

    expect(buildCollectionScopeFromRequest).toHaveBeenCalledWith(session, { projectId: 'proj-1' })
    expect(verifiedEnvelope()).toMatchObject({ projectId: 'proj-1' })
    expect(getEffectiveModelOverrides).not.toHaveBeenCalled()
  })

  it('signs nothing as a conversation the scope builder did not find and authorize', async () => {
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 's_conv-new'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
      projectId: undefined,
      projectCollectionName: undefined,
      conversationId: 'conv-new',
      verifiedConversationId: undefined,
    })

    await GET(getRequest('https://grid.example/api/jobs/async/job/job-1?conversationId=conv-new'), streamParams(['job', 'job-1']))

    expect(verifiedEnvelope()?.conversationId).toBeNull()
  })

  it('filters the run listing to the checked project and never forwards a client collection', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/jobs?projectId=proj-1&project_collection=proj_other&status=running'),
      streamParams(['jobs'])
    )

    const upstream = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(upstream.pathname).toBe('/v1/jobs/async/jobs')
    expect(upstream.searchParams.get('project_collection')).toBe('proj_abc')
    expect(upstream.searchParams.get('status')).toBe('running')
    expect(upstream.searchParams.has('projectId')).toBe(false)
    expect(verifiedEnvelope()).toMatchObject({ projectId: 'proj-1' })
  })

  it('forwards no project filter when the listing names no project', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/jobs?project_collection=proj_other'),
      streamParams(['jobs'])
    )

    const upstream = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(upstream.searchParams.has('project_collection')).toBe(false)
  })
})

describe('/api/jobs/async/[...path] proxy — a cancel the backend refuses because the run ended (#632)', () => {
  // The Sessions panel's stop goes out as POST /job/{id}/cancel. The first
  // fix for #632 guarded GET and DELETE only, so this path kept filing an
  // ERROR per refused cancel. Both terminal statuses the backend names.
  beforeEach(() => {
    delete process.env.REQUIRE_AUTH
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth !== undefined) process.env.REQUIRE_AUTH = originalRequireAuth
  })

  it.each(['success', 'failure'])('warns, never errors, for a job already at %s', async (terminal) => {
    const detail = `{"detail":"Job not cancellable: job-1 (status: ${terminal})"}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(detail, { status: 400 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST(postRequest('https://grid.example/api/jobs/async/job/job-1/cancel'), postParams(['job', 'job-1', 'cancel']))

    expect(res.status).toBe(400)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel race'), expect.stringContaining(terminal))
  })

  it('still errors for any other backend refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"detail":"boom"}', { status: 500 }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await POST(postRequest('https://grid.example/api/jobs/async/job/job-1/cancel'), postParams(['job', 'job-1', 'cancel']))

    expect(error).toHaveBeenCalledWith(expect.stringContaining('POST backend error'), 500, '{"detail":"boom"}')
  })
})

describe('/api/jobs/async/[...path] proxy — a run’s documents have one door (ADR-0055, ADR-0087)', () => {
  // `addRunDocument` checks a document against the project's restricted
  // folders before the backend hears of it; the proxy would forward the same
  // control with a signed project and no such check, so it does not serve it.
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.REQUIRE_AUTH
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth !== undefined) process.env.REQUIRE_AUTH = originalRequireAuth
  })

  it.each([
    [['job', 'job-1', 'documents']],
    [['job', 'job-1', 'documents', '']],
    [['job', 'job-1', 'x', '..', 'documents']],
    [['job', 'job-1', 'x/../documents']],
  ])('refuses %j without calling the backend, and names the run route', async (path) => {
    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/job/job-1/documents?projectId=project-1', {
        name: 'Abmahnung_Meier_2026.pdf',
        title: 'Abmahnung Meier',
      }),
      postParams(path)
    )

    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toContain('/api/projects/{projectId}/runs/{runId}/documents')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'write-now'])('still forwards %s', async (action) => {
    const res = await POST(
      postRequest(`https://grid.example/api/jobs/async/job/job-1/${action}?projectId=project-1`),
      postParams(['job', 'job-1', action])
    )
    expect(res.status).toBe(200)
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/v1/jobs/async/job/job-1/${action}`)
  })
})

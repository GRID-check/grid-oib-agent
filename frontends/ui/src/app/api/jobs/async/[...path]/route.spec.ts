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
  parseBodyContext: vi.fn(() => ({})),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi
    .fn()
    .mockResolvedValue({ headerValue: 'scope', scope: [], projectId: undefined }),
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
  fileResearchReport: vi.fn(),
}))

import { GET, POST } from './route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'
import { loadProjectBundesland } from '@/lib/project-profile/prompt-view'
import { fileResearchReport } from '@/lib/documents/research-report'

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

  const REPORT_BODY = { job_id: 'job-1', has_report: true, report: '# Bericht\n\nText.' }

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
    })
    vi.mocked(fileResearchReport).mockResolvedValue({
      documentId: 'doc-1',
      filename: 'bericht-2026-08-20.pdf',
      folderId: 'folder-1',
      alreadyFiled: false,
    })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reportResponse(REPORT_BODY))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('files the finished report and tells the client where it landed', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(res.status).toBe(200)
    expect(fileResearchReport).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', runId: 'job-1', report: REPORT_BODY.report })
    )
    const body = await res.json()
    // Additive: everything the report response already carried is untouched.
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filed).toEqual({
      documentId: 'doc-1',
      filename: 'bericht-2026-08-20.pdf',
      alreadyFiled: false,
    })
  })

  it('passes the run’s cards through, so the filed PDF can render Rechtsgrundlagen', async () => {
    const cards = [{ type: 'legal_basis', title: 'OIB-Richtlinie 2', lane: 'oib' }]
    fetchSpy.mockResolvedValue(reportResponse({ ...REPORT_BODY, cards }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(fileResearchReport).toHaveBeenCalledWith(expect.objectContaining({ cards }))
  })

  it('passes no cards rather than an empty list when the run produced none', async () => {
    // `legalBasisSection` prints no heading for an absent value; an empty array
    // would be a promise of a section that then has nothing under it.
    fetchSpy.mockResolvedValue(reportResponse({ ...REPORT_BODY, cards: [] }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(vi.mocked(fileResearchReport).mock.calls[0][0].cards).toBeUndefined()
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
    expect(fileResearchReport).toHaveBeenCalledWith(expect.objectContaining({ cards: undefined }))
  })

  it('says so when a promise to file was made and broken', async () => {
    // The starting banner told the reader the report would be filed under
    // „Berichte". A plain success after a failed filing sends them to look for
    // a document that is not there, with the only record in a server log.
    vi.mocked(fileResearchReport).mockRejectedValue(new Error('quota exceeded'))

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

  it('claims no failure when no promise was made — outside a project', async () => {
    // No project is not a broken promise; the starting banner prints the
    // disclosure only when there is a project to file into.
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: [],
      scopedCollections: [],
      projectId: undefined,
      projectCollectionName: undefined,
      conversationId: undefined,
    })

    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    const body = await res.json()
    expect(body.filingFailed).toBeUndefined()
    expect(body.filed).toBeUndefined()
    expect(body).toMatchObject(REPORT_BODY)
  })

  it('still returns the report when filing fails — the answer is not the filing’s to lose', async () => {
    vi.mocked(fileResearchReport).mockRejectedValue(new Error('quota exceeded'))

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

    expect(fileResearchReport).not.toHaveBeenCalled()
  })

  it('files nothing on the status endpoint — only a report is a document', async () => {
    fetchSpy.mockResolvedValue(reportResponse({ job_id: 'job-1', status: 'completed' }))

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1'),
      streamParams(['job', 'job-1'])
    )

    expect(fileResearchReport).not.toHaveBeenCalled()
  })

  it('files nothing without a project to file into', async () => {
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: [],
      scopedCollections: [],
      projectId: undefined,
      projectCollectionName: undefined,
      conversationId: undefined,
    })

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report'),
      streamParams(['job', 'job-1', 'report'])
    )

    expect(fileResearchReport).not.toHaveBeenCalled()
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

    expect(fileResearchReport).not.toHaveBeenCalled()
  })
})

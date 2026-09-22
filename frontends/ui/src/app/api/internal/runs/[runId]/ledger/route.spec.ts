/**
 * @vitest-environment node
 */
/**
 * The run-ledger route, driven through the TYPED CLIENT rather than through
 * hand-built `Request`s.
 *
 * That is ADR-0055's claim under test: the fold that flushes a ledger and this
 * spec are the same client of one HTTP API, so a renamed field or a moved path
 * fails here instead of at three in the morning in a worker's log. The
 * assertions that are not about the happy path are the ones that matter: the
 * door is shut without the service token, the op set is closed at two, the body
 * cannot name its own run, and a refusal arrives as a typed error rather than as
 * a `Response` each caller re-reads.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/runs/service', () => ({ applyRunLedgerOp: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { applyRunLedgerOp } from '@/lib/runs/service'
import { createRunLedgerClient, RunLedgerError } from '@/lib/runs/run-ledger-client'
import { emptyRunLedger } from '@/lib/runs/run-ledger'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const RUN = '6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31'
const T0 = new Date('2026-09-16T08:00:00.000Z')

const LEDGER = emptyRunLedger(RUN, T0)

/**
 * The routing table this suite stands in for Next.js with — written out,
 * because a spec that guessed which handler a path belongs to would pass while
 * the app mounted it somewhere else.
 */
const PATTERN = /^\/api\/internal\/runs\/([^/]+)\/ledger$/

function transport(headers: Record<string, string>) {
  return async (path: string, init?: RequestInit) => {
    const url = new URL(path, 'https://grid.test')
    const matched = PATTERN.exec(url.pathname)
    if (!matched) throw new Error(`no route for ${url.pathname}`)
    const request = new Request(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
    })
    return POST(request, { params: Promise.resolve({ runId: matched[1] }) })
  }
}

const client = createRunLedgerClient(transport({ 'x-grid-internal-token': SECRET }))
const anonymous = createRunLedgerClient(transport({}))

/** The raw call, for the shapes the typed client deliberately cannot express. */
function call(body: unknown, headers: Record<string, string> = { 'x-grid-internal-token': SECRET }) {
  return POST(
    new Request(`https://grid.test/api/internal/runs/${RUN}/ledger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ runId: RUN }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(applyRunLedgerOp).mockResolvedValue({ runId: RUN, ledger: LEDGER })
})

describe('POST /api/internal/runs/[runId]/ledger', () => {
  it('appends what the client sent, under the run id from the PATH', async () => {
    const step = {
      id: 'batch-1',
      phase: 'recherchieren' as const,
      intent: 'OIB-2 auf Fluchtwegbreiten prüfen',
      startedAt: T0.toISOString(),
      docs: [],
    }

    await expect(client.append(RUN, { steps: [step], status: 'laeuft' })).resolves.toEqual({
      runId: RUN,
      ledger: LEDGER,
    })
    expect(applyRunLedgerOp).toHaveBeenCalledWith(RUN, {
      op: 'append',
      steps: [step],
      status: 'laeuft',
    })
  })

  it('finishes with a result, and with an error', async () => {
    await client.finish(RUN, { result: { filedAt: T0.toISOString(), fileId: 'doc-1' } })
    expect(applyRunLedgerOp).toHaveBeenLastCalledWith(RUN, {
      op: 'finish',
      result: { filedAt: T0.toISOString(), fileId: 'doc-1' },
    })

    await client.finish(RUN, { error: { reason: 'Der Anbieter hat abgebrochen.' } })
    expect(applyRunLedgerOp).toHaveBeenLastCalledWith(RUN, {
      op: 'finish',
      error: { reason: 'Der Anbieter hat abgebrochen.' },
    })
  })

  it('sends nothing it was not given', async () => {
    await client.append(RUN, {})
    expect(applyRunLedgerOp).toHaveBeenCalledWith(RUN, { op: 'append' })
  })

  it('refuses a request without the service token, before the service is reached', async () => {
    await expect(anonymous.append(RUN, {})).rejects.toBeInstanceOf(RunLedgerError)
    expect(applyRunLedgerOp).not.toHaveBeenCalled()
  })

  it('closes the op set at two', async () => {
    const response = await call({ op: 'cancel' })
    expect(response.status).toBe(400)
    expect(applyRunLedgerOp).not.toHaveBeenCalled()
  })

  it('refuses a body that names its own run', async () => {
    // The run id is the route's only identity. A body that could name a second
    // one would be a body that could write into another tenant's thread — so the
    // request schema is `.strict()` and this is a 400, not a silent drop.
    const response = await call({ op: 'append', runId: 'some-other-run' })
    expect(response.status).toBe(400)
    expect(applyRunLedgerOp).not.toHaveBeenCalled()
  })

  it('refuses a step that names a tool', async () => {
    const response = await call({
      op: 'append',
      steps: [
        {
          id: 'batch-1',
          phase: 'recherchieren',
          intent: 'OIB-2 prüfen',
          startedAt: T0.toISOString(),
          docs: [],
          tool: 'search_norms',
        },
      ],
    })
    expect(response.status).toBe(400)
  })

  it('hands a refusal to the caller as a typed error it can act on', async () => {
    vi.mocked(applyRunLedgerOp).mockRejectedValue(new NotFoundError('Unknown run'))

    // A flush must never fail a run, and a caller can only decide that if the
    // refusal is legible: status and code, not a Response to re-read.
    await expect(client.append(RUN, {})).rejects.toMatchObject({
      name: 'RunLedgerError',
      status: 404,
      code: 'NOT_FOUND',
    })
  })
})

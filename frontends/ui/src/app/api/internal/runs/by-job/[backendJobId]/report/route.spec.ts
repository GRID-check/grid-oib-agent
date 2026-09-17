/**
 * @vitest-environment node
 */
/**
 * The run-report route: the door a finished run's answer comes through.
 *
 * Three things are worth a test here and the happy path is only one of them.
 * The door is shut without the service token. The job id comes from the PATH,
 * so a body cannot name a second run and write into another thread. And a run
 * with no message answers 404 — which is not a failure but the signal the worker
 * reads as „write the turn the old way", and the only thing keeping a
 * pre-ADR-0062 run's report in front of its reader.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/runs/service', () => ({ writeRunReport: vi.fn() }))

import { NotFoundError } from '@/lib/api/errors'
import { writeRunReport } from '@/lib/runs/service'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const JOB = 'job-9'
const RUN = '6f1a0f7e-2b1f-4a4e-9a4e-2f0f1a6d9c31'
const TARGET = { runId: RUN, conversationId: 's_conv_1', messageId: 'msg-1' }

function call(body: unknown, headers: Record<string, string> = { 'x-grid-internal-token': SECRET }) {
  return POST(
    new Request(`https://grid.test/api/internal/runs/by-job/${JOB}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ backendJobId: JOB }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(writeRunReport).mockResolvedValue(TARGET)
})

describe('POST /api/internal/runs/by-job/[backendJobId]/report', () => {
  it('writes the report into the run named by the PATH', async () => {
    const response = await call({
      content: 'Der Bericht',
      metadata: { sources: [{ title: 'OIB-2' }] },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject(TARGET)
    expect(writeRunReport).toHaveBeenCalledWith(JOB, {
      content: 'Der Bericht',
      metadata: { sources: [{ title: 'OIB-2' }] },
    })
  })

  it('takes a report with no metadata — a notice has none', async () => {
    await call({ content: 'Dieser Job hat kein Ergebnis geliefert.' })
    expect(writeRunReport).toHaveBeenCalledWith(JOB, {
      content: 'Dieser Job hat kein Ergebnis geliefert.',
    })
  })

  it('answers 404 for a run with no message, and writes nothing', async () => {
    vi.mocked(writeRunReport).mockRejectedValue(new NotFoundError('no message'))
    const response = await call({ content: 'x' })
    expect(response.status).toBe(404)
  })

  it('is shut without the service token', async () => {
    const response = await call({ content: 'x' }, {})
    expect(response.status).toBe(403)
    expect(writeRunReport).not.toHaveBeenCalled()
  })

  it('refuses a body that is not a report', async () => {
    const response = await call({ report: 'wrong field' })
    expect(response.status).toBe(400)
    expect(writeRunReport).not.toHaveBeenCalled()
  })
})

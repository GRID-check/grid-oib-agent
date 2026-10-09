/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import {
  LangfuseError,
  createConversationTraceEraser,
  createTraceClient,
  deleteTracesBefore,
  eraseSessionTraces,
  readLangfuseConfig,
  readTraceRetentionDays,
} from './langfuse-traces.js'

const ENV = {
  LANGFUSE_HOST: 'http://langfuse-web:3000/',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-1',
  LANGFUSE_SECRET_KEY: 'sk-lf-2', // pragma: allowlist secret
}

const reply = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

/** The traces a listing returns for one session: `spans` observations over `traces` traces. */
const observationsOf = (sessionId, traces, from = 0) =>
  Array.from({ length: traces }, (_, i) => ({ traceId: `t${from + i}`, sessionId }))

/**
 * A Langfuse that serves `pages` of observations in order (each with a cursor
 * but the last) and accepts deletes. Records every call.
 */
function fakeLangfuse(pages, { deleteAnswer = reply(200, { message: 'ok' }) } = {}) {
  const lists = []
  const deletes = []
  const fetchImpl = vi.fn(async (url, init) => {
    const u = new URL(url)
    if (init.method === 'DELETE') {
      deletes.push({ path: u.pathname, body: JSON.parse(init.body), headers: init.headers })
      return deleteAnswer
    }
    lists.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers })
    const index = lists.length - 1
    const meta = index < pages.length - 1 ? { cursor: `cursor-${index + 1}` } : {}
    return reply(200, { data: pages[index] ?? [], meta })
  })
  return { fetchImpl, lists, deletes }
}

const clientFor = (fetchImpl) => createTraceClient(readLangfuseConfig(ENV).config, fetchImpl)

describe('readLangfuseConfig', () => {
  it('needs all three settings and never falls back to a host', () => {
    expect(readLangfuseConfig({}).config).toBeNull()
    expect(readLangfuseConfig({}).missing).toEqual(['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'])
    expect(readLangfuseConfig({ ...ENV, LANGFUSE_HOST: '  ' }).missing).toEqual(['LANGFUSE_HOST'])
    expect(readLangfuseConfig({ ...ENV, LANGFUSE_SECRET_KEY: '' }).missing).toEqual(['LANGFUSE_SECRET_KEY'])
    expect(readLangfuseConfig({ ...ENV, LANGFUSE_HOST: 'langfuse-web:3000' }).config).toBeNull()
  })

  it('builds Basic auth from the key pair and strips the trailing slash', () => {
    const { config } = readLangfuseConfig(ENV)
    expect(config.host).toBe('http://langfuse-web:3000')
    expect(config.authorization).toBe(`Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`)
  })
})

describe('readTraceRetentionDays', () => {
  it('defaults to 30 days', () => {
    expect(readTraceRetentionDays({})).toEqual({ days: 30, clamped: false })
  })

  it('never goes below Langfuse’s own minimum of 3 days', () => {
    expect(readTraceRetentionDays({ GRID_LANGFUSE_TRACE_RETENTION_DAYS: '1' })).toEqual({ days: 3, clamped: true })
    expect(readTraceRetentionDays({ GRID_LANGFUSE_TRACE_RETENTION_DAYS: '3' })).toEqual({ days: 3, clamped: false })
    expect(readTraceRetentionDays({ GRID_LANGFUSE_TRACE_RETENTION_DAYS: '90' })).toEqual({ days: 90, clamped: false })
  })

  it('reads a value that is not a positive integer as the default, and says it corrected it', () => {
    for (const bad of ['abc', '0', '-5', '2.5']) {
      expect(readTraceRetentionDays({ GRID_LANGFUSE_TRACE_RETENTION_DAYS: bad })).toEqual({ days: 30, clamped: true })
    }
  })
})

describe('eraseSessionTraces', () => {
  it('lists the session’s observations across pages and deletes each trace once', async () => {
    const { fetchImpl, lists, deletes } = fakeLangfuse([
      [...observationsOf('s_1', 2), { traceId: 't0', sessionId: 's_1' }],
      [{ traceId: 't1', sessionId: 's_1' }, ...observationsOf('s_1', 1, 2)],
    ])

    const result = await eraseSessionTraces(clientFor(fetchImpl), 's_1')

    expect(result).toEqual({ traces: 3, batches: 1 })
    expect(lists).toHaveLength(2)
    expect(lists[0].path).toBe('/api/public/v2/observations')
    expect(lists[0].query).toEqual({ sessionId: 's_1', fields: 'core,basic', limit: '1000' })
    expect(lists[1].query.cursor).toBe('cursor-1')
    expect(lists[0].headers.authorization).toMatch(/^Basic /)
    expect(deletes).toHaveLength(1)
    expect(deletes[0].path).toBe('/api/public/traces')
    expect(deletes[0].body).toEqual({ traceIds: ['t0', 't1', 't2'] })
  })

  it('deletes in batches of at most 1000 ids', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([
      observationsOf('s_1', 1000),
      observationsOf('s_1', 1000, 1000),
      observationsOf('s_1', 500, 2000),
    ])

    const result = await eraseSessionTraces(clientFor(fetchImpl), 's_1')

    expect(result).toEqual({ traces: 2500, batches: 3 })
    expect(deletes.map((d) => d.body.traceIds.length)).toEqual([1000, 1000, 500])
    expect(new Set(deletes.flatMap((d) => d.body.traceIds)).size).toBe(2500)
  })

  it('never sends more than 1000 ids when pages of other sizes pile up in between', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([
      observationsOf('s_1', 600),
      observationsOf('s_1', 600, 600),
      observationsOf('s_1', 600, 1200),
    ])

    const result = await eraseSessionTraces(clientFor(fetchImpl), 's_1')

    expect(result).toEqual({ traces: 1800, batches: 2 })
    expect(deletes.map((d) => d.body.traceIds.length)).toEqual([1000, 800])
  })

  it('refuses a delete of more than 1000 ids at the client, whatever calls it', async () => {
    const { fetchImpl } = fakeLangfuse([[]])
    const ids = Array.from({ length: 1001 }, (_, i) => `t${i}`)
    await expect(clientFor(fetchImpl).deleteTraces(ids)).rejects.toThrow(RangeError)
    await expect(clientFor(fetchImpl).deleteTraces([])).rejects.toThrow(RangeError)
  })

  it('makes no delete call for a conversation with no traces', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([[]])
    expect(await eraseSessionTraces(clientFor(fetchImpl), 's_1')).toEqual({ traces: 0, batches: 0 })
    expect(deletes).toHaveLength(0)
  })

  it('refuses an empty session id before any request: that filter would list every trace', async () => {
    const fetchImpl = vi.fn()
    for (const bad of ['', '   ', undefined]) {
      await expect(eraseSessionTraces(clientFor(fetchImpl), bad)).rejects.toThrow(TypeError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('aborts, deleting nothing, when Langfuse hands back another session’s observation', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([[{ traceId: 't0', sessionId: 's_1' }, { traceId: 't9', sessionId: 's_other' }]])

    const error = await eraseSessionTraces(clientFor(fetchImpl), 's_1').catch((e) => e)

    expect(error).toBeInstanceOf(LangfuseError)
    expect(error.transient).toBe(false)
    expect(deletes).toHaveLength(0)
  })

  it.each([500, 502, 503, 429])('throws a transient error on a %i from the listing, so the purge retries', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(status))
    const error = await eraseSessionTraces(clientFor(fetchImpl), 's_1').catch((e) => e)
    expect(error).toBeInstanceOf(LangfuseError)
    expect(error.transient).toBe(true)
    expect(error.status).toBe(status)
    // The message names the path and status, never the conversation id.
    expect(error.message).toBe(`Langfuse GET /api/public/v2/observations answered ${status}`)
  })

  it('throws on a 5xx from the delete', async () => {
    const { fetchImpl } = fakeLangfuse([observationsOf('s_1', 1)], { deleteAnswer: reply(503) })
    const error = await eraseSessionTraces(clientFor(fetchImpl), 's_1').catch((e) => e)
    expect(error).toMatchObject({ name: 'LangfuseError', status: 503, transient: true })
  })

  it('throws a transient error on a timeout or a refused connection', async () => {
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    for (const failure of [timeout, refused]) {
      const error = await eraseSessionTraces(clientFor(vi.fn().mockRejectedValue(failure)), 's_1').catch((e) => e)
      expect(error).toBeInstanceOf(LangfuseError)
      expect(error.transient).toBe(true)
    }
  })

  it('treats a 404 from the listing as a fault, not a transient failure (a Langfuse outside a v4 write mode)', async () => {
    const error = await eraseSessionTraces(clientFor(vi.fn().mockResolvedValue(reply(404))), 's_1').catch((e) => e)
    expect(error).toMatchObject({ status: 404, transient: false })
  })

  it('bounds every request with a timeout', async () => {
    const { fetchImpl } = fakeLangfuse([[]])
    await eraseSessionTraces(clientFor(fetchImpl), 's_1')
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})

describe('createConversationTraceEraser', () => {
  it('is a logged no-op without configuration: no request, no throw, one warning', async () => {
    const fetchImpl = vi.fn()
    const log = { log: vi.fn(), warn: vi.fn() }
    const erase = createConversationTraceEraser({ env: { LANGFUSE_HOST: 'http://x' }, fetchImpl, log })

    expect(await erase('s_1')).toEqual({ configured: false, traces: 0, batches: 0 })
    expect(await erase('s_2')).toEqual({ configured: false, traces: 0, batches: 0 })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toContain('LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY')
  })

  it('erases the conversation’s traces when configured, and does not log the keys', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([observationsOf('s_1', 2)])
    const log = { log: vi.fn(), warn: vi.fn() }

    const result = await createConversationTraceEraser({ env: ENV, fetchImpl, log })('s_1')

    expect(result).toEqual({ configured: true, traces: 2, batches: 1 })
    expect(deletes[0].body.traceIds).toEqual(['t0', 't1'])
    expect(JSON.stringify(log.log.mock.calls)).not.toContain('sk-lf')
  })
})

describe('deleteTracesBefore (the retention sweep)', () => {
  const cutoff = new Date('2026-09-06T00:00:00.000Z')
  const old = (n, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ traceId: `t${from + i}`, startTime: '2026-08-01T10:00:00.000Z' }))

  it('lists root observations before the cutoff and deletes their traces', async () => {
    const { fetchImpl, lists, deletes } = fakeLangfuse([old(3)])

    const result = await deleteTracesBefore(clientFor(fetchImpl), cutoff)

    expect(result).toEqual({ traces: 3, batches: 1, capped: false })
    expect(lists[0].query).toEqual({
      toStartTime: '2026-09-06T00:00:00.000Z',
      isRootObservation: 'true',
      fields: 'core',
      limit: '1000',
    })
    expect(deletes[0].body.traceIds).toEqual(['t0', 't1', 't2'])
  })

  it('caps the delete requests per run and says the backlog is not drained', async () => {
    const { fetchImpl, deletes, lists } = fakeLangfuse(Array.from({ length: 10 }, (_, i) => old(1000, i * 1000)))

    const result = await deleteTracesBefore(clientFor(fetchImpl), cutoff, { maxBatches: 3 })

    expect(result).toEqual({ traces: 3000, batches: 3, capped: true })
    expect(deletes).toHaveLength(3)
    expect(deletes.every((d) => d.body.traceIds.length === 1000)).toBe(true)
    // It stopped listing too: no page was read for the batches it may not send.
    expect(lists).toHaveLength(3)
  })

  it('caps the list requests per run', async () => {
    const { fetchImpl, lists } = fakeLangfuse(Array.from({ length: 10 }, (_, i) => old(10, i * 10)))
    const result = await deleteTracesBefore(clientFor(fetchImpl), cutoff, { maxPages: 2 })
    expect(lists).toHaveLength(2)
    expect(result.capped).toBe(true)
  })

  it('stops at the wall-clock budget', async () => {
    const { fetchImpl, lists } = fakeLangfuse(Array.from({ length: 10 }, (_, i) => old(10, i * 10)))
    let t = 0
    const now = () => (t += 60_000)
    const result = await deleteTracesBefore(clientFor(fetchImpl), cutoff, { maxDurationMs: 100_000, now })
    expect(lists.length).toBeLessThan(10)
    expect(result.capped).toBe(true)
  })

  it('sends the short last batch when the listing ends inside the caps', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([old(1000), old(250, 1000)])
    const result = await deleteTracesBefore(clientFor(fetchImpl), cutoff, { maxBatches: 2 })
    expect(result).toEqual({ traces: 1250, batches: 2, capped: false })
    expect(deletes.map((d) => d.body.traceIds.length)).toEqual([1000, 250])
  })

  it('does nothing when nothing is old enough', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([[]])
    expect(await deleteTracesBefore(clientFor(fetchImpl), cutoff)).toEqual({ traces: 0, batches: 0, capped: false })
    expect(deletes).toHaveLength(0)
  })

  it('aborts, deleting nothing from the page, when Langfuse returns a trace newer than the cutoff', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([[...old(2), { traceId: 'fresh', startTime: '2026-10-05T10:00:00.000Z' }]])
    const error = await deleteTracesBefore(clientFor(fetchImpl), cutoff).catch((e) => e)
    expect(error).toBeInstanceOf(LangfuseError)
    expect(error.kind).toBe('time filter ignored')
    expect(deletes).toHaveLength(0)
  })

  it('aborts on an observation with no readable start time', async () => {
    const { fetchImpl, deletes } = fakeLangfuse([[{ traceId: 't0' }]])
    await expect(deleteTracesBefore(clientFor(fetchImpl), cutoff)).rejects.toBeInstanceOf(LangfuseError)
    expect(deletes).toHaveLength(0)
  })
})

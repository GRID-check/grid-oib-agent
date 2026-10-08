/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { LEGAL_HOLD_CODE } from './purge-project.js'
import { PERMANENT_FAILURE_CODE, purgeConversation } from './purge-conversation.js'

const entry = {
  id: 'q-1',
  organization_id: 'org_1',
  entity_type: 'conversation',
  entity_id: 's_conv/1',
  status: 'purging',
  attempts: 1,
}

/** A transaction whose only statement is the hold re-check. */
function makeTx(held = false) {
  const executed = []
  const tx = (strings, ...values) => {
    executed.push({ text: strings.join('$').replace(/\s+/g, ' ').trim(), values })
    return Promise.resolve([{ held }])
  }
  return { tx, executed }
}

function makeDeps(response) {
  const fetchImpl = vi.fn().mockResolvedValue(response)
  return {
    deps: {
      backendUrl: 'http://aiq-agent:8000',
      frontendUrl: 'http://frontend:3000',
      internalToken: 'tok',
      bucket: 'grid-documents',
      workos: { authorization: { deleteResourceByExternalId: vi.fn() } },
      deleteStoragePrefix: vi.fn(),
      eraseConversationTraces: vi.fn().mockResolvedValue({ configured: true, traces: 0, batches: 0 }),
      fetchImpl,
    },
    fetchImpl,
  }
}

const answer = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

describe('purgeConversation (the retry of a chat erasure)', () => {
  it('asks the BFF to run its erasure, in the queue row’s organization, with the service token', async () => {
    const { tx } = makeTx()
    const { deps, fetchImpl } = makeDeps(answer(200, { outcome: 'erased' }))

    await purgeConversation(tx, entry, deps)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://frontend:3000/api/internal/conversations/s_conv%2F1/erase')
    expect(init.method).toBe('POST')
    expect(init.headers['x-grid-internal-token']).toBe('tok')
    expect(JSON.parse(init.body)).toEqual({ organizationId: 'org_1' })
    // Bounded, so a hung BFF is recorded as a failed attempt rather than
    // outliving the stale-claim window.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('deletes the chat’s Langfuse traces by conversation id once the BFF has erased it', async () => {
    const { tx } = makeTx()
    const { deps, fetchImpl } = makeDeps(answer(200, { outcome: 'erased' }))
    const order = []
    fetchImpl.mockImplementation(async () => {
      order.push('bff')
      return answer(200, { outcome: 'erased' })
    })
    deps.eraseConversationTraces.mockImplementation(async () => {
      order.push('traces')
    })

    await purgeConversation(tx, entry, deps)

    expect(deps.eraseConversationTraces).toHaveBeenCalledExactlyOnceWith('s_conv/1')
    expect(order).toEqual(['bff', 'traces'])
  })

  it('lets a Langfuse failure fail the attempt, so the queue row retries', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(200, { outcome: 'erased' }))
    deps.eraseConversationTraces.mockRejectedValue(new Error('Langfuse DELETE /api/public/traces answered 503'))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBeUndefined()
    expect(error.message).toMatch(/503/)
  })

  it.each([
    ['a legal hold', answer(409, { details: { reason: 'legal_hold' } })],
    ['a live chat', answer(409, { details: { reason: 'not_deleting' } })],
    ['a failed erase', answer(502, { error: 'down' })],
  ])('leaves the traces alone when the BFF refuses (%s)', async (_label, response) => {
    const { tx } = makeTx()
    const { deps } = makeDeps(response)

    await purgeConversation(tx, entry, deps).catch(() => undefined)

    expect(deps.eraseConversationTraces).not.toHaveBeenCalled()
  })

  it('re-checks the hold before the call and makes no call when one now applies', async () => {
    const { tx, executed } = makeTx(true)
    const { deps, fetchImpl } = makeDeps(answer(200))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    expect(error.code).toBe(LEGAL_HOLD_CODE)
    expect(executed[0].text).toContain('grid_legal_hold_blocks')
    expect(executed[0].values).toEqual(['conversation', 's_conv/1', 'org_1'])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(deps.eraseConversationTraces).not.toHaveBeenCalled()
  })

  it('turns the BFF’s legal-hold 409 into the hold signal, so the row is deferred, not failed', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(409, { code: 'CONFLICT', details: { reason: 'legal_hold' } }))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    expect(error.code).toBe(LEGAL_HOLD_CODE)
  })

  it('throws on any other refusal, so the attempt is recorded and retried with backoff', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(502, { error: 'Deleting the chat’s attachments failed' }))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBeUndefined()
    expect(error.message).toMatch(/502.*attachments failed/)
  })

  it('fails a queue row that names a live chat for good, instead of retrying it', async () => {
    const { tx } = makeTx()
    const { deps, fetchImpl } = makeDeps(answer(409, { details: { reason: 'not_deleting' } }))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    // The BFF gives the same answer on every attempt, so the caller marks the
    // row failed at once (markFailedPermanent), with a reason an admin can read.
    expect(error.code).toBe(PERMANENT_FAILURE_CODE)
    expect(error.message).toMatch(/not marked deleting.*nothing was erased/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps any other 409 retryable', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(409, { error: 'conflict' }))

    const error = await purgeConversation(tx, entry, deps).catch((e) => e)

    expect(error.code).toBeUndefined()
    expect(error.message).toMatch(/409/)
  })
})

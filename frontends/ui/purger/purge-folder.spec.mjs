/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { LEGAL_HOLD_CODE } from './purge-project.js'
import { PERMANENT_FAILURE_CODE } from './purge-conversation.js'
import { purgeFolder } from './purge-folder.js'

const entry = {
  id: 'q-folder',
  organization_id: 'org_1',
  entity_type: 'folder',
  entity_id: '11111111-aaaa-4bbb-8ccc-000000000001',
  status: 'purging',
  attempts: 1,
}

/** A transaction that answers the hold re-check and records every statement. */
function makeTx(held = false) {
  const executed = []
  const tx = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    return Promise.resolve(text.includes('grid_legal_hold_blocks') ? [{ held }] : [])
  }
  return { tx, executed }
}

function makeDeps(response, traces = { configured: true, traces: 2, batches: 1 }) {
  const fetchImpl = vi.fn().mockResolvedValue(response)
  const eraseConversationTraces = vi.fn().mockResolvedValue(traces)
  return {
    deps: {
      backendUrl: 'http://aiq-agent:8000',
      frontendUrl: 'http://frontend:3000',
      internalToken: 'tok',
      bucket: 'grid-documents',
      workos: { authorization: { deleteResourceByExternalId: vi.fn() } },
      deleteStoragePrefix: vi.fn(),
      eraseConversationTraces,
      fetchImpl,
    },
    fetchImpl,
    eraseConversationTraces,
  }
}

const answer = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

describe('purgeFolder (a folder from the Papierkorb)', () => {
  it('asks the BFF to purge it, in the queue row’s organization, with the service token', async () => {
    const { tx } = makeTx()
    const { deps, fetchImpl } = makeDeps(answer(200, { status: 'purged', counts: { documents: 3 }, traceConversationIds: [] }))

    await purgeFolder(tx, entry, deps)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`http://frontend:3000/api/internal/folders/${entry.entity_id}/purge`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-grid-internal-token']).toBe('tok')
    expect(JSON.parse(init.body)).toEqual({ organizationId: 'org_1' })
  })

  it('re-checks the legal hold before anything, and calls nothing when one appeared', async () => {
    const { tx } = makeTx(true)
    const { deps, fetchImpl } = makeDeps(answer(200, {}))
    await expect(purgeFolder(tx, entry, deps)).rejects.toMatchObject({ code: LEGAL_HOLD_CODE })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('erases the traces the BFF names after its purge, and records the counts on the row', async () => {
    const { tx, executed } = makeTx()
    const { deps, eraseConversationTraces } = makeDeps(
      answer(200, { status: 'purged', counts: { documents: 3, answers: 2 }, traceConversationIds: ['s_a', 's_b', 7] })
    )

    await purgeFolder(tx, entry, deps)

    expect(eraseConversationTraces.mock.calls.map(([id]) => id)).toEqual(['s_a', 's_b'])
    const update = executed.find((statement) => statement.text.startsWith('UPDATE deletion_queue'))
    expect(JSON.parse(update.values[0])).toEqual({ purged: { documents: 3, answers: 2, tracesErased: 4 } })
    expect(update.values[1]).toBe('q-folder')
  })

  it('erases no traces when nothing derived was removed', async () => {
    const { tx } = makeTx()
    const { deps, eraseConversationTraces } = makeDeps(answer(200, { status: 'purged', counts: {}, traceConversationIds: [] }))
    await purgeFolder(tx, entry, deps)
    expect(eraseConversationTraces).not.toHaveBeenCalled()
  })

  it('throws when Langfuse fails, so the row retries, without recording the purge', async () => {
    const { tx, executed } = makeTx()
    const { deps, eraseConversationTraces } = makeDeps(answer(200, { traceConversationIds: ['s_a'] }))
    eraseConversationTraces.mockRejectedValue(new Error('Langfuse DELETE /api/public/traces answered 503'))
    await expect(purgeFolder(tx, entry, deps)).rejects.toThrow(/503/)
    expect(executed.some((statement) => statement.text.startsWith('UPDATE deletion_queue'))).toBe(false)
  })

  it('defers on the BFF’s legal-hold refusal', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(409, { details: { reason: 'legal_hold' } }))
    await expect(purgeFolder(tx, entry, deps)).rejects.toMatchObject({ code: LEGAL_HOLD_CODE })
  })

  it('fails for good a row that names a folder not in the bin', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(409, { details: { reason: 'not_in_bin' } }))
    await expect(purgeFolder(tx, entry, deps)).rejects.toMatchObject({ code: PERMANENT_FAILURE_CODE })
  })

  it('records any other answer as a failed attempt', async () => {
    const { tx } = makeTx()
    const { deps } = makeDeps(answer(502, { error: 'backend down' }))
    await expect(purgeFolder(tx, entry, deps)).rejects.toThrow('folder purge answered 502: backend down')
  })
})

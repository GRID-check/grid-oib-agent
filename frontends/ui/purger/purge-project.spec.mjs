import { describe, expect, it, vi } from 'vitest'
import { LEGAL_HOLD_CODE, purgeProject } from './purge-project.js'

function makeTx({ projectRow, conversationRows, holdRows = [] }) {
  const executed = []
  const tx = (strings, ...values) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    if (text.startsWith('SELECT') && text.includes('FROM legal_holds')) {
      return Promise.resolve(holdRows)
    }
    if (text.startsWith('SELECT') && text.includes('FROM projects')) {
      return Promise.resolve(projectRow ? [projectRow] : [])
    }
    if (text.startsWith('SELECT') && text.includes('FROM conversations')) {
      return Promise.resolve(conversationRows)
    }
    return Promise.resolve([])
  }
  return { tx, executed }
}

function makeDeps(overrides = {}) {
  return {
    backendUrl: 'http://backend:8000',
    internalToken: 'tok',
    bucket: 'grid-documents',
    fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    deleteStoragePrefix: vi.fn().mockResolvedValue(3),
    workos: {
      authorization: {
        deleteResourceByExternalId: vi.fn().mockResolvedValue(undefined),
      },
    },
    ...overrides,
  }
}

const entry = {
  id: 'q1',
  entity_id: 'p1',
  organization_id: 'org1',
  payload: { collectionName: 'proj_fallback' },
}

describe('purgeProject', () => {
  it('runs steps in order: backend, storage, workos, rows — project row last', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc', name: 'Alpha' },
      conversationRows: [{ id: 'c1' }, { id: 'c2' }],
    })
    const deps = makeDeps()

    await purgeProject(tx, entry, deps)

    const backendCall = deps.fetchImpl.mock.calls[0]
    expect(backendCall[0]).toBe('http://backend:8000/v1/maintenance/purge-project-resources')
    expect(JSON.parse(backendCall[1].body)).toEqual({
      collection_name: 'proj_abc',
      conversation_ids: ['c1', 'c2'],
    })
    expect(deps.deleteStoragePrefix).toHaveBeenCalledWith(
      'grid-documents',
      'org/org1/project/p1/',
    )
    expect(deps.workos.authorization.deleteResourceByExternalId).toHaveBeenCalledWith({
      organizationId: 'org1',
      resourceTypeSlug: 'project',
      externalId: 'p1',
      cascadeDelete: true,
    })
    const deletes = executed.filter((q) => q.text.startsWith('DELETE'))
    expect(deletes.at(-1).text).toContain('FROM projects')
  })

  it('falls back to payload pointers when the project row is already gone', async () => {
    const { tx } = makeTx({ projectRow: null, conversationRows: [] })
    const deps = makeDeps()

    await purgeProject(tx, entry, deps)

    const body = JSON.parse(deps.fetchImpl.mock.calls[0][1].body)
    expect(body.collection_name).toBe('proj_fallback')
  })

  it('propagates backend failure without touching grid_app rows', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
    })
    const deps = makeDeps({
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 502 }),
    })

    await expect(purgeProject(tx, entry, deps)).rejects.toThrow(/backend purge failed/)
    expect(executed.some((q) => q.text.startsWith('DELETE'))).toBe(false)
  })

  it('aborts before any destruction when a legal hold appears after claim (TOCTOU)', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 'c1' }],
      holdRows: [{ '?column?': 1 }],
    })
    const deps = makeDeps()

    await expect(purgeProject(tx, entry, deps)).rejects.toMatchObject({
      code: LEGAL_HOLD_CODE,
    })

    // No destructive step ran: no backend call, no SeaweedFS delete, no WorkOS
    // delete, no grid_app row deletes.
    expect(deps.fetchImpl).not.toHaveBeenCalled()
    expect(deps.deleteStoragePrefix).not.toHaveBeenCalled()
    expect(deps.workos.authorization.deleteResourceByExternalId).not.toHaveBeenCalled()
    expect(executed.some((q) => q.text.startsWith('DELETE'))).toBe(false)
  })

  it('treats an already-deleted WorkOS resource as success (idempotency)', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
    })
    const notFound = Object.assign(new Error('Resource not found'), { status: 404 })
    const deps = makeDeps({
      workos: {
        authorization: {
          deleteResourceByExternalId: vi.fn().mockRejectedValue(notFound),
        },
      },
    })

    await expect(purgeProject(tx, entry, deps)).resolves.toBeUndefined()
  })
})

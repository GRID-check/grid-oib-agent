/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { LEGAL_HOLD_CODE, purgeProject } from './purge-project.js'

/**
 * A tagged-template stand-in for a postgres.js transaction.
 *
 * What it models: the SEQUENCE of statements, their text, and the values bound
 * to each one. What it deliberately does NOT model: parameter expansion. Real
 * postgres.js turns `sql(array)` into one placeholder per element and the server
 * refuses past 65535 of them; here every call resolves to `[]` regardless. So a
 * test written on this mock can prove that a statement binds one value rather
 * than N, and cannot prove what the server would do with either — see the
 * comment on the subquery test below.
 *
 * `expansions` records calls made as a FUNCTION rather than as a template tag
 * (`tx(ids)`), which is how the parameter blow-up was expressed. A real template
 * strings array carries `.raw`; a plain array of ids does not.
 */
function makeTx({ projectRow, conversationRows, holdRows = [] }) {
  const executed = []
  const expansions = []
  const tx = (strings, ...values) => {
    if (!Array.isArray(strings) || !('raw' in strings)) {
      expansions.push(strings)
      return Promise.resolve([])
    }
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
  return { tx, executed, expansions }
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

describe('collaboration rows', () => {
  it('purges grants, mention requests and inbox items BEFORE the conversations they point at', async () => {
    // Those three tables address their target as a polymorphic
    // (resource_type, resource_id) pair with no foreign key, so nothing about
    // them cascades. Deleting the conversations first orphaned every one of
    // them permanently — leaving redacted rows in people's inboxes for a
    // project that no longer exists.
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_p1' },
      conversationRows: [{ id: 'c1' }, { id: 'c2' }],
    })

    await purgeProject(tx, entry, makeDeps())

    const deletes = executed.filter((call) => call.text.startsWith('DELETE'))
    const table = (name) => deletes.findIndex((call) => call.text.includes(name))

    expect(table('inbox_items')).toBeGreaterThanOrEqual(0)
    expect(table('mention_requests')).toBeGreaterThanOrEqual(0)
    expect(table('resource_shares')).toBeGreaterThanOrEqual(0)
    // `DELETE FROM conversations`, not `FROM conversations`: the three
    // collaboration statements now name that table too, inside their subquery.
    for (const name of ['inbox_items', 'mention_requests', 'resource_shares']) {
      expect(table(name)).toBeLessThan(table('DELETE FROM conversations'))
    }
  })

  it('expresses the conversation set as a subquery, not as N bound parameters', async () => {
    /*
      What this pins: with 70_000 conversations — past Postgres's hard 65535
      parameters per statement — each collaboration delete still binds exactly
      ONE value (the project id) and reads its target set from the conversations
      table. The old form (`IN ${tx(conversationIds)}`) bound one parameter per
      id, so the statement was refused with MAX_PARAMETERS_EXCEEDED *after* the
      Chroma collection, the SeaweedFS objects and the WorkOS resource were
      already destroyed — leaving the queue row stuck in 'purging' (the header's
      point: status, not a lock, is what prevents re-claim) with no retry that
      could ever succeed.

      What it CANNOT prove: nothing here talks to Postgres. The mock resolves
      every statement to `[]` and never expands anything, so the old code RAN
      green against it at any conversation count — the bug was invisible to this
      file, not caught by it. Hence the assertions are on the SHAPE of the
      statement (one bound value, a subquery in the text, no `tx(array)` call)
      rather than on an outcome: shape is all a mock can witness. That the
      subquery selects the same rows the id list did, that 65535 is the real
      limit, and that the delete ORDER is right against the live schema are facts
      only an integration test against a real database can establish.
    */
    const conversationRows = Array.from({ length: 70_000 }, (_, i) => ({ id: `c${i}` }))
    const { tx, executed, expansions } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_p1' },
      conversationRows,
    })

    await purgeProject(tx, entry, makeDeps())

    // No `tx(array)` anywhere: that call is the parameter expansion itself.
    expect(expansions).toEqual([])

    const collaborationDeletes = executed.filter(
      (call) =>
        call.text.startsWith('DELETE') &&
        ['inbox_items', 'mention_requests', 'resource_shares'].some((name) =>
          call.text.includes(name),
        ),
    )
    expect(collaborationDeletes).toHaveLength(3)
    for (const call of collaborationDeletes) {
      expect(call.values).toEqual(['p1'])
      expect(call.text).toContain('IN (SELECT id FROM conversations WHERE project_id = $)')
    }
  })

  it('still issues the collaboration deletes when the gathered snapshot was empty', async () => {
    // An empty snapshot does not mean the project is empty when the deletes run:
    // conversation creation checks access and inserts as two separate steps, so a
    // request that passed the check before the soft delete can commit its insert
    // after our SELECT. Skipping the three statements on an empty snapshot would
    // leave that conversation's grants, mention requests and inbox items behind
    // while `DELETE FROM conversations` below removed the row they point at.
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_p1' },
      conversationRows: [],
    })

    await purgeProject(tx, entry, makeDeps())

    const deletes = executed.filter((call) => call.text.startsWith('DELETE'))
    for (const name of ['inbox_items', 'mention_requests', 'resource_shares']) {
      expect(deletes.some((call) => call.text.includes(name))).toBe(true)
    }
  })
})

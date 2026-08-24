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
function makeTx({
  projectRow,
  conversationRows,
  holdRows = [],
  documentBucketRows = [],
  /**
   * `documents` rows for files attached privately to this project's chats
   * (ADR-0047 Phase 2): `{ conversation_id, collection_name, storage_bucket }`.
   * They answer a DIFFERENT query from `documentBucketRows` — a session
   * document's `project_id` is NULL, so the project-scoped bucket read cannot
   * see it, which is exactly how its object and its chunks were being stranded.
   */
  sessionDocumentRows = [],
  /**
   * Hold rows to return on the Nth `legal_holds` read, so a test can place a
   * hold PART WAY through the purge. `holdRows` still covers "held from the
   * start"; this covers "held after we began", which is the case the per-step
   * re-check exists for.
   */
  holdOnCheck = {},
}) {
  const executed = []
  const expansions = []
  let holdChecks = 0
  const tx = (strings, ...values) => {
    if (!Array.isArray(strings) || !('raw' in strings)) {
      expansions.push(strings)
      return Promise.resolve([])
    }
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    executed.push({ text, values })
    if (text.startsWith('SELECT') && text.includes('FROM legal_holds')) {
      holdChecks += 1
      return Promise.resolve(holdOnCheck[holdChecks] ?? holdRows)
    }
    if (text.startsWith('SELECT') && text.includes('FROM projects')) {
      return Promise.resolve(projectRow ? [projectRow] : [])
    }
    // Before the `conversations` branch: this statement names that table too,
    // inside its subquery.
    if (text.includes('FROM documents') && text.includes("scope = 'session'")) {
      return Promise.resolve(sessionDocumentRows)
    }
    if (text.startsWith('SELECT') && text.includes('FROM conversations')) {
      return Promise.resolve(conversationRows)
    }
    if (text.startsWith('SELECT DISTINCT storage_bucket')) {
      return Promise.resolve(documentBucketRows)
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

  // Per-organization buckets (ADR-0043). An organization that predates the flip
  // has objects in the shared bucket AND in its own, so a purge that visits only
  // one of them leaves half the tenant's files behind while deleting the rows
  // that named them — an erasure that reports success and did not happen.
  //
  // The list comes from the DOCUMENT ROWS, not from re-deriving the bucket name.
  // That is the same principle the column exists for: the bucket is recorded so
  // nothing has to recompute it, and the purge is the one place where a naming
  // disagreement would be invisible.
  it('sweeps every bucket the project documents actually recorded', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
      documentBucketRows: [{ storage_bucket: 'grid-org-org1-abcdef123456' }],
    })

    const deps = makeDeps()
    await purgeProject(tx, entry, deps)

    expect(deps.deleteStoragePrefix.mock.calls).toEqual([
      ['grid-documents', 'org/org1/project/p1/'],
      ['grid-org-org1-abcdef123456', 'org/org1/project/p1/'],
    ])
  })

  // The shared bucket is unconditional: NULL means shared (migration 0033), so
  // a project whose documents all predate the column records nothing, and the
  // sweep must still reach them.
  it('always sweeps the shared bucket, even when no row records one', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
      documentBucketRows: [],
    })

    const deps = makeDeps()
    await purgeProject(tx, entry, deps)

    expect(deps.deleteStoragePrefix.mock.calls).toEqual([
      ['grid-documents', 'org/org1/project/p1/'],
    ])
  })

  // Two documents in the same bucket must not produce two sweeps of it.
  it('visits each bucket once', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
      documentBucketRows: [
        { storage_bucket: 'grid-documents' },
        { storage_bucket: 'grid-org-org1-abcdef123456' },
      ],
    })

    const deps = makeDeps()
    await purgeProject(tx, entry, deps)

    expect(deps.deleteStoragePrefix.mock.calls).toHaveLength(2)
  })

  // A hold placed mid-sweep. The hold check used to run once before the loop, so
  // once the first bucket's sweep had started the erasure continued through every
  // remaining bucket regardless — which is exactly what a legal hold exists to
  // stop. The loop now re-checks per bucket, so the second sweep never happens.
  it('stops between buckets when a hold appears mid-sweep', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
      documentBucketRows: [{ storage_bucket: 'grid-org-org1-abcdef123456' }],
      // Checks 1 and 2 are the pre-flight and post-backend ones; 3 guards the
      // first bucket, 4 the second. Placing the hold at 4 lets one sweep run.
      holdOnCheck: { 4: [{ '?column?': 1 }] },
    })

    const deps = makeDeps()
    await expect(purgeProject(tx, entry, deps)).rejects.toMatchObject({ code: 'LEGAL_HOLD_ACTIVE' })
    expect(deps.deleteStoragePrefix.mock.calls).toHaveLength(1)
    // And nothing downstream ran, so the pointers still name the surviving bytes.
    expect(deps.workos.authorization.deleteResourceByExternalId).not.toHaveBeenCalled()
  })

  // The prefix delete throws on a partial failure so the queue row retries. That
  // guarantee has to survive the loop: if the SECOND bucket cannot be cleared,
  // the purge must still fail, or the pointers get deleted while the objects
  // remain.
  it('fails the purge when a later bucket cannot be cleared', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [],
      documentBucketRows: [{ storage_bucket: 'grid-org-org1-abcdef123456' }],
    })
    const deleteStoragePrefix = vi
      .fn()
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce(new Error('SeaweedFS delete reported 2 error(s)'))
    const deps = makeDeps({ deleteStoragePrefix })

    await expect(purgeProject(tx, entry, deps)).rejects.toThrow(/SeaweedFS delete reported/)
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

/**
 * Files a user dropped privately into one of the project's chats (ADR-0047
 * Phase 2). Their external state is invisible to every other step in this file:
 *
 *   - the row has a NULL `project_id`, so the bucket read in step 2 misses it;
 *   - its object is at `org/<org>/session/<conversation>/…`, which the project
 *     prefix sweep does not cover;
 *   - its chunks are in the chat's own `s_<conversation>` collection, which the
 *     backend purge — handed only the PROJECT's collection name — never touches.
 *
 * And `DELETE FROM conversations` cascades the rows away, so after a purge the
 * bytes and the chunks are still there with nothing naming them: no listing, no
 * ledger entry, no id to retry from. These tests pin that each of the three is
 * now erased, and that a failure stops the row deletes rather than proceeding.
 */
describe('session attachments', () => {
  const sessionEntry = {
    ...entry,
    payload: { collectionName: 'proj_fallback' },
  }

  it('purges each chat’s own collection, before any row is deleted', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }, { id: 's_c2' }],
      sessionDocumentRows: [
        { conversation_id: 's_c1', collection_name: 's_c1', storage_bucket: null },
        { conversation_id: 's_c2', collection_name: 's_c2', storage_bucket: null },
      ],
    })
    const deps = makeDeps()

    await purgeProject(tx, sessionEntry, deps)

    const collections = deps.fetchImpl.mock.calls.map(
      (call) => JSON.parse(call[1].body).collection_name,
    )
    expect(collections).toEqual(['proj_abc', 's_c1', 's_c2'])
    // Every backend call happened before the first grid_app row delete: the
    // rows are what name these collections, so losing them first would leave
    // nothing to retry from.
    expect(executed.filter((q) => q.text.startsWith('DELETE'))).not.toHaveLength(0)
  })

  it('sweeps each chat’s storage prefix, in the buckets its own rows record', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }],
      sessionDocumentRows: [
        { conversation_id: 's_c1', collection_name: 's_c1', storage_bucket: 'grid-org-org1-abcdef123456' },
      ],
    })
    const deps = makeDeps()

    await purgeProject(tx, sessionEntry, deps)

    expect(deps.deleteStoragePrefix.mock.calls).toEqual([
      // The project's own prefix, in the shared bucket (no project document row
      // records another one).
      ['grid-documents', 'org/org1/project/p1/'],
      // …and the chat's prefix, which shares no ancestor with it.
      ['grid-documents', 'org/org1/session/s_c1/'],
      ['grid-org-org1-abcdef123456', 'org/org1/session/s_c1/'],
    ])
  })

  it('leaves the chat prefixes alone when no chat holds an attachment', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }, { id: 's_c2' }],
      sessionDocumentRows: [],
    })
    const deps = makeDeps()

    await purgeProject(tx, sessionEntry, deps)

    expect(deps.deleteStoragePrefix.mock.calls).toEqual([['grid-documents', 'org/org1/project/p1/']])
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
  })

  // The backend answers 200 with `status: "failed"` when the collection existed
  // and the delete returned falsy. Treated as success, that is an orphaned
  // collection of private chat content reported as an erasure — and the rows
  // that name it would be gone one statement later.
  it('aborts the purge, rows intact, when a chat collection cannot be erased', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }],
      sessionDocumentRows: [
        { conversation_id: 's_c1', collection_name: 's_c1', storage_bucket: null },
      ],
    })
    const deps = makeDeps({
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ok' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) }),
    })

    await expect(purgeProject(tx, sessionEntry, deps)).rejects.toThrow(/reported failure for collection s_c1/)

    expect(deps.deleteStoragePrefix).not.toHaveBeenCalled()
    expect(deps.workos.authorization.deleteResourceByExternalId).not.toHaveBeenCalled()
    expect(executed.some((q) => q.text.startsWith('DELETE'))).toBe(false)
  })

  it('aborts the purge, rows intact, when a chat prefix cannot be swept', async () => {
    const { tx, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }],
      sessionDocumentRows: [
        { conversation_id: 's_c1', collection_name: 's_c1', storage_bucket: null },
      ],
    })
    const deps = makeDeps({
      deleteStoragePrefix: vi
        .fn()
        .mockResolvedValueOnce(3)
        .mockRejectedValueOnce(new Error('SeaweedFS delete reported 2 error(s)')),
    })

    await expect(purgeProject(tx, sessionEntry, deps)).rejects.toThrow(/SeaweedFS delete reported/)
    expect(executed.some((q) => q.text.startsWith('DELETE'))).toBe(false)
  })

  // Same discipline as the collaboration deletes below: the conversation set is
  // a SUBQUERY, so the statement binds one parameter whatever the chat count.
  it('reads the attachments through a subquery, not N bound conversation ids', async () => {
    const conversationRows = Array.from({ length: 70_000 }, (_, i) => ({ id: `s_c${i}` }))
    const { tx, expansions, executed } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows,
      sessionDocumentRows: [],
    })

    await purgeProject(tx, sessionEntry, makeDeps())

    expect(expansions).toEqual([])
    const read = executed.find(
      (q) => q.text.includes('FROM documents') && q.text.includes("scope = 'session'"),
    )
    expect(read).toBeDefined()
    expect(read.values).toEqual(['p1'])
    expect(read.text).toContain('IN (SELECT id FROM conversations WHERE project_id = $)')
  })

  // A legal hold placed after the project's own collection went, but before the
  // chats' collections do. The erasure must stop where the hold arrived.
  it('stops before a chat collection when a hold appears mid-purge', async () => {
    const { tx } = makeTx({
      projectRow: { id: 'p1', collection_name: 'proj_abc' },
      conversationRows: [{ id: 's_c1' }],
      sessionDocumentRows: [
        { conversation_id: 's_c1', collection_name: 's_c1', storage_bucket: null },
      ],
      // 1 is the pre-flight check; 2 guards the first session collection.
      holdOnCheck: { 2: [{ '?column?': 1 }] },
    })
    const deps = makeDeps()

    await expect(purgeProject(tx, sessionEntry, deps)).rejects.toMatchObject({
      code: LEGAL_HOLD_CODE,
    })
    // The project's own collection was already purged; the chat's was not.
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1)
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
    expect(table('resource_assignments')).toBeGreaterThanOrEqual(0)
    // `DELETE FROM conversations`, not `FROM conversations`: the collaboration
    // statements now name that table too, inside their subquery.
    for (const name of [
      'inbox_items',
      'mention_requests',
      'resource_shares',
      'resource_assignments',
    ]) {
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

    const conversationDeletes = executed.filter(
      (call) =>
        call.text.startsWith('DELETE') &&
        call.text.includes("resource_type = 'conversation'") &&
        ['inbox_items', 'mention_requests', 'resource_shares'].some((name) =>
          call.text.includes(name),
        ),
    )
    expect(conversationDeletes).toHaveLength(3)
    for (const call of conversationDeletes) {
      expect(call.values).toEqual(['p1'])
      expect(call.text).toContain('IN (SELECT id FROM conversations WHERE project_id = $)')
    }

    const documentDeletes = executed.filter(
      (call) =>
        call.text.startsWith('DELETE') &&
        call.text.includes("resource_type = 'document'") &&
        ['inbox_items', 'mention_requests', 'resource_shares', 'resource_assignments'].some(
          (name) => call.text.includes(name),
        ),
    )
    expect(documentDeletes).toHaveLength(4)
    for (const call of documentDeletes) {
      expect(call.values).toEqual(['p1'])
      expect(call.text).toContain('IN (SELECT id::text FROM documents WHERE project_id = $)')
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
    for (const name of [
      'inbox_items',
      'mention_requests',
      'resource_shares',
      'resource_assignments',
    ]) {
      expect(deletes.some((call) => call.text.includes(name))).toBe(true)
    }
  })
})

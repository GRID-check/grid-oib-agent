// @ts-check
/**
 * Ordered, idempotent purge steps for one project.
 *
 * Concurrency guarantee (precise): the queue row is NOT held under a DB lock
 * across the purge — the claim (Phase A) commits its own transaction, and this
 * runs in a fresh `tx` that does not re-lock the row. What prevents a
 * concurrent re-claim or restore is the row's `status='purging'`, not a lock.
 * grid_app rows are deleted only after every external store confirmed cleanup,
 * and the project row dies LAST so pointers stay recoverable on retry.
 *
 * Legal-hold residual window: the hold is re-checked before each external
 * destructive step, but those steps (backend HTTP, SeaweedFS, WorkOS) are outside
 * any DB transaction, so a hold committed mid-step cannot roll them back. The
 * window is bounded to a single step rather than the whole purge.
 */

const { hasActiveHold } = require('./db')

/** @typedef {import('./types').Tx} Tx */
/** @typedef {import('./types').QueueEntry} QueueEntry */
/** @typedef {import('./types').PurgeDeps} PurgeDeps */

/** error.code used to signal "hold appeared after claim" to the caller. */
const LEGAL_HOLD_CODE = 'LEGAL_HOLD_ACTIVE'

// Only a real 404 means "already gone" (idempotent success). Matching the word
// "not found" anywhere in a message wrongly swallowed errors like WorkOS's
// "Organization not found" or a proxy "upstream host not found", leaking the
// resource while the row was marked purged.
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    /** @type {{ status?: unknown }} */ (error).status === 404
  )
}

/**
 * Throw LEGAL_HOLD_ACTIVE if a hold now covers this entry.
 *
 * @param {Tx} tx
 * @param {QueueEntry} entry
 * @returns {Promise<void>}
 */
async function assertNoHold(tx, entry) {
  if (await hasActiveHold(tx, entry)) {
    /** @type {import('./types').LegalHoldError} */
    const error = new Error(
      `legal hold active for ${entry.entity_type} ${entry.entity_id} — aborting purge`,
    )
    error.code = LEGAL_HOLD_CODE
    throw error
  }
}

/**
 * Ask the backend to erase one Chroma collection (and the summaries, job rows
 * and checkpoints that hang off it), throwing on anything short of success.
 *
 * Extracted because the project's own collection is no longer the only one a
 * project purge has to erase: every chat inside it may hold a private
 * `s_<conversationId>` collection of its own (ADR-0047 Phase 2). The endpoint
 * takes an arbitrary collection name, so nothing about it is project-specific
 * except its name.
 *
 * The two failure shapes are both retryable and both must throw: a non-2xx, and
 * a 200 whose body says `status: "failed"` — the endpoint answers 200 when the
 * collection existed and `delete_collection` returned falsy, which is an
 * orphaned collection reported as an erasure.
 *
 * @param {PurgeDeps} deps
 * @param {typeof fetch} fetchImpl
 * @param {string | null} collectionName
 * @param {string[]} conversationIds
 * @returns {Promise<void>}
 */
async function purgeBackendCollection(deps, fetchImpl, collectionName, conversationIds) {
  const res = await fetchImpl(`${deps.backendUrl}/v1/maintenance/purge-project-resources`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': deps.internalToken,
    },
    body: JSON.stringify({
      collection_name: collectionName,
      conversation_ids: conversationIds,
    }),
  })
  if (!res.ok) {
    throw new Error(`backend purge failed with status ${res.status}`)
  }
  const body = typeof res.json === 'function' ? await res.json().catch(() => ({})) : {}
  if (body && body.status === 'failed') {
    throw new Error(`backend purge reported failure for collection ${collectionName}`)
  }
}

/**
 * @param {Tx} tx
 * @param {QueueEntry} entry
 * @param {PurgeDeps} deps
 * @returns {Promise<void>}
 */
async function purgeProject(tx, entry, deps) {
  const { bucket, workos, deleteStoragePrefix } = deps
  const fetchImpl = deps.fetchImpl || fetch
  const projectId = entry.entity_id
  const orgId = entry.organization_id

  // Re-check legal holds NOW, before any destruction. claimNext already
  // filtered held rows, but a hold created between claim and this point
  // (TOCTOU) must still block destruction. The caller releases the row back
  // to 'pending' when this throws. Re-checked again before each external step.
  await assertNoHold(tx, entry)

  // Gather pointers BEFORE destroying anything. Fall back to the payload
  // snapshot if a previous partial run already removed the row.
  const [project] = await tx`SELECT * FROM projects WHERE id = ${projectId}`
  // Narrowed at the boundary like every other raw SQL / payload read here: both
  // sources are `unknown` to the compiler and the name is a string or nothing.
  const collectionName = /** @type {string | null} */ (
    project ? project.collection_name : (entry.payload && entry.payload.collectionName) || null
  )
  // Narrowed at the boundary, where the SQL shape is known — the same rule
  // AGENTS.md sets for raw `sql<T>` results in the repositories.
  const conversations = /** @type {{ id: string }[]} */ (
    await tx`SELECT id FROM conversations WHERE project_id = ${projectId}`
  )

  //    The private attachments hanging off this project's chats (ADR-0047
  //    Phase 2), read HERE for the same reason as everything else on this line:
  //    step 4 deletes the conversations, the document rows cascade off them, and
  //    after that nothing names these objects or these collections.
  //
  //    They are invisible to every other query in this file, which is exactly
  //    how they were being stranded. A session document has a NULL `project_id`
  //    (its shelf is the conversation), so the bucket read below does not see
  //    it. Its object lives under `org/<org>/session/<conversation>/`, which the
  //    project prefix sweep does not cover. And its chunks live in the chat's
  //    own `s_<conversation>` collection, which the backend purge — given only
  //    the PROJECT's collection name — does not touch. Three misses, one
  //    outcome: the cascade took the rows and every byte of it survived.
  const sessionDocuments = /** @type {{ conversation_id: string, collection_name: string | null, storage_bucket: string | null }[]} */ (
    await tx`
      SELECT DISTINCT conversation_id, collection_name, storage_bucket
        FROM documents
       WHERE scope = 'session'
         AND conversation_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
  )
  // Same subquery discipline as step 4: one bound parameter regardless of how
  // many conversations the project holds, and it reads the conversation set at
  // statement time rather than from the snapshot above.

  // 1. Python-side stores: Chroma collection, summaries, job rows, checkpoints.
  await purgeBackendCollection(
    deps,
    fetchImpl,
    collectionName,
    conversations.map((c) => c.id),
  )

  // 1b. The per-chat collections. One call each, and only for chats that
  //     actually hold attachments — the rows say which, so a project of ten
  //     thousand chats and one uploaded PDF makes one call.
  //
  //     A failure here throws exactly like the project collection's does, which
  //     is the point: the whole purge is retried and NOTHING below has run, so
  //     the document rows that name these collections still exist to drive the
  //     retry. Deleting the conversations first would have removed the only
  //     record that these collections were ever ours to erase.
  const sessionCollections = new Set(
    sessionDocuments.map((row) => row.collection_name).filter((name) => Boolean(name)),
  )
  for (const sessionCollection of sessionCollections) {
    // Per collection, not once for the loop: each is an external destructive
    // step, and a hold placed part way through must stop the rest (file header).
    await assertNoHold(tx, entry)
    await purgeBackendCollection(deps, fetchImpl, sessionCollection, [])
  }

  // Re-check the hold before EACH external destructive step to keep the TOCTOU
  // window to a single step (see file header). Aborts release the row.
  await assertNoHold(tx, entry)
  // 2. SeaweedFS objects under the project prefix, in every bucket that holds
  //    them.
  //
  //    READ from the ledger rather than DERIVED from the organization id. Under
  //    ADR-0043 each document records the bucket it was written to precisely so
  //    that nothing has to recompute it — and a purge that recomputed it would
  //    be the one place where a naming disagreement is invisible: it would
  //    sweep a bucket that does not exist, find nothing, and report the erasure
  //    complete. Asking the rows is also strictly more complete than deriving,
  //    because it finds buckets written under a PREVIOUS prefix configuration,
  //    which no current-rule derivation can.
  //
  //    Read here, before step 4 deletes the rows that answer it. The shared
  //    bucket is always included: NULL means shared (migration 0033), and an
  //    orphaned object from an upload whose row insert failed can only be
  //    there or in a bucket a sibling document names.
  //
  //    Sequential rather than concurrent on purpose: the prefix sweep is a
  //    list-then-delete loop, and running several against one storage tier only
  //    trades a rarely-hot latency for contention on the thing being erased.
  const recorded = /** @type {{ storage_bucket: string }[]} */ (
    await tx`
      SELECT DISTINCT storage_bucket FROM documents
       WHERE project_id = ${projectId} AND storage_bucket IS NOT NULL`
  )
  const targets = new Set([bucket, ...recorded.map((row) => row.storage_bucket)])
  for (const target of targets) {
    // Re-checked per BUCKET, not once for the loop. The hold check above bounds
    // the window to a single step, and this loop is now N destructive steps —
    // one sweep per bucket, each of which can take a while. A hold placed after
    // the first sweep began would otherwise be ignored for every bucket after
    // it, which is precisely the case a legal hold exists to stop: the erasure
    // continues past the moment someone said stop, and reports success.
    await assertNoHold(tx, entry)
    await deleteStoragePrefix(target, `org/${orgId}/project/${projectId}/`)
  }

  // 2b. SeaweedFS objects under each CHAT's prefix.
  //
  //     A session attachment is written to
  //     `org/<org>/session/<conversation>/doc/<id>/<file>` (`lib/s3.ts`), which
  //     shares no prefix with `org/<org>/project/<project>/` — so the loop above
  //     sweeps past it however many buckets it visits. One prefix per
  //     conversation is what makes it a sweep rather than a per-row loop, and it
  //     also catches the object whose row insert failed after the write, which
  //     no row-driven delete could find.
  //
  //     The bucket set is per conversation, from that conversation's own rows,
  //     plus the shared bucket — the same rule and the same reason as above.
  //     Session rows are the only ones that answer here: their `project_id` is
  //     NULL, so the query above cannot see them.
  //
  //     The prefix uses the conversation id verbatim. `buildSessionStorageKey`
  //     passes it through `storageKeySegment`, which is the identity for every
  //     id the app mints (`s_<uuid>`: no separators, no control characters, far
  //     under the length cap) — the sanitiser is there to stop a hand-crafted id
  //     climbing out of the org prefix, not to rewrite real ones.
  /** @type {Map<string, Set<string>>} */
  const sessionBuckets = new Map()
  for (const row of sessionDocuments) {
    const forConversation = sessionBuckets.get(row.conversation_id) ?? new Set([bucket])
    if (row.storage_bucket) forConversation.add(row.storage_bucket)
    sessionBuckets.set(row.conversation_id, forConversation)
  }
  for (const [conversationId, buckets] of sessionBuckets) {
    for (const target of buckets) {
      await assertNoHold(tx, entry)
      await deleteStoragePrefix(target, `org/${orgId}/session/${conversationId}/`)
    }
  }

  await assertNoHold(tx, entry)
  // 3. WorkOS FGA resource (+ role assignments). Already-gone is success.
  try {
    await workos.authorization.deleteResourceByExternalId({
      organizationId: orgId,
      resourceTypeSlug: 'project',
      externalId: projectId,
      cascadeDelete: true,
    })
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  // 4. grid_app rows: the collaboration rows FIRST, then conversations
  //    (messages and conversation_reads cascade), then the project row
  //    (documents / folders / project-scoped memory cascade).
  //
  //    The collaboration tables address their target as a polymorphic
  //    `(resource_type, resource_id)` pair with no foreign key (ADR-0032), so
  //    nothing about them cascades — deleting the conversations first simply
  //    orphaned every grant, every open mention request and every inbox item
  //    for good. The rows are invisible to access checks, but they keep
  //    inflating roster counts and leave permanently redacted entries in
  //    people's inboxes, for a project that no longer exists.
  //
  //    The conversation set is expressed as a SUBQUERY, not as a list of bound
  //    ids. `IN ${tx(ids)}` expands to one placeholder per id, and Postgres
  //    refuses any statement with more than 65535 of them — so a project with
  //    tens of thousands of conversations threw MAX_PARAMETERS_EXCEEDED here,
  //    *after* Chroma, SeaweedFS and WorkOS had already been destroyed. Nothing
  //    recovers from that: the queue row is guarded by `status='purging'` rather
  //    than by a lock (see the file header), so it stays stuck in 'purging',
  //    and every retry would fail on the same statement against external stores
  //    that no longer exist. The subquery binds ONE parameter regardless of how
  //    many conversations the project holds, so the statement count and the
  //    parameter count are both constant.
  //
  //    Reading the set from the table also closes a snapshot gap: a conversation
  //    that appeared after the SELECT above is still caught by
  //    `DELETE FROM conversations WHERE project_id = …` below, but was absent
  //    from the gathered id list — so its collaboration rows were orphaned by
  //    the very statements meant to prevent that. Same transaction, same
  //    predicate, and the conversations are still present when these run.
  //
  //    These run UNCONDITIONALLY, including for a project that held no
  //    conversations at gather time. Creating a conversation checks project
  //    access and inserts in separate operations, so a request that passed the
  //    check before the soft delete can commit its insert after our SELECT; a
  //    guard on the empty snapshot would then skip all three statements while
  //    `DELETE FROM conversations` below still removed that row — orphaning its
  //    grants, mention requests and inbox items for good. Three no-op deletes
  //    are cheaper than that.
  //
  //    `conversations.id` and `resource_id` are both `text`, so the comparison
  //    needs no cast.
  await tx`DELETE FROM inbox_items WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
  await tx`DELETE FROM mention_requests WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
  await tx`DELETE FROM resource_shares WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
  await tx`DELETE FROM inbox_items WHERE resource_type = 'document' AND resource_id IN (SELECT id::text FROM documents WHERE project_id = ${projectId})`
  await tx`DELETE FROM mention_requests WHERE resource_type = 'document' AND resource_id IN (SELECT id::text FROM documents WHERE project_id = ${projectId})`
  await tx`DELETE FROM resource_shares WHERE resource_type = 'document' AND resource_id IN (SELECT id::text FROM documents WHERE project_id = ${projectId})`
  await tx`DELETE FROM resource_assignments WHERE resource_type = 'document' AND resource_id IN (SELECT id::text FROM documents WHERE project_id = ${projectId})`
  await tx`DELETE FROM conversations WHERE project_id = ${projectId}`
  await tx`DELETE FROM projects WHERE id = ${projectId}`
}

module.exports = { LEGAL_HOLD_CODE, purgeProject }

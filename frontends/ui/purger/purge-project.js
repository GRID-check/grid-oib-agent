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

/** error.code used to signal "hold appeared after claim" to the caller. */
const LEGAL_HOLD_CODE = 'LEGAL_HOLD_ACTIVE'

// Only a real 404 means "already gone" (idempotent success). Matching the word
// "not found" anywhere in a message wrongly swallowed errors like WorkOS's
// "Organization not found" or a proxy "upstream host not found", leaking the
// resource while the row was marked purged.
function isNotFound(error) {
  return error != null && error.status === 404
}

/** Throw LEGAL_HOLD_ACTIVE if a hold now covers this entry. */
async function assertNoHold(tx, entry) {
  if (await hasActiveHold(tx, entry)) {
    const error = new Error(
      `legal hold active for ${entry.entity_type} ${entry.entity_id} — aborting purge`,
    )
    error.code = LEGAL_HOLD_CODE
    throw error
  }
}

async function purgeProject(tx, entry, deps) {
  const { backendUrl, internalToken, bucket, workos, deleteStoragePrefix } = deps
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
  const collectionName = project
    ? project.collection_name
    : (entry.payload && entry.payload.collectionName) || null
  const conversations = await tx`SELECT id FROM conversations WHERE project_id = ${projectId}`

  // 1. Python-side stores: Chroma collection, summaries, job rows, checkpoints.
  const res = await fetchImpl(`${backendUrl}/v1/maintenance/purge-project-resources`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-token': internalToken,
    },
    body: JSON.stringify({
      collection_name: collectionName,
      conversation_ids: conversations.map((c) => c.id),
    }),
  })
  if (!res.ok) {
    throw new Error(`backend purge failed with status ${res.status}`)
  }
  // The backend returns 200 even when the collection delete failed; treat an
  // explicit failure as retryable rather than orphaning the Chroma collection.
  const body =
    typeof res.json === 'function' ? await res.json().catch(() => ({})) : {}
  if (body && body.status === 'failed') {
    throw new Error(`backend purge reported failure for collection ${collectionName}`)
  }

  // Re-check the hold before EACH external destructive step to keep the TOCTOU
  // window to a single step (see file header). Aborts release the row.
  await assertNoHold(tx, entry)
  // 2. SeaweedFS objects under the project prefix.
  await deleteStoragePrefix(bucket, `org/${orgId}/project/${projectId}/`)

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
  //    Reading the set from the table also narrows a snapshot gap: a conversation
  //    that appeared after the SELECT above is still caught by
  //    `DELETE FROM conversations WHERE project_id = …` below, but was absent
  //    from the gathered id list — so its collaboration rows were orphaned by
  //    the very statements meant to prevent that. Same transaction, same
  //    predicate, and the conversations are still present when these run. (The
  //    guard below is still the gathered snapshot, so a project that was empty
  //    at gather time issues no collaboration statements at all, as before.)
  //
  //    `conversations.id` and `resource_id` are both `text`, so the comparison
  //    needs no cast.
  if (conversations.length > 0) {
    await tx`DELETE FROM inbox_items WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
    await tx`DELETE FROM mention_requests WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
    await tx`DELETE FROM resource_shares WHERE resource_type = 'conversation' AND resource_id IN (SELECT id FROM conversations WHERE project_id = ${projectId})`
  }
  await tx`DELETE FROM conversations WHERE project_id = ${projectId}`
  await tx`DELETE FROM projects WHERE id = ${projectId}`
}

module.exports = { LEGAL_HOLD_CODE, purgeProject }

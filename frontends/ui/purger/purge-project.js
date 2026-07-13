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
 * destructive step, but those steps (backend HTTP, S3, WorkOS) are outside
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
  const { backendUrl, internalToken, bucket, workos, deleteS3Prefix } = deps
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
  // 2. S3 objects under the project prefix.
  await deleteS3Prefix(bucket, `org/${orgId}/project/${projectId}/`)

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

  // 4. grid_app rows: conversations explicitly (messages cascade), then the
  //    project row (documents / folders / project-scoped memory cascade).
  await tx`DELETE FROM conversations WHERE project_id = ${projectId}`
  await tx`DELETE FROM projects WHERE id = ${projectId}`
}

module.exports = { LEGAL_HOLD_CODE, purgeProject }

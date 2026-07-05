/**
 * Ordered, idempotent purge steps for one project. Runs inside a single
 * grid_app transaction (`tx`) held open by the caller: the queue row stays
 * locked, and grid_app rows are only deleted after every external store
 * confirmed cleanup — the project row dies last so pointers stay recoverable.
 */

const { hasActiveHold } = require('./db')

/** error.code used to signal "hold appeared after claim" to the caller. */
const LEGAL_HOLD_CODE = 'LEGAL_HOLD_ACTIVE'

function isNotFound(error) {
  return error && (error.status === 404 || /not found/i.test(String(error.message)))
}

async function purgeProject(tx, entry, deps) {
  const { backendUrl, internalToken, bucket, workos, deleteMinioPrefix } = deps
  const fetchImpl = deps.fetchImpl || fetch
  const projectId = entry.entity_id
  const orgId = entry.organization_id

  // Re-check legal holds NOW, inside the purge transaction. claimNext already
  // filtered held rows, but a hold created between claim and this point
  // (TOCTOU) must still block destruction. The caller releases the row back
  // to 'pending' when this throws.
  if (await hasActiveHold(tx, entry)) {
    const error = new Error(
      `legal hold active for ${entry.entity_type} ${entry.entity_id} — aborting purge`,
    )
    error.code = LEGAL_HOLD_CODE
    throw error
  }

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

  // 2. MinIO objects under the project prefix.
  await deleteMinioPrefix(bucket, `org/${orgId}/project/${projectId}/`)

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

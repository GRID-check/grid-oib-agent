/**
 * Org model configuration service — versioned per-org model overrides.
 *
 * Data model (ADR-0014): `org_model_configs` holds the per-org pointer to the
 * active version; `org_model_config_versions` is immutable append-only
 * history. Saving creates a new version and activates it; rollback repoints
 * the meta row at an older version. Nothing is ever rewritten.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { getCached, invalidateCached } from '@/lib/cache'
import {
  orgModelConfigs,
  orgModelConfigVersions,
  type OrgModelConfigVersion,
} from '@/lib/db/schema'

const OVERRIDES_CACHE_TTL_MS = 5 * 60 * 1000

const overridesCacheKey = (organizationId: string): string => `modeloverrides:${organizationId}`

export interface ModelOverrides {
  [agentGroupId: string]: { model: string }
}

export interface OrgModelConfigView {
  activeVersion: OrgModelConfigVersion | null
  updatedBy: string | null
  updatedAt: Date | null
}

/** The org's current configuration (active version or "defaults"). */
export async function getOrgModelConfig(organizationId: string): Promise<OrgModelConfigView> {
  const db = getDb()
  const [meta] = await db
    .select()
    .from(orgModelConfigs)
    .where(eq(orgModelConfigs.organizationId, organizationId))
    .limit(1)
  if (!meta?.activeVersionId) {
    return { activeVersion: null, updatedBy: meta?.updatedBy ?? null, updatedAt: meta?.updatedAt ?? null }
  }
  const [version] = await db
    .select()
    .from(orgModelConfigVersions)
    .where(eq(orgModelConfigVersions.id, meta.activeVersionId))
    .limit(1)
  return { activeVersion: version ?? null, updatedBy: meta.updatedBy, updatedAt: meta.updatedAt }
}

/**
 * The flat `{group: modelId}` map the runtime header carries, or null when
 * the org runs on workflow defaults. Read on every WS upgrade — cached
 * (write-invalidate: config saves/rollbacks drop the entry, ADR-0020).
 */
export async function getActiveModelOverrides(organizationId: string): Promise<Record<string, string> | null> {
  return getCached(overridesCacheKey(organizationId), OVERRIDES_CACHE_TTL_MS, async () => {
    const { activeVersion } = await getOrgModelConfig(organizationId)
    if (!activeVersion) return null
    const overrides = activeVersion.overrides as ModelOverrides
    const flat: Record<string, string> = {}
    for (const [group, value] of Object.entries(overrides ?? {})) {
      if (value && typeof value.model === 'string') flat[group] = value.model
    }
    return Object.keys(flat).length > 0 ? flat : null
  })
}

export async function listVersions(organizationId: string, limit = 50): Promise<OrgModelConfigVersion[]> {
  const db = getDb()
  return db
    .select()
    .from(orgModelConfigVersions)
    .where(eq(orgModelConfigVersions.organizationId, organizationId))
    .orderBy(desc(orgModelConfigVersions.version))
    .limit(limit)
}

/** Create a new immutable version and make it the active one. */
export async function createAndActivateVersion(params: {
  organizationId: string
  overrides: ModelOverrides
  modelSnapshot: unknown
  comment: string | null
  actorUserId: string
}): Promise<OrgModelConfigVersion> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ version: orgModelConfigVersions.version })
      .from(orgModelConfigVersions)
      .where(eq(orgModelConfigVersions.organizationId, params.organizationId))
      .orderBy(desc(orgModelConfigVersions.version))
      .limit(1)

    const [inserted] = await tx
      .insert(orgModelConfigVersions)
      .values({
        organizationId: params.organizationId,
        version: (latest?.version ?? 0) + 1,
        overrides: params.overrides,
        modelSnapshot: params.modelSnapshot,
        comment: params.comment,
        createdBy: params.actorUserId,
      })
      .returning()

    await tx
      .insert(orgModelConfigs)
      .values({
        organizationId: params.organizationId,
        activeVersionId: inserted.id,
        updatedBy: params.actorUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: orgModelConfigs.organizationId,
        set: { activeVersionId: inserted.id, updatedBy: params.actorUserId, updatedAt: new Date() },
      })

    return inserted
  }).then(async (inserted) => {
    await invalidateCached(overridesCacheKey(params.organizationId))
    return inserted
  })
}

/**
 * Point the org at an existing version (rollback / re-activate).
 * `versionId: null` deactivates all overrides (back to workflow defaults).
 */
export async function activateVersion(params: {
  organizationId: string
  versionId: string | null
  actorUserId: string
}): Promise<OrgModelConfigVersion | null> {
  const db = getDb()
  let version: OrgModelConfigVersion | null = null
  if (params.versionId) {
    const [row] = await db
      .select()
      .from(orgModelConfigVersions)
      .where(
        and(
          eq(orgModelConfigVersions.id, params.versionId),
          eq(orgModelConfigVersions.organizationId, params.organizationId),
        ),
      )
      .limit(1)
    if (!row) throw new Error('not found: version does not exist for this organization')
    version = row
  }
  await db
    .insert(orgModelConfigs)
    .values({
      organizationId: params.organizationId,
      activeVersionId: params.versionId,
      updatedBy: params.actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgModelConfigs.organizationId,
      set: { activeVersionId: params.versionId, updatedBy: params.actorUserId, updatedAt: new Date() },
    })
  await invalidateCached(overridesCacheKey(params.organizationId))
  return version
}

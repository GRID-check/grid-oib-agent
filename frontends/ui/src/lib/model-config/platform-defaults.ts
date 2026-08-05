/**
 * Platform-controlled default model per agent group.
 *
 * The default a group runs on used to be a literal in the workflow YAML
 * (`llms:` → `model_name`), which made "move everyone to the new model" a code
 * change plus a backend redeploy. It is now a row in `platform_model_defaults`,
 * written by the platform owner, and it applies to every organization that has
 * not made its own choice for that group — no restart, no per-tenant action.
 *
 * Resolution order at runtime (see `getEffectiveModelOverrides` in ./service):
 *
 *   1. the org's active `org_model_config_versions` entry for the group  (wins)
 *   2. the platform default for the group                                (this)
 *   3. the workflow YAML `model_name`                                    (boot fallback)
 *
 * Reads are cached like the per-org overrides (ADR-0020's shared cache when
 * `REDIS_URL` is set, per-process otherwise) and write-invalidated, so a save
 * reaches traffic on the next resolution rather than after a TTL.
 */

import 'server-only'
import { asc, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { getCached, invalidateCached } from '@/lib/cache'
import { platformModelDefaults, type PlatformModelDefault } from '@/lib/db/schema'
import { AGENT_GROUP_IDS } from './agent-groups'

const DEFAULTS_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULTS_CACHE_KEY = 'platformmodeldefaults'

/**
 * Anything that can run this module's writes: the pooled handle, or a
 * transaction a caller already opened (see `savePlatformModelDefaults`).
 */
export type PlatformDefaultsExecutor = Pick<ReturnType<typeof getDb>, 'transaction'>

/** `{agentGroupId: modelId}` — only groups the platform owner has pinned. */
export type PlatformModelDefaults = Record<string, string>

export interface PlatformModelDefaultInput {
  /** `{agentGroupId: modelId}`. Groups absent from the map are cleared. */
  defaults: PlatformModelDefaults
  /** Catalog metadata per group at validation time (audit only). */
  modelSnapshot: Record<string, unknown>
  note: string | null
  actorUserId: string
  actorEmail: string | null
}

/**
 * The flat platform defaults, cached and write-invalidated.
 *
 * Throws on a database failure — the runtime merge is the one caller that must
 * never fail, and it catches (see `getEffectiveModelOverrides`); admin surfaces
 * want the error surfaced rather than silently showing "no defaults".
 */
export async function getPlatformModelDefaults(): Promise<PlatformModelDefaults> {
  return getCached(DEFAULTS_CACHE_KEY, DEFAULTS_CACHE_TTL_MS, async () => {
    const db = getDb()
    const rows = await db
      .select({ agentGroup: platformModelDefaults.agentGroup, model: platformModelDefaults.model })
      .from(platformModelDefaults)
    const flat: PlatformModelDefaults = {}
    for (const row of rows) {
      // A group retired from the registry stays in the table until someone
      // saves again; drop it here so it can never reach the backend.
      if (AGENT_GROUP_IDS.includes(row.agentGroup)) flat[row.agentGroup] = row.model
    }
    return flat
  })
}

/** Full rows (model + who/when + snapshot) for the platform admin surface. */
export async function listPlatformModelDefaults(): Promise<PlatformModelDefault[]> {
  const db = getDb()
  return db.select().from(platformModelDefaults).orderBy(asc(platformModelDefaults.agentGroup))
}

/**
 * Replace the platform defaults with `defaults` — the whole set, not a patch.
 *
 * Groups present are upserted; groups absent are deleted, which returns them to
 * the workflow YAML default. One transaction, so a partial write can never
 * leave the fleet split across two model generations.
 */
export async function savePlatformModelDefaults(
  input: PlatformModelDefaultInput,
  /**
   * Run inside an existing transaction instead of opening one.
   *
   * `getDb()` is a POOL, so a caller that needs this write to share a session
   * with something else — the first-boot bootstrap holds a transaction-scoped
   * advisory lock across its guard and this save — cannot get that by calling
   * the pooled handle: the two would land on different connections and the lock
   * would not cover the write. Passing the transaction makes drizzle open a
   * SAVEPOINT on the same connection instead.
   */
  executor?: PlatformDefaultsExecutor,
): Promise<PlatformModelDefault[]> {
  const db = executor ?? getDb()
  const entries = Object.entries(input.defaults)
  const keep = entries.map(([agentGroup]) => agentGroup)

  const rows = await db.transaction(async (tx) => {
    // Clear the groups this save drops. `notInArray` with an empty list is not
    // expressible, so the empty case is a plain full delete.
    if (keep.length === 0) {
      await tx.delete(platformModelDefaults)
    } else {
      const stale = await tx
        .select({ agentGroup: platformModelDefaults.agentGroup })
        .from(platformModelDefaults)
      const drop = stale.map((row) => row.agentGroup).filter((group) => !keep.includes(group))
      if (drop.length > 0) {
        await tx.delete(platformModelDefaults).where(inArray(platformModelDefaults.agentGroup, drop))
      }
    }

    for (const [agentGroup, model] of entries) {
      await tx
        .insert(platformModelDefaults)
        .values({
          agentGroup,
          model,
          modelSnapshot: input.modelSnapshot[agentGroup] ?? null,
          note: input.note,
          updatedBy: input.actorUserId,
          updatedByEmail: input.actorEmail,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: platformModelDefaults.agentGroup,
          set: {
            model,
            modelSnapshot: input.modelSnapshot[agentGroup] ?? null,
            note: input.note,
            updatedBy: input.actorUserId,
            updatedByEmail: input.actorEmail,
            updatedAt: new Date(),
          },
        })
    }

    return tx.select().from(platformModelDefaults).orderBy(asc(platformModelDefaults.agentGroup))
  })

  await invalidatePlatformModelDefaults()
  return rows
}

/** Drop the cached defaults (after a write, or from tests). */
export async function invalidatePlatformModelDefaults(): Promise<void> {
  await invalidateCached(DEFAULTS_CACHE_KEY)
}

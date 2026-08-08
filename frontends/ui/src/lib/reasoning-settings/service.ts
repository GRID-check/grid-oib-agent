/**
 * Platform-controlled reasoning effort per agent group (Platform → Models).
 *
 * How hard a role thinks used to be a build-time fact — `reasoning_effort` in
 * `configs/config_oib_openrouter.yml` — so retuning the cost/quality trade-off
 * meant a commit plus a backend redeploy. It is now a row in
 * `platform_reasoning_efforts`, written by the platform owner, and the backend
 * picks it up through `GET /api/internal/reasoning-efforts` (TTL-cached there,
 * fail-open to the YAML value when the BFF is unreachable or no row exists).
 *
 * Platform-only by design — no org layer. A tenant choosing its own MODEL is a
 * product feature; a tenant dialling its own reasoning spend is not.
 *
 * Cached like the platform model defaults (ADR-0020's shared cache when
 * `REDIS_URL` is set, per-process otherwise) and write-invalidated, so a save
 * reaches traffic on the next resolution rather than after a TTL.
 */

import 'server-only'
import { asc, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { getCached, invalidateCached } from '@/lib/cache'
import { platformReasoningEfforts, type PlatformReasoningEffort } from '@/lib/db/schema'
import { AGENT_GROUP_IDS } from '@/lib/model-config/agent-groups'
import { isReasoningEffort, type ReasoningEffort } from './catalog'

const EFFORTS_CACHE_TTL_MS = 60 * 1000
const EFFORTS_CACHE_KEY = 'platformreasoningefforts'

/** `{agentGroupId: effort}` — only groups the platform owner has pinned. */
export type PlatformReasoningEfforts = Record<string, ReasoningEffort>

export interface PlatformReasoningEffortInput {
  /** `{agentGroupId: effort}`. Groups absent from the map are cleared. */
  efforts: PlatformReasoningEfforts
  note: string | null
  actorUserId: string
  actorEmail: string | null
}

/**
 * The flat platform efforts, cached and write-invalidated. This is the map the
 * internal endpoint hands the backend; it contains ONLY rows whose group is
 * still in the registry and whose value is still a known effort, so a retired
 * group or a hand-edited row can never reach the backend.
 */
export async function getPlatformReasoningEfforts(): Promise<PlatformReasoningEfforts> {
  return getCached(EFFORTS_CACHE_KEY, EFFORTS_CACHE_TTL_MS, async () => {
    const db = getDb()
    const rows = await db
      .select({
        agentGroup: platformReasoningEfforts.agentGroup,
        effort: platformReasoningEfforts.effort,
      })
      .from(platformReasoningEfforts)
    const flat: PlatformReasoningEfforts = {}
    for (const row of rows) {
      if (AGENT_GROUP_IDS.includes(row.agentGroup) && isReasoningEffort(row.effort)) {
        flat[row.agentGroup] = row.effort
      }
    }
    return flat
  })
}

/** Full rows (effort + who/when) for the platform admin surface. */
export async function listPlatformReasoningEfforts(): Promise<PlatformReasoningEffort[]> {
  const db = getDb()
  return db.select().from(platformReasoningEfforts).orderBy(asc(platformReasoningEfforts.agentGroup))
}

/**
 * Replace the platform efforts with `efforts` — the whole set, not a patch.
 *
 * Groups present are upserted; groups absent are deleted, which returns them to
 * the workflow YAML `reasoning_effort`. One transaction, so a partial write can
 * never leave the fleet split across two thinking levels.
 */
export async function savePlatformReasoningEfforts(
  input: PlatformReasoningEffortInput,
): Promise<PlatformReasoningEffort[]> {
  const db = getDb()
  const entries = Object.entries(input.efforts)
  const keep = entries.map(([agentGroup]) => agentGroup)

  const rows = await db.transaction(async (tx) => {
    // Clear the groups this save drops. `notInArray` with an empty list is not
    // expressible, so the empty case is a plain full delete.
    if (keep.length === 0) {
      await tx.delete(platformReasoningEfforts)
    } else {
      const stale = await tx
        .select({ agentGroup: platformReasoningEfforts.agentGroup })
        .from(platformReasoningEfforts)
      const drop = stale.map((row) => row.agentGroup).filter((group) => !keep.includes(group))
      if (drop.length > 0) {
        await tx
          .delete(platformReasoningEfforts)
          .where(inArray(platformReasoningEfforts.agentGroup, drop))
      }
    }

    for (const [agentGroup, effort] of entries) {
      await tx
        .insert(platformReasoningEfforts)
        .values({
          agentGroup,
          effort,
          note: input.note,
          updatedBy: input.actorUserId,
          updatedByEmail: input.actorEmail,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: platformReasoningEfforts.agentGroup,
          set: {
            effort,
            note: input.note,
            updatedBy: input.actorUserId,
            updatedByEmail: input.actorEmail,
            updatedAt: new Date(),
          },
        })
    }

    return tx
      .select()
      .from(platformReasoningEfforts)
      .orderBy(asc(platformReasoningEfforts.agentGroup))
  })

  await invalidatePlatformReasoningEfforts()
  return rows
}

/** Drop the cached efforts (after a write, or from tests). */
export async function invalidatePlatformReasoningEfforts(): Promise<void> {
  await invalidateCached(EFFORTS_CACHE_KEY)
}

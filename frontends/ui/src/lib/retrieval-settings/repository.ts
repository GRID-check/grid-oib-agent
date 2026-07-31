/**
 * `platform_retrieval_settings` table access — the only module that queries
 * this table. Global (no org scoping): one row per catalog key.
 */

import 'server-only'
import { asc, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { platformRetrievalSettings, type PlatformRetrievalSetting } from '@/lib/db/schema'
import { RETRIEVAL_SETTING_KEYS } from './catalog'

/**
 * Bound for every list query here. The table holds at most one row per catalog
 * key, so this is generous headroom rather than a real ceiling — it exists so a
 * bypassed validation path cannot turn a select into an unbounded scan, and it
 * stays above the catalog size on purpose so stale rows for retired keys are
 * still seen (and deleted) by the write path.
 */
const MAX_SETTING_ROWS = RETRIEVAL_SETTING_KEYS.length * 4

export async function listPlatformRetrievalSettingRows(): Promise<PlatformRetrievalSetting[]> {
  const db = getDb()
  return db
    .select()
    .from(platformRetrievalSettings)
    .orderBy(asc(platformRetrievalSettings.key))
    .limit(MAX_SETTING_ROWS)
}

export interface PlatformRetrievalSettingsWriteInput {
  /** `{key: value}` — the whole set; keys absent from the map are deleted. */
  settings: Record<string, number>
  note: string | null
  actorUserId: string
  actorEmail: string | null
}

/**
 * Replace the platform retrieval settings with `settings` — the whole set,
 * not a patch. One transaction, so a partial write can never leave half the
 * fleet on new counts and half on old.
 */
export async function replacePlatformRetrievalSettings(
  input: PlatformRetrievalSettingsWriteInput
): Promise<PlatformRetrievalSetting[]> {
  const db = getDb()
  const entries = Object.entries(input.settings)
  const keep = entries.map(([key]) => key)

  return db.transaction(async (tx) => {
    const stored = await tx
      .select({ key: platformRetrievalSettings.key, value: platformRetrievalSettings.value })
      .from(platformRetrievalSettings)
      .limit(MAX_SETTING_ROWS)

    const drop = stored.map((row) => row.key).filter((key) => !keep.includes(key))
    if (drop.length > 0) {
      await tx.delete(platformRetrievalSettings).where(inArray(platformRetrievalSettings.key, drop))
    }

    const storedValues = new Map(stored.map((row) => [row.key, row.value]))
    for (const [key, value] of entries) {
      // The form resends every pinned key, so most of them are unchanged. Their
      // note and author describe the save that set them — rewriting those would
      // credit this actor for a value they never touched.
      if (storedValues.get(key) === value) continue
      await tx
        .insert(platformRetrievalSettings)
        .values({
          key,
          value,
          note: input.note,
          updatedBy: input.actorUserId,
          updatedByEmail: input.actorEmail,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: platformRetrievalSettings.key,
          set: {
            value,
            note: input.note,
            updatedBy: input.actorUserId,
            updatedByEmail: input.actorEmail,
            updatedAt: new Date(),
          },
        })
    }

    return tx
      .select()
      .from(platformRetrievalSettings)
      .orderBy(asc(platformRetrievalSettings.key))
      .limit(MAX_SETTING_ROWS)
  })
}

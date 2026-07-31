/**
 * `platform_retrieval_settings` table access — the only module that queries
 * this table. Global (no org scoping): one row per catalog key.
 */

import 'server-only'
import { asc, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { platformRetrievalSettings, type PlatformRetrievalSetting } from '@/lib/db/schema'

export async function listPlatformRetrievalSettingRows(): Promise<PlatformRetrievalSetting[]> {
  const db = getDb()
  return db.select().from(platformRetrievalSettings).orderBy(asc(platformRetrievalSettings.key))
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
    if (keep.length === 0) {
      await tx.delete(platformRetrievalSettings)
    } else {
      const stale = await tx.select({ key: platformRetrievalSettings.key }).from(platformRetrievalSettings)
      const drop = stale.map((row) => row.key).filter((key) => !keep.includes(key))
      if (drop.length > 0) {
        await tx.delete(platformRetrievalSettings).where(inArray(platformRetrievalSettings.key, drop))
      }
    }

    for (const [key, value] of entries) {
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

    return tx.select().from(platformRetrievalSettings).orderBy(asc(platformRetrievalSettings.key))
  })
}

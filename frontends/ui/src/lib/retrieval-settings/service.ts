/**
 * Platform-controlled retrieval counts (Platform → Retrieval).
 *
 * The counts every retrieval tool fetches/caps used to be build-time facts —
 * YAML values in `configs/config_oib_openrouter.yml` or Python module
 * constants — so tuning them meant a commit plus a backend redeploy. They are
 * now rows in `platform_retrieval_settings`, written by the platform owner,
 * and the backend picks them up through `GET /api/internal/retrieval-settings`
 * (TTL-cached there, fail-open to the YAML/constant defaults when the BFF is
 * unreachable or a row is absent).
 *
 * Platform-only by design — no org layer: retrieval depth is a fleet-wide
 * quality/cost trade-off, not a tenant preference.
 */

import 'server-only'
import { getCached, invalidateCached } from '@/lib/cache'
import type { PlatformRetrievalSetting } from '@/lib/db/schema'
import { UnprocessableError } from '@/lib/api/errors'
import {
  RETRIEVAL_SETTINGS,
  RETRIEVAL_SETTING_KEYS,
  retrievalSettingDefaults,
  validateRetrievalSettingValue,
} from './catalog'
import { listPlatformRetrievalSettingRows, replacePlatformRetrievalSettings } from './repository'

const SETTINGS_CACHE_TTL_MS = 60 * 1000
const SETTINGS_CACHE_KEY = 'platformretrievalsettings'

/** `{key: value}` — only keys the platform owner has pinned. */
export type PlatformRetrievalSettings = Record<string, number>

/**
 * The flat platform overrides, cached and write-invalidated. This is the map
 * the internal endpoint hands to the backend; it contains ONLY rows whose key
 * is still in the catalog (a retired key stays in the table until the next
 * save but can never reach the backend).
 */
export async function getPlatformRetrievalSettings(): Promise<PlatformRetrievalSettings> {
  return getCached(SETTINGS_CACHE_KEY, SETTINGS_CACHE_TTL_MS, async () => {
    const rows = await listPlatformRetrievalSettingRows()
    const flat: PlatformRetrievalSettings = {}
    for (const row of rows) {
      if (RETRIEVAL_SETTING_KEYS.includes(row.key)) flat[row.key] = row.value
    }
    return flat
  })
}

/**
 * Effective value per catalog key for the admin form: the pinned row where one
 * exists, the boot default otherwise, plus who/when for pinned keys.
 */
export interface PlatformRetrievalSettingView {
  key: string
  value: number
  defaultValue: number
  overridden: boolean
  note: string | null
  updatedByEmail: string | null
  updatedAt: Date | null
}

export async function listPlatformRetrievalSettings(): Promise<PlatformRetrievalSettingView[]> {
  const defaults = retrievalSettingDefaults()
  const rows = await listPlatformRetrievalSettingRows()
  const byKey = new Map(rows.map((row) => [row.key, row]))
  return RETRIEVAL_SETTINGS.map((definition) => {
    const row = byKey.get(definition.key)
    return {
      key: definition.key,
      value: row?.value ?? defaults[definition.key],
      defaultValue: definition.defaultValue,
      overridden: row !== undefined,
      note: row?.note ?? null,
      updatedByEmail: row?.updatedByEmail ?? null,
      updatedAt: row?.updatedAt ?? null,
    }
  })
}

export interface SavePlatformRetrievalSettingsInput {
  /** `{key: value}` — the whole set; keys absent are returned to their default. */
  settings: Record<string, number>
  note: string | null
  actorUserId: string
  actorEmail: string | null
}

/**
 * Validate and persist the whole set. Values equal to the boot default are
 * stored like any other (an explicit pin), but keys outside the catalog or
 * values outside the catalog bounds are rejected before any write.
 */
export async function savePlatformRetrievalSettings(
  input: SavePlatformRetrievalSettingsInput
): Promise<PlatformRetrievalSetting[]> {
  const errors: string[] = []
  for (const [key, value] of Object.entries(input.settings)) {
    if (typeof value !== 'number') {
      errors.push(`${key}: Zahl erforderlich`)
      continue
    }
    const error = validateRetrievalSettingValue(key, value)
    if (error) errors.push(error)
  }
  if (errors.length > 0) {
    throw new UnprocessableError('Ungültige Abruf-Einstellungen', { errors })
  }

  const rows = await replacePlatformRetrievalSettings(input)
  await invalidateCached(SETTINGS_CACHE_KEY)
  return rows
}

/** Drop the cached settings (after a write, or from tests). */
export async function invalidatePlatformRetrievalSettings(): Promise<void> {
  await invalidateCached(SETTINGS_CACHE_KEY)
}

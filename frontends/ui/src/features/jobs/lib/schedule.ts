/**
 * Schedule helpers for the job builder and the job list.
 *
 * The BFF validates and parses cron authoritatively (5-field, `cron-parser`,
 * per-job IANA timezone, min-interval). These helpers only power the UI:
 * a small set of common presets, a lightweight client-side shape check that
 * gives instant feedback before the server round-trip, and a humanizer for the
 * list's schedule summary. Anything the client cannot know for sure (real
 * next-occurrence, min-interval) is left to the server.
 */

/** Preset identifiers offered in the job builder's schedule section. */
export type SchedulePreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

/** The cron expression each non-custom preset maps to (5-field). */
export const PRESET_CRON: Record<Exclude<SchedulePreset, 'custom'>, string> = {
  hourly: '0 * * * *',
  daily: '0 6 * * *',
  weekly: '0 6 * * 1',
  monthly: '0 6 1 * *',
}

export const SCHEDULE_PRESETS: SchedulePreset[] = ['hourly', 'daily', 'weekly', 'monthly', 'custom']

/** Which preset (if any) a cron string corresponds to, else `custom`. */
export function presetForCron(cron: string | null | undefined): SchedulePreset {
  if (!cron) return 'daily'
  const normalized = cron.trim().replace(/\s+/g, ' ')
  for (const [preset, presetCron] of Object.entries(PRESET_CRON)) {
    if (presetCron === normalized) return preset as SchedulePreset
  }
  return 'custom'
}

/**
 * Cheap client-side shape validation: exactly five whitespace-separated fields
 * of allowed cron characters. This is deliberately permissive — it catches
 * obvious typos for instant feedback but defers real parsing/semantics to the
 * server (which returns the authoritative error).
 */
export function isPlausibleCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => /^[0-9*/,\-]+$/.test(field))
}

/** Browser's IANA timezone, falling back to UTC when unavailable. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Full IANA timezone list, falling back to a small common set on old runtimes. */
export function supportedTimezones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (typeof supported === 'function') {
    try {
      return supported('timeZone')
    } catch {
      /* fall through */
    }
  }
  return ['UTC', 'Europe/Vienna', 'Europe/Berlin', 'Europe/London', 'America/New_York']
}

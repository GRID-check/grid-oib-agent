/**
 * What the download log records, and for how long. Pure, and not `server-only`:
 * the admin page and the retention form read the same constants the service
 * and the migration's CHECKs are written from.
 *
 * Why the log exists, and its limits (ADR-0085, "The download log"): it answers
 * "who took this document out, and who opened it in a folder with its own
 * access list". Purpose: security and accountability. It is not an activity
 * report, and nothing here aggregates by person.
 */

/**
 * The routes that hand a document's bytes to a person, one value each.
 *
 * - `download`: the explicit save (`GET /api/documents/[id]/download`).
 * - `preview`: the inline preview URL, an image or a PDF rendition.
 * - `pdf`: the stored PDF, streamed from this origin to the in-app viewer.
 * - `text`: the bounded text preview of a text document.
 * - `version`: one version's bytes, opened from the version list.
 * - `model`: the raw IFC file the 3D viewer parses.
 */
export const DOWNLOAD_LOG_KINDS = ['download', 'preview', 'pdf', 'text', 'version', 'model'] as const
export type DownloadLogKind = (typeof DOWNLOAD_LOG_KINDS)[number]

/**
 * `download` is logged wherever the document is. Everything else is an OPEN: a
 * viewer fetch, logged only when the document sits under a folder with its own
 * access list (product decision, 6 Oct 2026). The migration's CHECK states the
 * same rule, so a code path that logs an open of an ordinary folder is refused
 * by the database.
 */
export function isOpenKind(kind: DownloadLogKind): boolean {
  return kind !== 'download'
}

/** The shelves a logged document can be on; the same names as `documents.scope`. */
export const DOWNLOAD_LOG_SCOPES = ['project', 'archiv', 'session'] as const
export type DownloadLogScope = (typeof DOWNLOAD_LOG_SCOPES)[number]

/** How long entries are kept unless the organization says otherwise: twelve months. */
export const DOWNLOAD_LOG_DEFAULT_RETENTION_DAYS = 365
/** The shortest retention an organization may choose. */
export const DOWNLOAD_LOG_MIN_RETENTION_DAYS = 30
/**
 * The longest retention there is. Not a default an organization can raise: a
 * record of what staff opened is kept as short as its purpose allows, and
 * anything longer is a decision to take explicitly (a new ADR and a migration
 * of this constant, the scheduler's clamp and the user guide), not a field.
 */
export const DOWNLOAD_LOG_MAX_RETENTION_DAYS = 365

/** The `organizations.settings` key holding an organization's own retention, in days. */
export const DOWNLOAD_LOG_RETENTION_SETTING = 'downloadLogRetentionDays'

/** Whether `days` is a retention an organization may set. */
export function isValidRetentionDays(days: unknown): days is number {
  return (
    typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= DOWNLOAD_LOG_MIN_RETENTION_DAYS &&
    days <= DOWNLOAD_LOG_MAX_RETENTION_DAYS
  )
}

/**
 * The retention in force for a stored settings value: the organization's own
 * when it is a valid one, the default for anything else (absent, malformed,
 * out of range). The scheduler's SQL reads the value the same way.
 */
export function retentionDaysFromSettings(settings: Record<string, unknown>): number {
  const value = settings[DOWNLOAD_LOG_RETENTION_SETTING]
  return isValidRetentionDays(value) ? value : DOWNLOAD_LOG_DEFAULT_RETENTION_DAYS
}

/** The page size the admin view gets unless the request names one, and the most it may name. */
export const ACCESS_LOG_DEFAULT_LIMIT = 50
export const ACCESS_LOG_MAX_LIMIT = 100

/**
 * The numbers the Outlook archive import runs on (ADR-0085), in one place so
 * the routes, the job and the client agree.
 */

/** Archives the import accepts. A `.ost` is the same format as a `.pst`, cached from Exchange. */
export const MAIL_ARCHIVE_EXTENSIONS = ['.pst', '.ost'] as const

/**
 * One upload part. The browser sends the archive in parts of exactly this size
 * (the last one shorter), each a request the BFF writes through to S3 as one
 * multipart part. 32 MiB keeps a part well under the request-body ceiling and
 * a twenty-gigabyte archive at 640 parts, far from S3's 10,000.
 */
export const MAIL_IMPORT_PART_BYTES = 32 * 1024 * 1024

/** S3 allows at most this many parts in one multipart upload. */
export const MAX_MULTIPART_PARTS = 10_000

const DEFAULT_MAX_ARCHIVE_BYTES = 25 * 1024 ** 3

/** The largest archive an import takes (`GRID_MAIL_IMPORT_MAX_BYTES`, default 25 GiB). */
export function maxArchiveBytes(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.GRID_MAIL_IMPORT_MAX_BYTES ?? '', 10)
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ARCHIVE_BYTES
  return Math.min(value, MAIL_IMPORT_PART_BYTES * MAX_MULTIPART_PARTS)
}

/** The project root folder every import files under. German: it is the folder a person sees. */
export const MAIL_IMPORT_ROOT_FOLDER = 'E-Mail-Import'

/** Messages one backend request returns. */
export const MAIL_IMPORT_PAGE_SIZE = 20

/**
 * How long one job slice files before it hands back. The runner's request
 * timeout is five minutes; one mail with large attachments can take tens of
 * seconds, so the slice stops starting new mails well before that.
 */
export const MAIL_IMPORT_SLICE_BUDGET_MS = 150_000

/** An upload nobody finished is aborted after this long. */
export const STALE_UPLOAD_HOURS = 48

/** An import whose job is gone is judged after this long without progress. */
export const STALLED_IMPORT_MINUTES = 30

/** Skipped files and items kept by name on the row; the counts are exact regardless. */
export const SKIPPED_SAMPLES_KEPT = 20

/** How long a presigned archive URL handed to the backend lives. */
export const ARCHIVE_URL_TTL_SECONDS = 60 * 60

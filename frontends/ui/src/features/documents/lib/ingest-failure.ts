/**
 * Why a document could not be read, as a category the UI can say in the
 * reader's language.
 *
 * The stored `errorMessage` is written by whichever tier gave up: the knowledge
 * layer (`reason: text`, e.g. `office_rendition_required: …`), the ingest status
 * store (`interrupted: …`), the BFF (`INGEST_DISPATCH_FAILED_MESSAGE`,
 * `RENDITION_REQUIRED_MESSAGE` in `lib/documents/service.ts`) or a provider
 * error passed through verbatim. It is persisted server-side, so it cannot be
 * localized where it is written; it is classified here and the raw text stays
 * available behind a „Details" disclosure.
 *
 * `tests/knowledge_layer_tests/test_ingest_failure_prefix_parity.py` reads
 * {@link INGEST_FAILURE_PREFIXES} and fails when the backend grows a
 * `reason:` prefix this file does not map.
 */

import type { Translator } from '@/i18n/translate'

export type IngestFailureKind =
  | 'rendition_failed'
  | 'download_failed'
  | 'interrupted'
  | 'unreadable_pages'
  | 'vision_not_configured'
  | 'dispatch_failed'
  | 'timeout'
  | 'empty'
  | 'deleted'
  | 'quarantined'
  | 'unknown'

export type IngestFailure =
  | { kind: 'unreadable_pages'; failed: number; total: number; raw: string }
  | { kind: Exclude<IngestFailureKind, 'unreadable_pages'>; raw: string }

/**
 * The backend's machine prefixes (the text before the first `:`), each to its
 * category. Parsed by the Python parity test: keep it one `'prefix': 'kind',`
 * entry per line.
 */
export const INGEST_FAILURE_PREFIXES = {
  office_rendition_required: 'rendition_failed',
  original_download_failed: 'download_failed',
  interrupted: 'interrupted',
  pdf_pages_unreadable: 'unreadable_pages',
  vlm_not_configured: 'vision_not_configured',
  document_deleted: 'deleted',
  quarantined: 'quarantined',
} as const satisfies Record<string, IngestFailureKind>

/**
 * Whole sentences the BFF stores, matched by their start so a later
 * `: detail` suffix still classifies. Mirrors `INGEST_DISPATCH_FAILED_MESSAGE`
 * and `RENDITION_REQUIRED_MESSAGE` in `lib/documents/service.ts`, which is
 * `server-only` and cannot be imported here; `ingest-failure.spec.ts` holds
 * the two in step.
 */
export const BFF_FAILURE_PHRASES = {
  'Ingestion could not be started': 'dispatch_failed',
  'The PDF version of this file could not be created': 'rendition_failed',
} as const satisfies Record<string, IngestFailureKind>

const UNREADABLE_PAGES = /(\d+)\s+of\s+(\d+)\s+pages?/i
const TIMEOUT = /\btimed?[\s_-]?out\b|\btimeout\b/i
const EMPTY = /^no content extracted\b/i

function prefixOf(message: string): string | null {
  const match = /^([a-z][a-z_]*):/.exec(message)
  return match ? match[1] : null
}

type BackendPrefix = keyof typeof INGEST_FAILURE_PREFIXES

function isBackendPrefix(prefix: string): prefix is BackendPrefix {
  return Object.prototype.hasOwnProperty.call(INGEST_FAILURE_PREFIXES, prefix)
}

function fromPrefix(prefix: string, raw: string): IngestFailure | null {
  if (!isBackendPrefix(prefix)) return null
  const kind: IngestFailureKind = INGEST_FAILURE_PREFIXES[prefix]
  if (kind !== 'unreadable_pages') return { kind, raw }
  const counts = UNREADABLE_PAGES.exec(raw)
  // Without both numbers the sentence would say "undefined of undefined".
  if (!counts) return { kind: 'unknown', raw }
  return { kind, failed: Number(counts[1]), total: Number(counts[2]), raw }
}

/** The category of a stored ingest failure; `null` when there is no message. */
export function classifyIngestFailure(errorMessage: string | null | undefined): IngestFailure | null {
  const raw = errorMessage?.trim()
  if (!raw) return null

  const prefix = prefixOf(raw)
  const byPrefix = prefix ? fromPrefix(prefix, raw) : null
  if (byPrefix) return byPrefix

  for (const [phrase, kind] of Object.entries(BFF_FAILURE_PHRASES)) {
    if (raw.startsWith(phrase)) return { kind, raw }
  }
  if (EMPTY.test(raw)) return { kind: 'empty', raw }
  if (TIMEOUT.test(raw)) return { kind: 'timeout', raw }
  return { kind: 'unknown', raw }
}

/**
 * The sentence for a failure, from the `files` namespace. `unknown` says the
 * generic sentence; the raw text is for the „Details" disclosure, not here.
 */
export function ingestFailureSentence(failure: IngestFailure, t: Translator): string {
  if (failure.kind === 'unreadable_pages') {
    return t('ingestFailure.unreadable_pages', { failed: failure.failed, total: failure.total })
  }
  return t(`ingestFailure.${failure.kind}`)
}

/**
 * Whether a tracked file's failure happened while it was being read, not on
 * the way up. Only a file the server accepted has an ingest failure; before
 * that, `errorMessage` is the upload's own and is shown as it is.
 */
export function failedWhileReading(file: { serverFileId?: string | null; jobId?: string | null }): boolean {
  return Boolean(file.serverFileId || file.jobId)
}

/**
 * The upload validator's findings, said in the reader's language.
 *
 * `../validation.ts` is pure and has callers with no dictionary to reach for,
 * so every error there carries an English `message`. That was fine until the
 * message was SPLICED INTO a localized sentence: a German reader ran into
 * «1 Datei wird hochgeladen, 1 übersprungen ("Plan.pdf" is 210 MB, exceeds 100
 * MB limit)» — a German frame around an English clause, on the most ordinary
 * failure the upload surface has.
 *
 * Each error now also carries its parts (`params`, sizes already formatted
 * through the same `formatBytes` a file card renders through), and the words are
 * chosen here. Kept out of the hook because choosing a message from a code is
 * logic, and logic in a hook can only be tested by mounting React.
 */

import type { Translator } from '@/i18n/translate'
import type {
  BatchValidationError,
  BatchValidationResult,
  FileValidationError,
} from '../validation'

/** One file-level rejection, in words. */
function describeFileError(error: FileValidationError, t: Translator): string {
  switch (error.code) {
    case 'DUPLICATE_FILE':
      return t(
        error.reason === 'duplicate-in-batch'
          ? 'errors.validation.duplicateInBatch'
          : 'errors.validation.duplicateExisting',
        error.params
      )
    case 'INVALID_TYPE':
      return t('errors.validation.invalidType', error.params)
    case 'FILE_TOO_LARGE':
      return t('errors.validation.fileTooLarge', error.params)
  }
}

/** One batch-level rejection, in words. */
function describeBatchError(error: BatchValidationError, t: Translator): string {
  // `crowded` is the validator's own fork between "you have no room left" and
  // "this alone is too big", carried across rather than re-derived here.
  const crowded = error.params.crowded === 'yes'
  switch (error.code) {
    case 'TOTAL_SIZE_EXCEEDED':
      return t(
        crowded ? 'errors.validation.totalSizeExceeded' : 'errors.validation.totalSizeExceededFirst',
        error.params
      )
    case 'MAX_FILES_EXCEEDED':
      return t(
        crowded ? 'errors.validation.maxFilesExceeded' : 'errors.validation.maxFilesExceededFirst',
        error.params
      )
  }
}

/**
 * The whole result as one sentence, or `null` when nothing was rejected.
 *
 * Mirrors the shape of the validator's own English summary — one file error
 * named outright, several counted, then the batch-level blockers — so the two
 * stay recognisably the same message.
 */
export function summarizeValidation(result: BatchValidationResult, t: Translator): string | null {
  const parts: string[] = []

  if (result.fileErrors.length === 1) {
    parts.push(describeFileError(result.fileErrors[0], t))
  } else if (result.fileErrors.length > 1) {
    parts.push(t('errors.validation.several', { count: String(result.fileErrors.length) }))
  }

  parts.push(...result.batchErrors.map((error) => describeBatchError(error, t)))

  return parts.length > 0 ? parts.join(' ') : null
}

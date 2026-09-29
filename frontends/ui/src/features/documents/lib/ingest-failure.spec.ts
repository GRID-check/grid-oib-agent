import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from '@/i18n/dictionaries/en'
import { de } from '@/i18n/dictionaries/de'
import { createTranslator } from '@/i18n/translate'
import {
  BFF_FAILURE_PHRASES,
  classifyIngestFailure,
  failedWhileReading,
  INGEST_FAILURE_PREFIXES,
  ingestFailureSentence,
  type IngestFailureKind,
} from './ingest-failure'

/**
 * The stored messages, verbatim from the tiers that write them:
 * `sources/knowledge_layer/src/renditions.py` OFFICE_RENDITION_REQUIRED,
 * `sources/knowledge_layer/src/deferred_files.py` ORIGINAL_DOWNLOAD_FAILED,
 * `src/aiq_agent/knowledge/ingest_status_store.py` INTERRUPTED_MESSAGE,
 * `adapter.py`'s pdf_pages_unreadable format and DOCUMENT_DELETED_DURING_INGEST, `transcription.py`
 * SCAN_NEEDS_VLM and the adapter's image variant. The Python parity test
 * holds the prefixes; these hold the exact sentences.
 */
const BACKEND_MESSAGES: Array<[string, IngestFailureKind]> = [
  [
    'office_rendition_required: Word and presentation files are indexed from their PDF rendition, and none could be read (conversion disabled or failed, or the download failed)',
    'rendition_failed',
  ],
  [
    'original_download_failed: the uploaded file could not be read from storage for indexing (the link expired, the object is gone, or storage was unreachable)',
    'download_failed',
  ],
  ['interrupted: ingestion stopped when the service restarted; retry to index this file', 'interrupted'],
  [
    'vlm_not_configured: scanned PDF pages need a vision model to be transcribed (AIQ_VLM_API_KEY)',
    'vision_not_configured',
  ],
  ['vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY', 'vision_not_configured'],
  ['document_deleted: the document was deleted while it was being ingested', 'deleted'],
  ['No content extracted (file may be password-protected, corrupted, or empty)', 'empty'],
  ['Request timed out after 180s', 'timeout'],
  ['httpx.ReadTimeout: timeout', 'timeout'],
  ['Image could not be decoded or captioned (corrupted file or VLM failure)', 'unknown'],
  ['PDF is encrypted', 'unknown'],
  ['some_new_reason: text nobody mapped yet', 'unknown'],
]

/**
 * The BFF's two constants, read from `lib/documents/service.ts`. That module
 * is `server-only` and pulls the database in, so the spec reads its source
 * rather than importing it; a reworded constant fails here.
 */
function bffConstant(name: string): string {
  const source = readFileSync(path.resolve(__dirname, '../../../lib/documents/service.ts'), 'utf8')
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(source)
  if (!match) throw new Error(`${name} not found in lib/documents/service.ts`)
  return match[1]
}

describe('classifyIngestFailure', () => {
  it.each(BACKEND_MESSAGES)('%s → %s', (message, kind) => {
    expect(classifyIngestFailure(message)).toMatchObject({ kind, raw: message })
  })

  it('reads the page counts out of pdf_pages_unreadable', () => {
    expect(classifyIngestFailure('pdf_pages_unreadable: 7 of 12 pages could not be read')).toEqual({
      kind: 'unreadable_pages',
      failed: 7,
      total: 12,
      raw: 'pdf_pages_unreadable: 7 of 12 pages could not be read',
    })
  })

  it('falls back to unknown when pdf_pages_unreadable has no counts', () => {
    expect(classifyIngestFailure('pdf_pages_unreadable: something else')?.kind).toBe('unknown')
  })

  it.each([
    ['INGEST_DISPATCH_FAILED_MESSAGE', 'dispatch_failed'],
    ['RENDITION_REQUIRED_MESSAGE', 'rendition_failed'],
  ] as const)('classifies the BFF constant %s', (name, kind) => {
    const message = bffConstant(name)
    expect(BFF_FAILURE_PHRASES).toHaveProperty([message], kind)
    expect(classifyIngestFailure(message)?.kind).toBe(kind)
  })

  it('returns null for no message', () => {
    expect(classifyIngestFailure(null)).toBeNull()
    expect(classifyIngestFailure(undefined)).toBeNull()
    expect(classifyIngestFailure('   ')).toBeNull()
  })

  it('only takes a known prefix at the very start', () => {
    expect(classifyIngestFailure('see interrupted: later')?.kind).toBe('unknown')
  })
})

describe('ingestFailureSentence', () => {
  const kinds = new Set<IngestFailureKind>([
    ...Object.values(INGEST_FAILURE_PREFIXES),
    ...Object.values(BFF_FAILURE_PHRASES),
    'timeout',
    'empty',
    'unknown',
  ])

  it.each([
    ['en', en],
    ['de', de],
  ] as const)('has a sentence for every category in %s', (_locale, dictionary) => {
    const t = createTranslator(dictionary, 'files')
    for (const kind of kinds) {
      const failure =
        kind === 'unreadable_pages' ? { kind, failed: 1, total: 2, raw: 'x' } : { kind, raw: 'x' }
      const sentence = ingestFailureSentence(failure, t)
      expect(sentence).not.toContain('ingestFailure.')
      expect(sentence).not.toMatch(/[a-z]+_[a-z_]+:/)
    }
  })

  it('puts the page counts in the sentence', () => {
    const t = createTranslator(de, 'files')
    const failure = classifyIngestFailure('pdf_pages_unreadable: 7 of 12 pages could not be read')
    expect(failure && ingestFailureSentence(failure, t)).toMatch(/^7 von 12 Seiten/)
  })
})

describe('failedWhileReading', () => {
  it('is true once the server holds the file', () => {
    expect(failedWhileReading({ serverFileId: 'doc-1' })).toBe(true)
    expect(failedWhileReading({ jobId: 'job-1' })).toBe(true)
    expect(failedWhileReading({})).toBe(false)
  })
})

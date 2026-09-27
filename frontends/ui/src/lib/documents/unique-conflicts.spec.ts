/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'
import {
  DocumentDeletedError,
  LIVE_NAME_INDEX,
  LiveFilenameTakenError,
  mapDocumentInsertError,
  mapVersionInsertError,
  OPEN_VERSION_INDEX,
  OpenVersionExistsError,
  ReplacedDocumentGoneError,
  retryRacedUpload,
} from './unique-conflicts'

function violation(constraintName: string): Error {
  return new Error('Failed query: …', {
    cause: Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: constraintName }),
  })
}

describe('mapDocumentInsertError', () => {
  it('maps a refusal by the live-name index to a 409 that keeps its cause', () => {
    const original = violation(LIVE_NAME_INDEX)
    const mapped = mapDocumentInsertError(original, 'Grundriss_EG.pdf')

    expect(mapped).toBeInstanceOf(LiveFilenameTakenError)
    expect(mapped).toBeInstanceOf(ConflictError)
    expect(mapped).toMatchObject({ status: 409, code: 'CONFLICT', filename: 'Grundriss_EG.pdf' })
    expect((mapped as Error).cause).toBe(original)
  })

  it('leaves every other 23505 on documents alone', () => {
    // The authored-ref index has its own recovery in `fileGeneratedDocument`,
    // which must see the original error.
    const other = violation('uniq_documents_authored_ref_producer_per_project')
    expect(mapDocumentInsertError(other, 'x')).toBe(other)
  })

  it('leaves a non-unique failure alone', () => {
    const other = new Error('boom')
    expect(mapDocumentInsertError(other, 'x')).toBe(other)
  })
})

describe('mapVersionInsertError', () => {
  it('maps a refusal by the open-version index to a 409', () => {
    const mapped = mapVersionInsertError(violation(OPEN_VERSION_INDEX), 'doc_1')
    expect(mapped).toBeInstanceOf(OpenVersionExistsError)
    expect(mapped).toMatchObject({ status: 409, documentId: 'doc_1' })
  })

  it('leaves a clash on the version number alone — that one is a missing lock, a 500', () => {
    const other = violation('document_versions_document_id_version_number_key')
    expect(mapVersionInsertError(other, 'doc_1')).toBe(other)
  })

  it.each(['document_versions_document_id_fkey', 'document_versions_document_id_project_id_fkey'])(
    'maps a refusal by %s — the document was deleted first — to a 409',
    (constraint) => {
      const original = new Error('Failed query: …', {
        cause: Object.assign(new Error('violates foreign key constraint'), {
          code: '23503',
          constraint_name: constraint,
        }),
      })
      const mapped = mapVersionInsertError(original, 'doc_1')
      expect(mapped).toBeInstanceOf(DocumentDeletedError)
      expect(mapped).toMatchObject({ status: 409, documentId: 'doc_1', details: { reason: 'deleted_during_upload' } })
      expect((mapped as Error).cause).toBe(original)
    },
  )

  it('leaves the published-version index alone', () => {
    const other = violation('uniq_document_versions_published_per_document')
    expect(mapVersionInsertError(other, 'doc_1')).toBe(other)
  })
})

describe('retryRacedUpload', () => {
  it('runs the attempt once more when a concurrent first upload won the name', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new LiveFilenameTakenError('plan.pdf'))
      .mockResolvedValueOnce('as a new version')

    await expect(retryRacedUpload(attempt)).resolves.toBe('as a new version')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('retries only once, and the second loss is a 409', async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new LiveFilenameTakenError('plan.pdf'))

    await expect(retryRacedUpload(attempt)).rejects.toMatchObject({ status: 409 })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('runs the attempt once more when the document a re-upload replaced was deleted', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ReplacedDocumentGoneError('doc_1'))
      .mockResolvedValueOnce('as a first upload')

    await expect(retryRacedUpload(attempt)).resolves.toBe('as a first upload')
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('does not retry a document deleted after the upload wrote it', async () => {
    // In commit order that is "upload, then delete": the file being gone is the
    // delete's outcome, and a retry would re-create what somebody just removed.
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(new DocumentDeletedError('doc_1'))

    await expect(retryRacedUpload(attempt)).rejects.toBeInstanceOf(DocumentDeletedError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('does not retry any other failure', async () => {
    const refusal = new Error('quota')
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(refusal)

    await expect(retryRacedUpload(attempt)).rejects.toBe(refusal)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})

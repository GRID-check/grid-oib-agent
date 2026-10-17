import { describe, expect, it } from 'vitest'
import { XhrNetworkError, XhrUploadError } from '@/lib/http/xhr-upload'
import { mayRetryRefusal, uploadRefusalOf } from './upload-refusal'

const answer = (status: number, body: unknown): XhrUploadError =>
  new XhrUploadError(`HTTP ${status}`, status, typeof body === 'string' ? body : JSON.stringify(body))

describe('uploadRefusalOf', () => {
  it('reads a re-upload onto a held file this person may see, with the held document', () => {
    const refusal = uploadRefusalOf(
      answer(409, { error: 'x', details: { reason: 'quarantined', documentId: 'doc-h', ownUpload: true } })
    )
    expect(refusal).toEqual({ kind: 'held-replace', documentId: 'doc-h', ownUpload: true })
    expect(mayRetryRefusal(refusal)).toBe(false)
  })

  it('reads every taken name alike, and offers no retry', () => {
    const refusal = uploadRefusalOf(answer(409, { error: 'A document named …', details: { reason: 'name_taken' } }))
    expect(refusal).toEqual({ kind: 'name-taken' })
    expect(mayRetryRefusal(refusal)).toBe(false)
  })

  it('reads the server’s name-check stop with its matches', () => {
    expect(
      uploadRefusalOf(
        answer(422, {
          code: 'UPLOAD_SCREENED',
          details: { matches: [{ term: 'Personal', segment: 'Personalakt', kind: 'folder' }] },
        })
      )
    ).toEqual({ kind: 'name-stop', matches: [{ term: 'Personal', segment: 'Personalakt', kind: 'folder' }] })
  })

  it('reads a closed project, a read-only folder and a shelf that changed meanwhile', () => {
    expect(uploadRefusalOf(answer(403, { details: { reason: 'project-closed' } }))).toEqual({ kind: 'project-closed' })
    expect(uploadRefusalOf(answer(403, { details: { reason: 'folder-read-only' } }))).toEqual({ kind: 'folder-read-only' })
    const raced = uploadRefusalOf(answer(409, { details: { reason: 'live_name_taken' } }))
    expect(raced).toEqual({ kind: 'changed-meanwhile' })
    expect(mayRetryRefusal(raced)).toBe(true)
  })

  it('reads the server’s refusal while it cannot read the office’s list, which a retry may get past', () => {
    const refusal = uploadRefusalOf(answer(503, { error: 'could not be read', code: 'UPLOAD_SCREENING_UNAVAILABLE' }))
    expect(refusal).toEqual({ kind: 'screening-unavailable' })
    expect(mayRetryRefusal(refusal)).toBe(true)
  })

  it('never passes on the English of a refusal whose reason it does not know', () => {
    expect(uploadRefusalOf(answer(409, { error: 'Internal words', details: { reason: 'new_reason' } }))).toEqual({
      kind: 'other',
      message: null,
    })
  })

  it('keeps the server’s words only for a refusal without a reason', () => {
    expect(uploadRefusalOf(answer(400, { error: 'File type not allowed' }))).toEqual({
      kind: 'other',
      message: 'File type not allowed',
    })
    expect(uploadRefusalOf(answer(502, '<html>bad gateway</html>'))).toEqual({ kind: 'other', message: null })
  })

  it('is null for anything that is not the server’s answer', () => {
    expect(uploadRefusalOf(new XhrNetworkError('network'))).toBeNull()
    expect(uploadRefusalOf(new Error('boom'))).toBeNull()
    expect(mayRetryRefusal(null)).toBe(true)
  })
})

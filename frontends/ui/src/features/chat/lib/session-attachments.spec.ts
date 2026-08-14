/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  MAX_SESSION_ATTACHMENTS,
  selectSessionAttachments,
  type SessionAttachment,
} from './session-attachments'
import type { TrackedFile } from '@/features/documents/types'

const SESSION = 's_11111111_2222_3333_4444_555555555555'

/** A tracked file with only the fields the selector reads varied. */
function trackedFile(overrides: Partial<TrackedFile> & Pick<TrackedFile, 'fileName'>): TrackedFile {
  return {
    id: `id-${overrides.fileName}-${overrides.status ?? 'success'}`,
    fileSize: 1024,
    status: 'success',
    progress: 100,
    collectionName: SESSION,
    ...overrides,
  }
}

describe('selectSessionAttachments', () => {
  test('maps a fully ingested file to ready', () => {
    const result = selectSessionAttachments([trackedFile({ fileName: 'statik.pdf' })], SESSION)
    expect(result).toEqual<SessionAttachment[]>([{ fileName: 'statik.pdf', state: 'ready' }])
  })

  test('maps an ingesting file to indexing', () => {
    const result = selectSessionAttachments(
      [trackedFile({ fileName: 'plan.pdf', status: 'ingesting' })],
      SESSION
    )
    expect(result).toEqual<SessionAttachment[]>([{ fileName: 'plan.pdf', state: 'indexing' }])
  })

  test('maps a still-uploading file to indexing', () => {
    // The reported flow: a big PDF dropped and asked about immediately, whose
    // bytes have not finished crossing the wire. `messageFiles` excludes this
    // status; the turn signal must not.
    const result = selectSessionAttachments(
      [trackedFile({ fileName: 'gross.pdf', status: 'uploading' })],
      SESSION
    )
    expect(result).toEqual<SessionAttachment[]>([{ fileName: 'gross.pdf', state: 'indexing' }])
  })

  test('drops failed, deleting and canceled files', () => {
    const result = selectSessionAttachments(
      [
        trackedFile({ fileName: 'kaputt.pdf', status: 'failed' }),
        trackedFile({ fileName: 'weg.pdf', status: 'deleting' }),
        trackedFile({ fileName: 'abgebrochen.pdf', status: 'canceled' }),
      ],
      SESSION
    )
    expect(result).toEqual([])
  })

  test('filters out files belonging to another collection', () => {
    const result = selectSessionAttachments(
      [
        trackedFile({ fileName: 'mine.pdf' }),
        trackedFile({ fileName: 'project.pdf', collectionName: 'proj_alpha' }),
        trackedFile({ fileName: 'archiv.pdf', collectionName: 'archiv_org' }),
        trackedFile({ fileName: 'other-session.pdf', collectionName: 's_someone_else' }),
      ],
      SESSION
    )
    expect(result.map((a) => a.fileName)).toEqual(['mine.pdf'])
  })

  test('filters out files with no collection at all', () => {
    const result = selectSessionAttachments(
      [trackedFile({ fileName: 'orphan.pdf', collectionName: undefined })],
      SESSION
    )
    expect(result).toEqual([])
  })

  test('returns an empty list when there is no session id', () => {
    const result = selectSessionAttachments([trackedFile({ fileName: 'statik.pdf' })], undefined)
    expect(result).toEqual([])
  })

  test('deduplicates by file name', () => {
    const result = selectSessionAttachments(
      [
        trackedFile({ fileName: 'dup.pdf', status: 'ingesting' }),
        trackedFile({ fileName: 'dup.pdf', status: 'ingesting' }),
      ],
      SESSION
    )
    expect(result).toEqual<SessionAttachment[]>([{ fileName: 'dup.pdf', state: 'indexing' }])
  })

  test('ready beats indexing for the same file name, in either order', () => {
    // If any copy has finished ingesting the document IS retrievable; claiming
    // `indexing` would make the backend wait for something already there.
    const readyFirst = selectSessionAttachments(
      [
        trackedFile({ fileName: 'dup.pdf', status: 'success' }),
        trackedFile({ fileName: 'dup.pdf', status: 'uploading' }),
      ],
      SESSION
    )
    const indexingFirst = selectSessionAttachments(
      [
        trackedFile({ fileName: 'dup.pdf', status: 'uploading' }),
        trackedFile({ fileName: 'dup.pdf', status: 'success' }),
      ],
      SESSION
    )
    expect(readyFirst).toEqual<SessionAttachment[]>([{ fileName: 'dup.pdf', state: 'ready' }])
    expect(indexingFirst).toEqual(readyFirst)
  })

  test('caps the list at MAX_SESSION_ATTACHMENTS', () => {
    const files = Array.from({ length: MAX_SESSION_ATTACHMENTS + 5 }, (_, i) =>
      trackedFile({ fileName: `doc-${i}.pdf` })
    )
    const result = selectSessionAttachments(files, SESSION)
    expect(result).toHaveLength(MAX_SESSION_ATTACHMENTS)
    expect(result[0].fileName).toBe('doc-0.pdf')
  })

  test('preserves tracked-file order', () => {
    const result = selectSessionAttachments(
      [
        trackedFile({ fileName: 'zzz.pdf' }),
        trackedFile({ fileName: 'aaa.pdf', status: 'ingesting' }),
      ],
      SESSION
    )
    expect(result).toEqual<SessionAttachment[]>([
      { fileName: 'zzz.pdf', state: 'ready' },
      { fileName: 'aaa.pdf', state: 'indexing' },
    ])
  })

  test('ignores a blank file name', () => {
    const result = selectSessionAttachments([trackedFile({ fileName: '   ' })], SESSION)
    expect(result).toEqual([])
  })

  test('returns an empty list when nothing is tracked', () => {
    expect(selectSessionAttachments([], SESSION)).toEqual([])
  })
})

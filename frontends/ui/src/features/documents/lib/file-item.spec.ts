import { describe, expect, it } from 'vitest'
import type { FileItem } from '../components/project-file-workspace'
import { refreshedFileFields } from './file-item'

const file = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc-1',
  filename: 'Plan.pdf',
  displayName: null,
  fileSize: 10,
  contentType: 'application/pdf',
  status: 'completed',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: 'Ein Plan',
  pageCount: 3,
  chunkCount: 9,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
  versionCount: 1,
  ...overrides,
})

describe('refreshedFileFields', () => {
  it('takes a fresher status', () => {
    expect(refreshedFileFields(file({ status: 'processing' }), { status: 'completed' })).toEqual({
      status: 'completed',
    })
  })

  it('never moves a terminal status back to settling on a stale read', () => {
    // The listing drain answered from before the open file's own poll did.
    expect(refreshedFileFields(file({ status: 'completed' }), { status: 'processing' })).toBeNull()
    expect(
      refreshedFileFields(file({ status: 'failed', errorMessage: 'Kaputt' }), {
        status: 'pending',
        errorMessage: null,
      })
    ).toBeNull()
  })

  it('still takes the other fields of a read whose status it holds back', () => {
    expect(
      refreshedFileFields(file({ status: 'completed', tags: null }), { status: 'processing', tags: ['Plan'] })
    ).toEqual({ tags: ['Plan'] })
  })

  it('lets a re-upload back into flight: the version count grew', () => {
    expect(
      refreshedFileFields(file({ status: 'completed', versionCount: 1 }), { status: 'processing', versionCount: 2 })
    ).toEqual({ status: 'processing', versionCount: 2 })
  })

  it('holds back when the version count did not grow', () => {
    expect(
      refreshedFileFields(file({ status: 'completed', versionCount: 2 }), { status: 'processing', versionCount: 2 })
    ).toBeNull()
  })

  it('keeps trailing metadata a read has not caught up with', () => {
    expect(refreshedFileFields(file(), { status: 'completed', summary: null })).toBeNull()
  })
})

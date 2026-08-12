import { describe, test, expect } from 'vitest'
import { defaultDirectionFor, nextSort, sortFiles } from './file-sort'
import type { FileItem } from '../components/project-file-workspace'

const doc = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: overrides.filename ?? 'id',
  filename: 'Plan.pdf',
  displayName: null,
  fileSize: 1_000,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-01T09:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  ...overrides,
})

const names = (files: FileItem[]): string[] => files.map((f) => f.filename)

describe('sortFiles', () => {
  test('orders drawings the way they are numbered, not lexicographically', () => {
    const files = [doc({ filename: 'Plan_10.pdf' }), doc({ filename: 'Plan_2.pdf' }), doc({ filename: 'Plan_1.pdf' })]

    expect(names(sortFiles(files, { key: 'name', direction: 'asc' }, 'de'))).toEqual([
      'Plan_1.pdf',
      'Plan_2.pdf',
      'Plan_10.pdf',
    ])
  })

  test('puts what needs acting on first when sorting by status', () => {
    const files = [
      doc({ filename: 'ready.pdf', status: 'ready' }),
      doc({ filename: 'processing.pdf', status: 'processing' }),
      doc({ filename: 'failed.pdf', status: 'failed' }),
    ]

    expect(names(sortFiles(files, { key: 'status', direction: 'asc' }, 'en'))).toEqual([
      'failed.pdf',
      'processing.pdf',
      'ready.pdf',
    ])
  })

  test('sorts by size and by date, descending being the useful default', () => {
    const files = [
      doc({ filename: 'small.pdf', fileSize: 10, createdAt: '2026-01-01T00:00:00Z' }),
      doc({ filename: 'huge.ifc', fileSize: 150_000_000, createdAt: '2026-05-01T00:00:00Z' }),
    ]

    expect(names(sortFiles(files, { key: 'size', direction: 'desc' }, 'en'))).toEqual(['huge.ifc', 'small.pdf'])
    expect(names(sortFiles(files, { key: 'added', direction: 'desc' }, 'en'))).toEqual(['huge.ifc', 'small.pdf'])
  })

  test('a missing size sorts as zero rather than throwing the order out', () => {
    const files = [doc({ filename: 'known.pdf', fileSize: 5 }), doc({ filename: 'unknown.pdf', fileSize: null })]
    expect(names(sortFiles(files, { key: 'size', direction: 'asc' }, 'en'))).toEqual(['unknown.pdf', 'known.pdf'])
  })

  test('an unparseable date does not corrupt the ordering', () => {
    const files = [doc({ filename: 'bad.pdf', createdAt: 'not-a-date' }), doc({ filename: 'good.pdf' })]
    expect(names(sortFiles(files, { key: 'added', direction: 'desc' }, 'en'))).toEqual(['good.pdf', 'bad.pdf'])
  })

  test('ties break on the filename, so a refresh cannot reshuffle rows', () => {
    const files = [
      doc({ filename: 'b.pdf', fileSize: 100 }),
      doc({ filename: 'a.pdf', fileSize: 100 }),
      doc({ filename: 'c.pdf', fileSize: 100 }),
    ]

    expect(names(sortFiles(files, { key: 'size', direction: 'desc' }, 'en'))).toEqual(['a.pdf', 'b.pdf', 'c.pdf'])
  })

  test('does not mutate the input', () => {
    const files = [doc({ filename: 'b.pdf' }), doc({ filename: 'a.pdf' })]
    sortFiles(files, { key: 'name', direction: 'asc' }, 'en')
    expect(names(files)).toEqual(['b.pdf', 'a.pdf'])
  })
})

describe('nextSort', () => {
  test('a new column takes its own sensible default', () => {
    expect(nextSort({ key: 'name', direction: 'asc' }, 'size')).toEqual({ key: 'size', direction: 'desc' })
    expect(nextSort({ key: 'size', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' })
  })

  test('the same column flips direction', () => {
    expect(nextSort({ key: 'size', direction: 'desc' }, 'size')).toEqual({ key: 'size', direction: 'asc' })
    expect(nextSort({ key: 'size', direction: 'asc' }, 'size')).toEqual({ key: 'size', direction: 'desc' })
  })

  test('names read forwards; everything else reads biggest/newest first', () => {
    expect(defaultDirectionFor('name')).toBe('asc')
    expect(defaultDirectionFor('size')).toBe('desc')
    expect(defaultDirectionFor('added')).toBe('desc')
    expect(defaultDirectionFor('status')).toBe('desc')
  })
})

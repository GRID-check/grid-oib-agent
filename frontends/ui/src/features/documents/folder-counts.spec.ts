import { describe, expect, it } from 'vitest'
import { countDocumentsInFolder, folderTrail } from './folder-counts'
import type { FileItem, FolderItem } from './components/project-file-workspace'

const folders: FolderItem[] = [
  { id: 'plaene', parentId: null, name: 'Pläne', path: '/Pläne' },
  { id: 'einreichung', parentId: 'plaene', name: 'Einreichung', path: '/Pläne/Einreichung' },
  { id: 'detail', parentId: 'einreichung', name: 'Detail', path: '/Pläne/Einreichung/Detail' },
  { id: 'bescheide', parentId: null, name: 'Bescheide', path: '/Bescheide' },
]

function file(id: string, folderId: string | null): FileItem {
  return {
    id,
    filename: `${id}.pdf`,
    displayName: null,
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'ready',
    folderId,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
  }
}

describe('countDocumentsInFolder', () => {
  const files = [
    file('a', 'plaene'),
    file('b', 'einreichung'),
    file('c', 'detail'),
    file('d', 'bescheide'),
    file('loose', null),
  ]

  it('counts a folder’s own documents and everything below it', () => {
    expect(countDocumentsInFolder(files, folders, 'plaene')).toBe(3)
    expect(countDocumentsInFolder(files, folders, 'einreichung')).toBe(2)
    expect(countDocumentsInFolder(files, folders, 'detail')).toBe(1)
  })

  it('does not call a folder empty because its files sit one level down', () => {
    // The tile is the reader's only evidence before they open it. A direct-only
    // count would print "0 Dateien" over a folder full of plans.
    const nested = [file('x', 'detail'), file('y', 'detail')]
    expect(countDocumentsInFolder(nested, folders, 'plaene')).toBe(2)
  })

  it('counts nothing for a folder with nothing in it, and ignores unfiled documents', () => {
    expect(countDocumentsInFolder([file('loose', null)], folders, 'bescheide')).toBe(0)
  })

  it('terminates on a parent cycle instead of hanging the browser', () => {
    // The schema does not permit this; a bad response still could.
    const cyclic: FolderItem[] = [
      { id: 'one', parentId: 'two', name: 'One', path: '/One' },
      { id: 'two', parentId: 'one', name: 'Two', path: '/Two' },
    ]
    expect(countDocumentsInFolder([file('a', 'two')], cyclic, 'one')).toBe(1)
  })
})

describe('folderTrail', () => {
  it('walks from the root down to the folder, outermost first', () => {
    expect(folderTrail(folders, 'detail').map((f) => f.id)).toEqual([
      'plaene',
      'einreichung',
      'detail',
    ])
  })

  it('is empty at the root', () => {
    expect(folderTrail(folders, null)).toEqual([])
  })

  it('yields nothing for a folder that is gone rather than throwing', () => {
    // Another tab can delete the folder this one is standing in.
    expect(folderTrail(folders, 'deleted-elsewhere')).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildFolderUploadPlan,
  countPlan,
  filesToUpload,
  isFolderUpload,
  type FolderUploadPlanInput,
} from './folder-upload-plan'
import type { FileItem, FolderItem } from '../components/project-file-workspace'

/** A `File` carrying the path a folder input would have given it. */
function pathed(relativePath: string, size = 100): File {
  const name = relativePath.split('/').pop()!
  const file = new File(['x'.repeat(size)], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function doc(overrides: Partial<FileItem> & Pick<FileItem, 'id' | 'filename'>): FileItem {
  return {
    displayName: null,
    fileSize: 100,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees: [],
    authoredBy: 'user',
    ...overrides,
  }
}

function folder(id: string, path: string, parentId: string | null = null): FolderItem {
  return { id, parentId, name: path.split('/').pop()!, path }
}

function plan(overrides: Partial<FolderUploadPlanInput> = {}) {
  return buildFolderUploadPlan({
    files: [],
    documents: [],
    folders: [],
    currentFolderId: null,
    ...overrides,
  })
}

describe('isFolderUpload', () => {
  it('is a folder only when a file carries a directory above it', () => {
    expect(isFolderUpload([pathed('Wohnbau/EG.pdf')])).toBe(true)
    expect(isFolderUpload([new File(['x'], 'EG.pdf')])).toBe(false)
  })
})

describe('buildFolderUploadPlan — the folders', () => {
  it('names every directory in the tree, ancestors included', () => {
    const result = plan({
      files: [pathed('Wohnbau/03_Einreichung/Plaene/EG.pdf')],
    })
    expect(result.folders.map((f) => f.path)).toEqual([
      'Wohnbau',
      'Wohnbau/03_Einreichung',
      'Wohnbau/03_Einreichung/Plaene',
    ])
    // Nothing exists yet, so all three are creations.
    expect(result.counts.foldersCreated).toBe(3)
    expect(result.counts.foldersMatched).toBe(0)
  })

  it('matches an existing folder despite case and macOS Unicode form', () => {
    // What a Mac hands over: a decomposed umlaut. It renders identically to the
    // folder that is already here and is a different string.
    const decomposed = 'Pläne'
    const result = plan({
      files: [pathed(`Wohnbau/${decomposed}/EG.pdf`)],
      folders: [folder('f1', 'Wohnbau'), folder('f2', 'Wohnbau/PLÄNE', 'f1')],
    })
    expect(result.folders).toEqual([
      { path: 'Wohnbau', existingId: 'f1' },
      { path: `Wohnbau/${decomposed}`, existingId: 'f2' },
    ])
    expect(result.counts.foldersCreated).toBe(0)
  })

  it('resolves paths relative to the folder the reader is standing in', () => {
    const result = plan({
      files: [pathed('Plaene/EG.pdf')],
      folders: [folder('f1', 'Wohnbau'), folder('f2', 'Wohnbau/Plaene', 'f1')],
      currentFolderId: 'f1',
    })
    expect(result.folders).toEqual([{ path: 'Plaene', existingId: 'f2' }])
  })

  it('folds the drop root into the folder of the same name — the re-sync case', () => {
    const result = plan({
      files: [pathed('Wohnbau/Plaene/EG.pdf')],
      folders: [folder('f1', 'Wohnbau'), folder('f2', 'Wohnbau/Plaene', 'f1')],
      currentFolderId: 'f1',
    })
    // Without the fold this would be `Wohnbau/Wohnbau/Plaene`, and the next
    // sync would make a third level.
    expect(result.mergedIntoCurrentFolder).toBe(true)
    expect(result.folders).toEqual([{ path: 'Plaene', existingId: 'f2' }])
    expect(result.files[0].targetPath).toBe('Plaene')
  })

  it('does not fold when the drop has more than one root', () => {
    const result = plan({
      files: [pathed('Wohnbau/EG.pdf'), pathed('Altbau/OG.pdf')],
      folders: [folder('f1', 'Wohnbau')],
      currentFolderId: 'f1',
    })
    expect(result.mergedIntoCurrentFolder).toBe(false)
    expect(result.folders.map((f) => f.path).sort()).toEqual(['Altbau', 'Wohnbau'])
  })
})

describe('buildFolderUploadPlan — what happens to each file', () => {
  it('is new when the project has no document of that name', () => {
    const result = plan({ files: [pathed('Wohnbau/EG.pdf')] })
    expect(result.files[0].action).toBe('new')
    expect(result.counts.uploading).toBe(1)
  })

  it('is an update when a document of that name exists', () => {
    const result = plan({
      files: [pathed('Wohnbau/EG.pdf')],
      documents: [doc({ id: 'd1', filename: 'EG.pdf' })],
    })
    expect(result.files[0]).toMatchObject({ action: 'update', existingId: 'd1' })
  })

  it('matches by filename across the WHOLE project, because the server does', () => {
    // The document sits in a different folder from the one the tree puts it in.
    // Matching per folder would promise a second `EG.pdf`, and the unique index
    // on (organization, collection, filename) would refuse to give one.
    const result = plan({
      files: [pathed('Wohnbau/Plaene/EG.pdf')],
      documents: [doc({ id: 'd1', filename: 'EG.pdf', folderId: 'elsewhere' })],
      folders: [folder('f1', 'Wohnbau'), folder('f2', 'Wohnbau/Plaene', 'f1')],
    })
    expect(result.files[0]).toMatchObject({
      action: 'update',
      existingId: 'd1',
      refiledFromFolderId: 'elsewhere',
    })
    expect(result.counts.refiled).toBe(1)
  })

  it('leaves a machine-authored row alone — a person is not correcting Piloti', () => {
    const result = plan({
      files: [pathed('Wohnbau/Bericht.pdf')],
      documents: [doc({ id: 'd1', filename: 'Bericht.pdf', authoredBy: 'agent' })],
    })
    expect(result.files[0].action).toBe('new')
  })

  it('refuses to pick a winner when one drop carries a filename twice', () => {
    const result = plan({
      files: [pathed('Wohnbau/A/Deckblatt.pdf'), pathed('Wohnbau/B/Deckblatt.pdf')],
    })
    // A project holds one document per filename. Uploading both means one
    // overwriting the other, silently — which is the loss this reports instead.
    expect(result.files.map((f) => f.action)).toEqual(['collision', 'collision'])
    expect(result.counts.uploading).toBe(0)
  })
})

describe('buildFolderUploadPlan — the delta', () => {
  const digestA = `sha256:${'a'.repeat(64)}`
  const digestB = `sha256:${'b'.repeat(64)}`

  it('asks for a digest only where "unchanged" is possible at all', () => {
    const sameNameSameSize = pathed('W/EG.pdf', 100)
    const sameNameOtherSize = pathed('W/OG.pdf', 200)
    const noStoredDigest = pathed('W/DG.pdf', 100)
    const brandNew = pathed('W/New.pdf', 100)

    const result = plan({
      files: [sameNameSameSize, sameNameOtherSize, noStoredDigest, brandNew],
      documents: [
        doc({ id: 'd1', filename: 'EG.pdf', fileSize: 100, contentHash: digestA }),
        doc({ id: 'd2', filename: 'OG.pdf', fileSize: 999, contentHash: digestA }),
        doc({ id: 'd3', filename: 'DG.pdf', fileSize: 100, contentHash: null }),
      ],
    })

    // A different size is already an answer; a row with no digest predates the
    // column and cannot say. Neither is worth reading a file into memory for.
    expect(result.hashCandidates).toEqual([sameNameSameSize])
  })

  it('skips a file whose bytes are identical, and sends one whose are not', () => {
    const unchanged = pathed('W/EG.pdf', 100)
    const changed = pathed('W/OG.pdf', 100)
    const input: FolderUploadPlanInput = {
      files: [unchanged, changed],
      documents: [
        doc({ id: 'd1', filename: 'EG.pdf', fileSize: 100, contentHash: digestA }),
        doc({ id: 'd2', filename: 'OG.pdf', fileSize: 100, contentHash: digestA }),
      ],
      folders: [],
      currentFolderId: null,
      digests: new Map([
        [unchanged, digestA],
        [changed, digestB],
      ]),
    }

    const result = buildFolderUploadPlan(input)
    expect(result.files.map((f) => f.action)).toEqual(['unchanged', 'update'])
    expect(result.counts.unchanged).toBe(1)
    expect(filesToUpload(result, true).map((f) => f.file)).toEqual([changed])
  })

  it('treats a digest it could not compute as changed, never as unchanged', () => {
    const unreadable = pathed('W/EG.pdf', 100)
    const result = buildFolderUploadPlan({
      files: [unreadable],
      documents: [doc({ id: 'd1', filename: 'EG.pdf', fileSize: 100, contentHash: digestA })],
      folders: [],
      currentFolderId: null,
      // Hashing ran and this file is absent from the answers — `crypto.subtle`
      // refused it, or it moved since it was picked. "I do not know" must read
      // as changed: the other way silently drops a corrected plan.
      digests: new Map(),
    })
    expect(result.files[0].action).toBe('update')
  })
})

describe('countPlan / filesToUpload', () => {
  it('drops the updates from both the count and the batch when the reader declines them', () => {
    const result = plan({
      files: [pathed('W/New.pdf'), pathed('W/EG.pdf')],
      documents: [doc({ id: 'd1', filename: 'EG.pdf' })],
    })

    expect(countPlan(result.files, result.folders, true).uploading).toBe(2)
    expect(countPlan(result.files, result.folders, false).uploading).toBe(1)
    expect(filesToUpload(result, false).map((f) => f.file.name)).toEqual(['New.pdf'])
  })
})

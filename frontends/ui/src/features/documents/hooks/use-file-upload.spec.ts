import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { en } from '@/i18n/dictionaries/en'

// Use vi.hoisted for mocks that need to be available before vi.mock
const { mockClient, mockDocumentsStoreState, mockOrchestratorFns } = vi.hoisted(() => {
  const state = {
    trackedFiles: [] as unknown[],
    isUploading: false,
    isPolling: false,
    error: null as string | null,
    setCurrentCollection: vi.fn(),
    setCollectionInfo: vi.fn(),
    addTrackedFile: vi.fn(),
    updateTrackedFile: vi.fn(),
    removeTrackedFile: vi.fn(),
    unmarkRecentlyDeleted: vi.fn(),
    removeRecentlyDeletedIds: vi.fn(),
    setUploadProgress: vi.fn(),
    dismissTrackedFiles: vi.fn(),
    setUploading: vi.fn(),
    setError: vi.fn(),
    clearError: vi.fn(),
  }

  // The hook reads useDocumentsStore.getState().trackedFiles after upload to
  // group files by jobId for the orchestrator, so these mocks must actually
  // mutate the mock state (implementations survive vi.clearAllMocks).
  state.addTrackedFile.mockImplementation((file: unknown) => {
    state.trackedFiles = [...state.trackedFiles, file]
  })
  state.updateTrackedFile.mockImplementation((id: unknown, updates: unknown) => {
    state.trackedFiles = state.trackedFiles.map((f) =>
      (f as { id?: unknown }).id === id ? { ...(f as object), ...(updates as object) } : f
    )
  })
  state.setUploadProgress.mockImplementation((id: unknown, bytesUploaded: number) => {
    state.trackedFiles = state.trackedFiles.map((f) =>
      (f as { id?: unknown }).id === id ? { ...(f as object), bytesUploaded } : f
    )
  })

  return {
    mockClient: {
      getCollection: vi.fn(),
      createCollection: vi.fn(),
      deleteFiles: vi.fn(),
      listFiles: vi.fn(),
    },
    mockDocumentsStoreState: state,
    mockOrchestratorFns: {
      setAuthToken: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      handleSessionChange: vi.fn(),
      loadFilesForSession: vi.fn(),
      enqueueJobs: vi.fn(),
      watchDocuments: vi.fn(),
      pollSessionDocuments: vi.fn(),
      stopPolling: vi.fn(),
    },
  }
})

// Mock modules
vi.mock('@/adapters/api', () => ({
  createDocumentsClient: () => mockClient,
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ idToken: 'test-token' }),
}))

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

vi.mock('../store', () => {
  const useDocumentsStore = (selector?: (state: typeof mockDocumentsStoreState) => unknown) =>
    selector ? selector(mockDocumentsStoreState) : mockDocumentsStoreState
  useDocumentsStore.getState = () => mockDocumentsStoreState
  return { useDocumentsStore }
})

vi.mock('@/features/chat', () => {
  const mockChatState = { addFileUploadStatusCard: vi.fn() }
  const useChatStore = (selector: (state: typeof mockChatState) => unknown) =>
    selector(mockChatState)
  useChatStore.getState = () => mockChatState
  return { useChatStore }
})

vi.mock('../orchestrator', () => ({
  UploadOrchestrator: mockOrchestratorFns,
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: (selector: (state: { knowledgeLayerAvailable: boolean }) => unknown) =>
    selector({ knowledgeLayerAvailable: true }),
}))

const mockMarkSessionHasCollection = vi.fn()
vi.mock('../persistence', () => ({
  markSessionHasCollection: (...args: unknown[]) => mockMarkSessionHasCollection(...args),
}))

// The office's upload screening (ADR-0086): Piloti's suggested list, read
// without a request, so the gate is exercised and nothing else changes.
vi.mock('@/adapters/api/upload-screening-policy', async () => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return { loadUploadScreeningPolicy: vi.fn().mockResolvedValue(SUGGESTED_SCREENING_POLICY) }
})

vi.mock('../validation', () => ({
  validateFileUpload: vi.fn((files: File[]) => ({
    validFiles: files,
    batchErrors: [],
    fileErrors: [],
    summary: '',
  })),
}))

// Unique per call, like the real thing — the tracked-file id is the key the
// per-file abort handles are stored under, so a mock that returns one constant
// would make every file in a batch share a cancel handle and hide the bug that
// would be. The first id keeps the historical value so single-file assertions
// still read `mock-uuid`.
const uuidState = vi.hoisted(() => ({ count: 0 }))
vi.mock('uuid', () => ({
  v4: () => {
    const index = uuidState.count++
    return index === 0 ? 'mock-uuid' : `mock-uuid-${index}`
  },
}))

import { useFileUpload } from './use-file-upload'
import { installFakeXhr, type FakeXhrHandle } from '@/test-utils/xhr-mock'
import { UPLOAD_CONCURRENCY } from '../lib/upload-queue'

describe('useFileUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uuidState.count = 0
    mockDocumentsStoreState.trackedFiles = []
    mockDocumentsStoreState.isUploading = false
    mockDocumentsStoreState.isPolling = false
    mockDocumentsStoreState.error = null
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initialization', () => {
    test('returns initial state', () => {
      const { result } = renderHook(() => useFileUpload())

      expect(result.current.trackedFiles).toEqual([])
      expect(result.current.isUploading).toBe(false)
      expect(result.current.isPolling).toBe(false)
      expect(result.current.error).toBeNull()
    })

    test('sets auth token on mount', () => {
      renderHook(() => useFileUpload())

      expect(mockOrchestratorFns.setAuthToken).toHaveBeenCalledWith('test-token')
    })

    test('subscribes its callbacks on mount and unsubscribes on unmount', () => {
      const onComplete = vi.fn()
      const onError = vi.fn()
      const unsubscribe = vi.fn()
      mockOrchestratorFns.subscribe.mockReturnValueOnce(unsubscribe)

      const { unmount } = renderHook(() => useFileUpload({ onComplete, onError }))

      expect(mockOrchestratorFns.subscribe).toHaveBeenCalledWith({
        onComplete,
        onError,
      })
      expect(unsubscribe).not.toHaveBeenCalled()
      unmount()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    test('calls handleSessionChange on initial mount with collectionName', () => {
      renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      expect(mockOrchestratorFns.handleSessionChange).toHaveBeenCalledWith('session-1', 'session')
    })

    test('calls handleSessionChange when collectionName changes', () => {
      const { rerender } = renderHook(({ collectionName }) => useFileUpload({ collectionName }), {
        initialProps: { collectionName: 'session-1' },
      })

      mockOrchestratorFns.handleSessionChange.mockClear()

      rerender({ collectionName: 'session-2' })

      expect(mockOrchestratorFns.handleSessionChange).toHaveBeenCalledWith('session-2', 'session')
    })

    test('tells the orchestrator a project collection is read as a corpus', () => {
      renderHook(() => useFileUpload({ collectionName: 'proj-1', projectId: 'p1' }))

      expect(mockOrchestratorFns.handleSessionChange).toHaveBeenCalledWith('proj-1', 'corpus')
    })
  })

  describe('sessionFiles', () => {
    test('filters tracked files by session', () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: '1', fileName: 'file1.pdf', collectionName: 'session-1', fileSize: 1000 },
        { id: '2', fileName: 'file2.pdf', collectionName: 'session-2', fileSize: 2000 },
        { id: '3', fileName: 'file3.pdf', collectionName: 'session-1', fileSize: 3000 },
      ] as unknown[]

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      expect(result.current.sessionFiles).toHaveLength(2)
      expect(result.current.sessionFiles[0].fileName).toBe('file1.pdf')
      expect(result.current.sessionFiles[1].fileName).toBe('file3.pdf')
    })

    test('returns empty array when no session', () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: '1', fileName: 'file1.pdf', collectionName: 'session-1', fileSize: 1000 },
      ] as unknown[]

      const { result } = renderHook(() => useFileUpload())

      expect(result.current.sessionFiles).toHaveLength(0)
    })
  })

  describe('validationContext', () => {
    test('computes validation context from session files', () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: '1', fileName: 'file1.pdf', collectionName: 'session-1', fileSize: 1000 },
        { id: '2', fileName: 'file2.pdf', collectionName: 'session-1', fileSize: 2000 },
      ] as unknown[]

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      expect(result.current.validationContext).toEqual({
        existingTotalSize: 3000,
        existingFileCount: 2,
        existingFileNames: new Set(['file1.pdf', 'file2.pdf']),
        // Chat attachments are session-scoped — the leftover file-count cap
        // still applies. Project / Archiv uploads flip this (see below).
        durableCorpus: false,
      })
    })

    test('marks a project or Archiv upload as a durable corpus', () => {
      const project = renderHook(() =>
        useFileUpload({ collectionName: 'proj-1', projectId: 'proj-1' })
      )
      expect(project.result.current.validationContext.durableCorpus).toBe(true)

      const archiv = renderHook(() =>
        useFileUpload({ collectionName: 'archiv_org-1', archiv: true })
      )
      expect(archiv.result.current.validationContext.durableCorpus).toBe(true)
    })
  })

  describe('uploadFiles', () => {
    test('does nothing when files array is empty', async () => {
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([])
      })

      expect(mockDocumentsStoreState.addTrackedFile).not.toHaveBeenCalled()
    })

    test('sets error when no session ID', async () => {
      const onError = vi.fn()
      const { result } = renderHook(() => useFileUpload({ onError }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
        'Collection name required for upload'
      )
      expect(onError).toHaveBeenCalled()
    })

    test('surfaces the localized VLM reason when an image is rejected for a missing VLM', async () => {
      const { validateFileUpload } = await import('../validation')
      const pngFile = new File(['x'], 'photo.png', { type: 'image/png' })
      // Simulate the validator flagging the image as blocked by a missing VLM.
      vi.mocked(validateFileUpload).mockReturnValueOnce({
        valid: false,
        canUpload: false,
        validFiles: [],
        batchErrors: [],
        fileErrors: [
          {
            file: pngFile,
            code: 'INVALID_TYPE',
            message: 'blocked',
            reason: 'image-vlm-unavailable',
            params: { name: 'photo.png', accepted: '.pdf' },
          },
        ],
        summary: 'blocked',
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([pngFile])
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(en.files.errors.imageVlmUnavailable)
    })
  })

  describe('cancelUpload', () => {
    test('stops orchestrator polling', () => {
      const { result } = renderHook(() => useFileUpload())

      act(() => {
        result.current.cancelUpload()
      })

      expect(mockOrchestratorFns.stopPolling).toHaveBeenCalled()
      expect(mockDocumentsStoreState.setUploading).toHaveBeenCalledWith(false)
    })
  })

  describe('deleteFile', () => {
    test('removes file that has no collection', async () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: 'file-1', fileName: 'test.pdf', collectionName: null, fileSize: 1000 },
      ] as unknown[]

      const { result } = renderHook(() => useFileUpload())

      await act(async () => {
        await result.current.deleteFile('file-1')
      })

      expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('file-1')
      expect(mockClient.deleteFiles).not.toHaveBeenCalled()
    })
  })

  describe('retryFile', () => {
    test('does nothing when file not found', async () => {
      mockDocumentsStoreState.trackedFiles = []

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.retryFile('file-1')
      })

      expect(mockDocumentsStoreState.removeTrackedFile).not.toHaveBeenCalled()
    })

    test('sets error when file has no File object', async () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: 'file-1', fileName: 'test.pdf', collectionName: 'session-1', fileSize: 1000 },
      ] as unknown[]

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.retryFile('file-1')
      })

      // Localized copy resolved via the files dictionary (English fallback
      // when no i18n provider is mounted in the test).
      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
        en.files.errors.cannotRetryServerFile
      )
    })

    test('removes and re-uploads file', async () => {
      const testFile = new File(['test'], 'test.pdf', { type: 'application/pdf' })
      mockDocumentsStoreState.trackedFiles = [
        {
          id: 'file-1',
          fileName: 'test.pdf',
          collectionName: 'session-1',
          fileSize: 1000,
          file: testFile,
        },
      ] as unknown[]

      const xhr = installFakeXhr()
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.retryFile('file-1')
        await Promise.resolve()
      })
      await act(async () => {
        xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: null, status: 'pending' }))
        await pending
      })
      xhr.restore()

      expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('file-1')
      expect(xhr.last().url).toBe('/api/session/documents/upload')
    })

    test('same-tick retries on the session shelf go one file at a time, and none is dropped', async () => {
      const files = ['a.pdf', 'b.pdf'].map((name) => new File(['x'], name, { type: 'application/pdf' }))
      mockDocumentsStoreState.trackedFiles = files.map((file, index) => ({
        id: `file-${index}`,
        fileName: file.name,
        collectionName: 'session-1',
        fileSize: 1,
        file,
      })) as unknown[]

      const xhr = installFakeXhr()
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      let pending!: Promise<void[]>
      await act(async () => {
        // "Retry all" calls retryFile once per failed row in the same tick.
        pending = Promise.all([result.current.retryFile('file-0'), result.current.retryFile('file-1')])
        await Promise.resolve()
      })
      // One request in flight: the second waits for the first, so the pair
      // never meets the session batch cap together.
      await act(async () => {
        await Promise.resolve()
      })
      expect(xhr.requests).toHaveLength(1)
      await act(async () => {
        xhr.requests[0].respond(200, JSON.stringify({ documentId: 'doc-0', jobId: null, status: 'pending' }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => {
        xhr.requests[1].respond(200, JSON.stringify({ documentId: 'doc-1', jobId: null, status: 'pending' }))
        await pending
      })
      xhr.restore()

      expect(xhr.requests).toHaveLength(2)
      expect(xhr.requests.map((request) => (request.body as FormData).get('file'))).toEqual(files)
    })
  })

  describe('clearError', () => {
    test('clears error state', () => {
      const { result } = renderHook(() => useFileUpload())

      act(() => {
        result.current.clearError()
      })

      expect(mockDocumentsStoreState.clearError).toHaveBeenCalled()
    })
  })
})

/**
 * The durable-document path (project corpus and org Archiv).
 *
 * This is where the upload actually happens for a working architect, and it is
 * the code that changed most: a serial `fetch` loop with no progress and no way
 * out became a bounded-concurrency XHR fan-out with per-file bytes, per-file
 * cancellation and per-file failure.
 */
describe('useFileUpload — durable document uploads', () => {
  /** Comfortably past the 64 KB progress-coalescing floor. */
  const FILE_BYTES = 400_000

  let xhr: FakeXhrHandle

  const uploadOk = (documentId: string, jobId: string | null = 'job-1') =>
    JSON.stringify({ documentId, jobId, status: 'pending' })

  const makeFiles = (count: number) =>
    Array.from({ length: count }, (_, i) => new File(['x'.repeat(FILE_BYTES)], `plan-${i}.pdf`, { type: 'application/pdf' }))

  const trackedById = (id: string) =>
    mockDocumentsStoreState.trackedFiles.find((f) => (f as { id?: string }).id === id) as
      | Record<string, unknown>
      | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    uuidState.count = 0
    mockDocumentsStoreState.trackedFiles = []
    mockClient.getCollection.mockResolvedValue({ name: 'proj-collection' })
    xhr = installFakeXhr()
  })

  afterEach(() => {
    xhr.restore()
    vi.clearAllMocks()
  })

  const renderUpload = (options: Record<string, unknown> = {}) =>
    renderHook(() => useFileUpload({ collectionName: 'proj-collection', projectId: 'proj-1', ...options }))

  test('posts each file to the documents endpoint, carrying the target folder', async () => {
    const { result } = renderUpload({ folderId: 'folder-9' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(2))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    expect(xhr.requests).toHaveLength(2)
    expect(xhr.requests[0].url).toBe('/api/documents/upload')
    const body = xhr.requests[0].body as FormData
    expect(body.get('projectId')).toBe('proj-1')
    expect(body.get('folderId')).toBe('folder-9')
  })

  test('does not send a file the office screens out, and says which and why', async () => {
    const { result } = renderUpload()
    const invoice = new File(['x'], 'Schlussrechnung 03.pdf', { type: 'application/pdf' })
    const plan = new File(['x'], 'Grundriss EG.pdf', { type: 'application/pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([invoice, plan])
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    expect(xhr.requests.map((request) => (request.body as FormData).get('file'))).toEqual([plan])
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(expect.stringContaining('Schlussrechnung 03.pdf'))
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(expect.stringContaining('Rechnung'))
  })

  test('screens against the folder a file lands in', async () => {
    const { result } = renderUpload()
    const scan = new File(['x'], '0042.pdf', { type: 'application/pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([scan], { folderPathFor: () => 'Verwaltung/Honorare' })
      await Promise.resolve()
      await Promise.resolve()
    })
    // Answered if it was sent, so a missing gate fails this case and no other.
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    expect(xhr.requests).toHaveLength(0)
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(expect.stringContaining('Honorare'))
  })

  test('sends a file the reader released, and tells the server it was released', async () => {
    const { result } = renderUpload()
    const contract = new File(['x'], 'Architektenvertrag.pdf', { type: 'application/pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([contract], { screeningReleased: (file) => file === contract })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-1'))
      await pending
    })

    expect(xhr.requests).toHaveLength(1)
    expect((xhr.last().body as FormData).get('screeningRelease')).toBe('name')
  })

  test('records where each file went and what the reader released, for a retry to repeat', async () => {
    const { result } = renderUpload({ folderId: 'folder-here' })
    const contract = new File(['x'], 'Architektenvertrag.pdf', { type: 'application/pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([contract], {
        folderIdFor: () => 'folder-vertraege',
        folderPathFor: () => 'Verwaltung/Verträge',
        screeningReleased: (file) => file === contract,
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-1'))
      await pending
    })

    expect(mockDocumentsStoreState.addTrackedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadIntent: { folderId: 'folder-vertraege', folderPath: 'Verwaltung/Verträge', screeningReleased: true },
      })
    )
  })

  test('retries a released file into its own folder, released again, not where the reader stands now', async () => {
    const contract = new File(['x'], 'Architektenvertrag.pdf', { type: 'application/pdf' })
    mockDocumentsStoreState.trackedFiles = [
      {
        id: 'failed-1',
        file: contract,
        fileName: contract.name,
        fileSize: contract.size,
        status: 'failed',
        progress: 0,
        collectionName: 'proj-collection',
        uploadedAt: new Date().toISOString(),
        uploadIntent: { folderId: 'folder-vertraege', folderPath: 'Verwaltung/Verträge', screeningReleased: true },
      },
    ]
    const { result } = renderUpload({ folderId: 'folder-elsewhere' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.retryFile('failed-1')
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-1'))
      await pending
    })

    expect(xhr.requests).toHaveLength(1)
    const body = xhr.last().body as FormData
    expect(body.get('screeningRelease')).toBe('name')
    expect(body.get('folderId')).toBe('folder-vertraege')
  })

  test('carries the server’s „unchanged" answer onto the row, so it is not shown as a new upload', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(
        200,
        JSON.stringify({ documentId: 'doc-1', jobId: null, status: 'uploaded', unchanged: true })
      )
      await pending
    })

    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'success', serverFileId: 'doc-1', unchanged: true })
    )
  })

  test('sends several at once instead of one after another', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(6))
      await Promise.resolve()
    })

    // The whole point of the change: file six is not waiting on file five.
    expect(xhr.requests.length).toBe(UPLOAD_CONCURRENCY)

    await act(async () => {
      // Draining takes as many rounds as the queue has batches.
      for (let round = 0; round < 3; round += 1) {
        xhr.requests.filter((r) => r.status === 0).forEach((r, i) => r.respond(200, uploadOk(`doc-${round}-${i}`)))
        await Promise.resolve()
        await Promise.resolve()
      }
      await pending
    })

    expect(xhr.requests).toHaveLength(6)
  })

  test('records the bytes the browser reports, not a stand-in value', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })

    await act(async () => {
      xhr.last().emitProgress(600, 1200)
      xhr.last().respond(200, uploadOk('doc-0'))
      await pending
    })

    // Half the body sent → half the file's 1000 bytes, and the completed
    // upload settles on the file's real size.
    expect(mockDocumentsStoreState.setUploadProgress).toHaveBeenCalledWith('mock-uuid', FILE_BYTES / 2)
    expect(trackedById('mock-uuid')).toMatchObject({ bytesUploaded: FILE_BYTES, status: 'ingesting' })
  })

  test('marks a file as uploading only once it has a slot', async () => {
    const { result } = renderUpload()

    await act(async () => {
      void result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })

    expect(trackedById('mock-uuid')).toMatchObject({ uploadStartedAt: expect.any(Number) })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-0'))
    })
  })

  test('one refused file does not take the batch down with it', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(3))
      await Promise.resolve()
    })

    await act(async () => {
      xhr.requests[0].respond(413, JSON.stringify({ error: 'File too large' }))
      xhr.requests[1].respond(200, uploadOk('doc-1'))
      xhr.requests[2].respond(200, uploadOk('doc-2'))
      await pending
    })

    // Every file was attempted, and the reason lands on the row that owns it.
    expect(xhr.requests).toHaveLength(3)
    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed', errorMessage: 'File too large' })
    )
    // …and the accepted files are still handed to the poller.
    expect(mockOrchestratorFns.enqueueJobs).toHaveBeenCalled()
  })

  test('a rate-limited file waits out Retry-After and goes again instead of failing', async () => {
    vi.useFakeTimers()
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(429, JSON.stringify({ error: 'Too many requests' }), { 'Retry-After': '2' })
      await vi.advanceTimersByTimeAsync(2_000)
    })
    await act(async () => {
      xhr.requests[1].respond(200, uploadOk('doc-1'))
      await pending
    })
    vi.useRealTimers()

    expect(xhr.requests).toHaveLength(2)
    expect(mockDocumentsStoreState.updateTrackedFile).not.toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed' })
    )
  })

  test('cancelling aborts the transfer instead of letting it finish invisibly', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })

    await act(async () => {
      result.current.cancelFile('mock-uuid')
      await pending
    })

    expect(xhr.last().aborted).toBe(true)
    // A decision, not a failure — the row must not colour red.
    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith('mock-uuid', { status: 'canceled' })
    expect(mockDocumentsStoreState.updateTrackedFile).not.toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed' })
    )
  })

  test('cancelling everything aborts every request in flight', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(3))
      await Promise.resolve()
    })

    await act(async () => {
      result.current.cancelUpload()
      await pending
    })

    expect(xhr.requests.every((request) => request.aborted)).toBe(true)
  })

  test('creates the project collection when it does not exist yet', async () => {
    mockClient.getCollection.mockResolvedValue(null)
    mockClient.createCollection.mockResolvedValue({ name: 'proj-collection' })
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-0'))
      await pending
    })

    expect(mockClient.getCollection).toHaveBeenCalledWith('proj-collection')
    expect(mockClient.createCollection).toHaveBeenCalledWith(
      'proj-collection',
      'Documents for session proj-collection'
    )
  })

  /**
   * The project delete used to go through the proxy's chunk-only file delete,
   * which takes FILENAMES. A durable upload's tracked row carries the document
   * id, so the delete named a file that does not exist and removed nothing:
   * the row, the object and the chunks all stayed, and the file came back on
   * the next listing.
   */
  test('deletes a project document through the first-party route, by document id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetchMock)
    mockDocumentsStoreState.trackedFiles = [
      { id: 'row-1', fileName: 'plan.pdf', collectionName: 'proj-collection', fileSize: 10, serverFileId: 'doc-1' },
    ] as unknown[]
    const { result } = renderUpload()

    await act(async () => {
      await result.current.deleteFile('row-1')
    })
    vi.unstubAllGlobals()

    expect(fetchMock).toHaveBeenCalledWith('/api/documents/doc-1', { method: 'DELETE' })
    expect(mockClient.deleteFiles).not.toHaveBeenCalled()
  })

  test('the Archiv posts to its own endpoint and never names a project', async () => {
    const { result } = renderHook(() =>
      useFileUpload({ collectionName: 'archiv_org-1', archiv: true })
    )

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-0'))
      await pending
    })

    expect(xhr.last().url).toBe('/api/archiv/documents/upload')
    expect((xhr.last().body as FormData).get('projectId')).toBeNull()
  })

  test('the Archiv files into the folder the reader stands in, and records where a tree came from', async () => {
    const { result } = renderHook(() =>
      useFileUpload({ collectionName: 'archiv_org-1', archiv: true, folderId: 'folder-3' })
    )
    const [file] = makeFiles(1)
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Planung/EG/plan-0.pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([file])
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-0'))
      await pending
    })

    const body = xhr.last().body as FormData
    expect(body.get('folderId')).toBe('folder-3')
    expect(body.get('originPath')).toBe('Planung/EG/plan-0.pdf')
    expect(body.get('projectId')).toBeNull()
  })

  test('a folder upload files each Archiv document into its own folder', async () => {
    const { result } = renderHook(() =>
      useFileUpload({ collectionName: 'archiv_org-1', archiv: true, folderId: 'folder-3' })
    )
    const files = makeFiles(2)

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(files, {
        folderIdFor: (file) => (file === files[0] ? 'folder-a' : null),
      })
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    expect((xhr.requests[0].body as FormData).get('folderId')).toBe('folder-a')
    // `null` is a deliberate „the root", not „defer to the batch's folder".
    expect((xhr.requests[1].body as FormData).get('folderId')).toBeNull()
  })
})

/**
 * Chat attachments (ADR-0047 Phase 2). They used to go straight at the ingestor
 * through the `/api/v1` proxy, in one multipart request, and so skipped the
 * file-type gate, the storage quota and the document row. They now take the
 * same per-file path as the other shelves, to `/api/session/documents/upload`,
 * and are listed, polled and deleted through `/api/session/documents`.
 */
describe('useFileUpload — chat attachments', () => {
  const CHAT = 's_11111111_2222_4333_8444_555555555555'
  let xhr: FakeXhrHandle
  let fetchMock: ReturnType<typeof vi.fn>

  const makeFile = () => new File(['x'.repeat(1000)], 'plan.pdf', { type: 'application/pdf' })

  beforeEach(() => {
    vi.clearAllMocks()
    uuidState.count = 0
    mockDocumentsStoreState.trackedFiles = []
    xhr = installFakeXhr()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    xhr.restore()
    vi.unstubAllGlobals()
  })

  const renderChat = () =>
    renderHook(() => useFileUpload({ collectionName: CHAT, conversationProjectId: 'proj-7' }))

  async function upload(result: ReturnType<typeof renderChat>['result'], respond: () => void) {
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([makeFile()])
      await Promise.resolve()
    })
    await act(async () => {
      respond()
      await pending
    })
  }

  test('posts each file to the session upload route, naming the chat and its project', async () => {
    const { result } = renderChat()

    await upload(result, () =>
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
    )

    expect(xhr.requests).toHaveLength(1)
    expect(xhr.last().url).toBe('/api/session/documents/upload')
    const body = xhr.last().body as FormData
    expect(body.get('conversationId')).toBe(CHAT)
    expect(body.get('projectId')).toBe('proj-7')
    expect(body.get('file')).toBeInstanceOf(File)
  })

  test('never touches the proxy: no collection lookup, no collection create', async () => {
    const { result } = renderChat()

    await upload(result, () =>
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
    )

    expect(mockClient.getCollection).not.toHaveBeenCalled()
    expect(mockClient.createCollection).not.toHaveBeenCalled()
    expect(xhr.requests.some((request) => request.url.includes('/api/v1/'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    // The marker that tells a later visit to list this chat's attachments.
    expect(mockMarkSessionHasCollection).toHaveBeenCalledWith(CHAT)
  })

  test('files the row under its document id and polls the chat by re-listing it', async () => {
    const { result } = renderChat()

    await upload(result, () =>
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
    )

    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'ingesting', serverFileId: 'doc-1' })
    )
    expect(mockOrchestratorFns.pollSessionDocuments).toHaveBeenCalledWith(CHAT)
    // Not the proxy's job-status poll.
    expect(mockOrchestratorFns.enqueueJobs).not.toHaveBeenCalled()
  })

  test('shows the server’s refusal (type gate, quota) on the row that was refused', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useFileUpload({ collectionName: CHAT, onError }))

    await upload(result, () =>
      xhr.last().respond(413, JSON.stringify({ error: 'Storage quota exceeded' }))
    )

    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed', errorMessage: 'Storage quota exceeded' })
    )
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith('Storage quota exceeded')
    expect(onError).toHaveBeenCalled()
    expect(mockOrchestratorFns.pollSessionDocuments).not.toHaveBeenCalled()
  })

  test('a cancel is not a failure', async () => {
    const onError = vi.fn()
    const { result } = renderHook(() => useFileUpload({ collectionName: CHAT, onError }))

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([makeFile()])
      await Promise.resolve()
    })
    await act(async () => {
      result.current.cancelFile('mock-uuid')
      await pending
    })

    expect(onError).not.toHaveBeenCalled()
    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith('mock-uuid', { status: 'canceled' })
  })

  test('deletes an attachment through the session document route, by document id', async () => {
    mockDocumentsStoreState.trackedFiles = [
      { id: 'row-1', fileName: 'plan.pdf', collectionName: CHAT, fileSize: 1000, serverFileId: 'doc-1' },
    ] as unknown[]
    fetchMock.mockResolvedValue({ ok: true, status: 204 })
    const { result } = renderChat()

    await act(async () => {
      await result.current.deleteFile('row-1')
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/session/documents/doc-1', { method: 'DELETE' })
    expect(mockClient.deleteFiles).not.toHaveBeenCalled()
    expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('row-1')
  })

  test('restores the attachment and says why when the delete is refused', async () => {
    const file = { id: 'row-1', fileName: 'plan.pdf', collectionName: CHAT, fileSize: 1000, serverFileId: 'doc-1' }
    mockDocumentsStoreState.trackedFiles = [file] as unknown[]
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'Legal hold' } }),
    })
    const { result } = renderChat()

    await act(async () => {
      await result.current.deleteFile('row-1')
    })

    expect(mockDocumentsStoreState.addTrackedFile).toHaveBeenCalledWith(file)
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith('Legal hold')
  })

  test('a file that never reached the server is only dropped from the list', async () => {
    mockDocumentsStoreState.trackedFiles = [
      { id: 'row-1', fileName: 'plan.pdf', collectionName: CHAT, fileSize: 1000, status: 'failed' },
    ] as unknown[]
    const { result } = renderChat()

    await act(async () => {
      await result.current.deleteFile('row-1')
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('row-1')
  })
})

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
      uploadFiles: vi.fn(),
      deleteFiles: vi.fn(),
      listFiles: vi.fn(),
    },
    mockDocumentsStoreState: state,
    mockOrchestratorFns: {
      setAuthToken: vi.fn(),
      setCallbacks: vi.fn(),
      handleSessionChange: vi.fn(),
      loadFilesForSession: vi.fn(),
      enqueueJobs: vi.fn(),
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

    test('sets callbacks on mount', () => {
      const onComplete = vi.fn()
      const onError = vi.fn()

      renderHook(() => useFileUpload({ onComplete, onError }))

      expect(mockOrchestratorFns.setCallbacks).toHaveBeenCalledWith({
        onComplete,
        onError,
      })
    })

    test('calls handleSessionChange on initial mount with collectionName', () => {
      renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      expect(mockOrchestratorFns.handleSessionChange).toHaveBeenCalledWith('session-1')
    })

    test('calls handleSessionChange when collectionName changes', () => {
      const { rerender } = renderHook(({ collectionName }) => useFileUpload({ collectionName }), {
        initialProps: { collectionName: 'session-1' },
      })

      mockOrchestratorFns.handleSessionChange.mockClear()

      rerender({ collectionName: 'session-2' })

      expect(mockOrchestratorFns.handleSessionChange).toHaveBeenCalledWith('session-2')
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

      expect(mockClient.uploadFiles).not.toHaveBeenCalled()
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

    test('uploads files successfully', async () => {
      mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockResolvedValue({
        job_id: 'job-1',
        file_ids: ['file-id-1'],
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockDocumentsStoreState.setUploading).toHaveBeenCalledWith(true)
      expect(mockClient.uploadFiles).toHaveBeenCalled()
      expect(mockDocumentsStoreState.removeRecentlyDeletedIds).toHaveBeenCalledWith(['file-id-1'])
      expect(mockOrchestratorFns.enqueueJobs).toHaveBeenCalledWith([
        expect.objectContaining({
          jobId: 'job-1',
          collectionName: 'session-1',
          files: [expect.objectContaining({ jobId: 'job-1', fileName: 'test.pdf' })],
        }),
      ])
    })

    test('creates collection if not exists', async () => {
      mockClient.getCollection.mockResolvedValue(null)
      mockClient.createCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockResolvedValue({
        job_id: 'job-1',
        file_ids: ['file-id-1'],
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockClient.createCollection).toHaveBeenCalledWith(
        'session-1',
        'Documents for session session-1'
      )
    })

    test('marks session as having collection after ensureCollectionExists', async () => {
      mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockResolvedValue({
        job_id: 'job-1',
        file_ids: ['file-id-1'],
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockMarkSessionHasCollection).toHaveBeenCalledWith('session-1')
    })

    test('uploads to the configured collectionName', async () => {
      mockClient.getCollection.mockResolvedValue({ name: 'target-collection' })
      mockClient.uploadFiles.mockResolvedValue({
        job_id: 'job-1',
        file_ids: ['file-id-1'],
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'target-collection' }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockClient.getCollection).toHaveBeenCalledWith('target-collection')
    })

    test('handles upload errors', async () => {
      mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockRejectedValue(new Error('Upload failed'))

      const onError = vi.fn()
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1', onError }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith('Upload failed')
      expect(onError).toHaveBeenCalled()
    })

    test('ignores abort errors', async () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockRejectedValue(abortError)

      const onError = vi.fn()
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1', onError }))

      await act(async () => {
        await result.current.uploadFiles([
          new File(['test'], 'test.pdf', { type: 'application/pdf' }),
        ])
      })

      expect(onError).not.toHaveBeenCalled()
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

    test('deletes file from server and removes tracked file', async () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: 'file-1', fileName: 'test.pdf', collectionName: 'session-1', fileSize: 1000 },
      ] as unknown[]
      mockClient.deleteFiles.mockResolvedValue(undefined)

      const { result } = renderHook(() => useFileUpload())

      await act(async () => {
        await result.current.deleteFile('file-1')
      })

      expect(mockClient.deleteFiles).toHaveBeenCalledWith('session-1', ['test.pdf'])
      expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('file-1')
    })

    test('handles delete errors', async () => {
      mockDocumentsStoreState.trackedFiles = [
        { id: 'file-1', fileName: 'test.pdf', collectionName: 'session-1', fileSize: 1000 },
      ] as unknown[]
      mockClient.deleteFiles.mockRejectedValue(new Error('Delete failed'))

      const { result } = renderHook(() => useFileUpload())

      await act(async () => {
        await result.current.deleteFile('file-1')
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith('Delete failed')
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

      mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
      mockClient.uploadFiles.mockResolvedValue({
        job_id: 'job-1',
        file_ids: ['file-id-1'],
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.retryFile('file-1')
      })

      expect(mockDocumentsStoreState.removeTrackedFile).toHaveBeenCalledWith('file-1')
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
})

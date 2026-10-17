import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { en } from '@/i18n/dictionaries/en'
import { capturePosthog } from '@/lib/analytics/posthog'

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

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

const mockRequestReingest = vi.fn()
vi.mock('../lib/reingest-request', () => ({
  requestReingest: (documentId: string) => mockRequestReingest(documentId),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

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
vi.mock('@/adapters/api/upload-screening-policy', async (importOriginal) => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return {
    ...(await importOriginal<typeof import('@/adapters/api/upload-screening-policy')>()),
    loadUploadScreeningPolicy: vi.fn().mockResolvedValue(SUGGESTED_SCREENING_POLICY),
  }
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

  describe('retryFile on a file the server could not read', () => {
    const readFailure = {
      id: 'file-1',
      fileName: 'plan.pdf',
      collectionName: 'proj-1',
      fileSize: 1000,
      status: 'failed',
      serverFileId: 'doc-1',
      errorMessage: 'empty_document: nothing to read',
      file: new File(['x'], 'plan.pdf'),
    }

    test('reads it again instead of sending the bytes again', async () => {
      mockDocumentsStoreState.trackedFiles = [readFailure] as unknown[]
      mockRequestReingest.mockResolvedValueOnce({ kind: 'started', status: 'pending' })
      const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-1', projectId: 'p1' }))

      await act(async () => {
        await result.current.retryFile('file-1')
      })

      expect(mockRequestReingest).toHaveBeenCalledWith('doc-1')
      expect(mockDocumentsStoreState.removeTrackedFile).not.toHaveBeenCalled()
      expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
        'file-1',
        expect.objectContaining({ status: 'ingesting', errorMessage: null })
      )
      expect(mockOrchestratorFns.watchDocuments).toHaveBeenCalledWith(['file-1'])
    })

    test('takes the retry away when the server says the same bytes would fail again', async () => {
      mockDocumentsStoreState.trackedFiles = [readFailure] as unknown[]
      mockRequestReingest.mockResolvedValueOnce({ kind: 'unchanged' })
      const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-1', projectId: 'p1' }))

      await act(async () => {
        await result.current.retryFile('file-1')
      })

      expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith('file-1', { retryable: false })
      expect(mockDocumentsStoreState.removeTrackedFile).not.toHaveBeenCalled()
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

  test('tells PostHog how many files of which types were taken, never their names', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([
        new File(['x'], 'Einreichplan-Haus-Meier.pdf', { type: 'application/pdf' }),
        new File(['x'], 'Statik.docx'),
        new File(['x'], 'Deckblatt.pdf', { type: 'application/pdf' }),
      ])
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    expect(capturePosthog).toHaveBeenCalledTimes(1)
    expect(capturePosthog).toHaveBeenCalledWith('document_uploaded', {
      count: 3,
      types: 'docx,pdf',
      shelf: 'project',
    })
    expect(JSON.stringify(vi.mocked(capturePosthog).mock.calls)).not.toMatch(/Meier|Einreichplan/)
  })

  test('counts only the files the server took', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(2))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0]!.respond(200, uploadOk('doc-0'))
      xhr.requests[1]!.respond(500, JSON.stringify({ error: 'boom' }))
      await pending
    })

    expect(capturePosthog).toHaveBeenCalledWith('document_uploaded', expect.objectContaining({ count: 1 }))
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

  test('sends nothing, not even a clean file, while the office policy cannot be read', async () => {
    const { loadUploadScreeningPolicy, UploadScreeningPolicyUnavailableError } = await import(
      '@/adapters/api/upload-screening-policy'
    )
    vi.mocked(loadUploadScreeningPolicy).mockRejectedValueOnce(new UploadScreeningPolicyUnavailableError())
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderUpload()

    await act(async () => {
      await result.current.uploadFiles([new File(['x'], 'Grundriss EG.pdf', { type: 'application/pdf' })])
    })

    expect(xhr.requests).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockClient.getCollection).not.toHaveBeenCalled()
    expect(mockDocumentsStoreState.trackedFiles).toEqual([])
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(en.files.errors.screeningPolicyUnavailable)
    fetchSpy.mockRestore()
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

  test('sends the document a file is filed as the new Fassung of, and only for that file (ADR-0099)', async () => {
    const { result } = renderUpload()
    const filed = new File(['x'], 'EG_Grundriss_Index_C.pdf', { type: 'application/pdf' })
    const plain = new File(['x'], 'Baubeschreibung.pdf', { type: 'application/pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([filed, plain], { fassungOf: (file) => (file === filed ? 'doc-older' : null) })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests.forEach((request, i) => request.respond(200, uploadOk(`doc-${i}`)))
      await pending
    })

    const bodies = new Map(xhr.requests.map((request) => [(request.body as FormData).get('file'), request.body as FormData]))
    expect(bodies.get(filed)?.get('fassungOf')).toBe('doc-older')
    expect(bodies.get(plain)?.has('fassungOf')).toBe(false)
  })

  test('retries a file into the same Fassung it was filed as', async () => {
    const filed = new File(['x'], 'EG_Grundriss_Index_C.pdf', { type: 'application/pdf' })
    mockDocumentsStoreState.trackedFiles = [
      {
        id: 'failed-1',
        file: filed,
        fileName: filed.name,
        fileSize: filed.size,
        status: 'failed',
        progress: 0,
        collectionName: 'proj-collection',
        uploadedAt: new Date().toISOString(),
        uploadIntent: { folderId: null, folderPath: null, screeningReleased: false, fassungOf: 'doc-older' },
      },
    ]
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.retryFile('failed-1')
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-1'))
      await pending
    })

    expect((xhr.last().body as FormData).get('fassungOf')).toBe('doc-older')
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

  test('a project closed while the tab was open is named in the reader’s language (ADR-0090)', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(
        403,
        JSON.stringify({ error: 'This project is closed and can only be read.', code: 'FORBIDDEN', details: { reason: 'project-closed' } })
      )
      await pending
    })

    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed', errorMessage: en.files.errors.projectClosed })
    )
  })

  test('an upload that ran out of time says so in the dictionary, not in the transport’s English', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].timeOut()
      await pending
    })

    expect(mockDocumentsStoreState.updateTrackedFile).toHaveBeenCalledWith(
      'mock-uuid',
      expect.objectContaining({ status: 'failed', errorMessage: en.files.errors.uploadTimeout })
    )
    expect(en.files.errors.uploadTimeout).not.toMatch(/^Upload failed/)
  })

  test('a file refused because the document it would replace is held is held with it, not failed (ADR-0086)', async () => {
    const onError = vi.fn()
    const { result } = renderUpload({ onError })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(
        409,
        JSON.stringify({
          error: '"plan-0.pdf" is waiting in quarantine.',
          code: 'CONFLICT',
          details: { reason: 'quarantined', documentId: 'doc-held', ownUpload: true },
        })
      )
      await pending
    })

    // Held, in the reader's language, with the held document to ask about, and
    // never as that document (`serverFileId`): removing the row must not delete it.
    const message = en.files.errors.quarantinedReplace.replace('{name}', 'plan-0.pdf')
    expect(trackedById('mock-uuid')).toMatchObject({
      status: 'held',
      errorMessage: message,
      retryable: false,
      replacesHeld: { documentId: 'doc-held', ownUpload: true },
    })
    expect(trackedById('mock-uuid')).not.toHaveProperty('serverFileId')
    expect(message).toMatch(/held back/)
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(message)
    // Not a failure: nothing tells the caller one happened.
    expect(onError).not.toHaveBeenCalled()

    // „Alle wiederholen“ calls retryFile for it: it sends nothing and keeps the row.
    vi.mocked(mockDocumentsStoreState.removeTrackedFile).mockClear()
    const { result: again } = renderUpload()
    await act(async () => {
      await again.current.retryFile('mock-uuid')
    })
    expect(mockDocumentsStoreState.removeTrackedFile).not.toHaveBeenCalled()
    expect(xhr.requests).toHaveLength(1)
  })

  test('a taken name is said in the reader’s language, never the server’s English, and not retried', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(
        409,
        JSON.stringify({
          error: 'A document named "plan-0.pdf" already exists here. Rename the file to upload it.',
          code: 'CONFLICT',
          details: { reason: 'name_taken' },
        })
      )
      await pending
    })

    const message = en.files.errors.nameTaken.replace('{name}', 'plan-0.pdf')
    expect(trackedById('mock-uuid')).toMatchObject({ status: 'failed', errorMessage: message, retryable: false })
    expect(String(trackedById('mock-uuid')?.errorMessage)).not.toMatch(/already exists here/)
    expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(message)
  })

  // A held file the uploader may not see answers exactly as a taken name does
  // (ADR-0086): the row cannot tell the two apart, so neither can the reader.
  test('a hidden held file and an ordinary taken name read the same', async () => {
    const answers = [
      'A document named "plan-0.pdf" already exists here. Rename the file to upload it.',
      'A document named "plan-0.pdf" already exists elsewhere in this project. Rename the file, or upload it where that document is filed.',
    ]
    const said: unknown[] = []
    for (const error of answers) {
      mockDocumentsStoreState.trackedFiles = []
      uuidState.count = 0
      const { result } = renderUpload()
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.uploadFiles(makeFiles(1))
        await Promise.resolve()
      })
      await act(async () => {
        xhr.last().respond(409, JSON.stringify({ error, code: 'CONFLICT', details: { reason: 'name_taken' } }))
        await pending
      })
      const { status, errorMessage, retryable, replacesHeld } = trackedById('mock-uuid') ?? {}
      said.push({ status, errorMessage, retryable, replacesHeld })
    }
    expect(said[0]).toEqual(said[1])
    expect(said[0]).toEqual({
      status: 'failed',
      errorMessage: en.files.errors.nameTaken.replace('{name}', 'plan-0.pdf'),
      retryable: false,
      replacesHeld: undefined,
    })
  })

  test('a refusal with a reason this build does not know is not echoed in the server’s English', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(409, JSON.stringify({ error: 'Some internal English', details: { reason: 'something_new' } }))
      await pending
    })

    expect(trackedById('mock-uuid')).toMatchObject({ status: 'failed', errorMessage: en.files.errors.uploadFailed })
  })

  test('any other conflict stays retryable', async () => {
    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0].respond(409, JSON.stringify({ error: 'A document named "plan-0.pdf" already exists here.' }))
      await pending
    })

    expect(trackedById('mock-uuid')).toMatchObject({ status: 'failed' })
    expect(trackedById('mock-uuid')).not.toHaveProperty('retryable')
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

  // The browser screened the dropped folder's names; the server's repeat must
  // read the same segments, so the path goes along (ADR-0086).
  test('sends a dropped folder’s path along, so the server screens what the browser screened', async () => {
    const { result } = renderChat()
    const file = makeFile()
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Baustelle/Fotos/plan.pdf' })

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([file])
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
      await pending
    })

    expect((xhr.last().body as FormData).get('originPath')).toBe('Baustelle/Fotos/plan.pdf')
  })

  test('never touches the proxy: no collection lookup, no collection create', async () => {
    const { result } = renderChat()

    await upload(result, () =>
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
    )

    expect(mockClient.getCollection).not.toHaveBeenCalled()
    expect(mockClient.createCollection).not.toHaveBeenCalled()
    expect(xhr.requests.some((request) => request.url.includes('/api/v1/'))).toBe(false)
    // The only request besides the upload is the upload's own batch (ADR-0086).
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => !url.startsWith('/api/upload-batches'))).toEqual([])
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

/**
 * ADR-0086: every upload is one batch — opened before the first file, named on
 * each upload, sealed after the last answer — so its uploader can be told when
 * everything was read. The batch records what the screening kept back by term
 * and count only.
 */
describe('useFileUpload — upload batches', () => {
  let xhr: FakeXhrHandle
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    uuidState.count = 0
    mockDocumentsStoreState.trackedFiles = []
    mockClient.getCollection.mockResolvedValue({ name: 'proj-collection' })
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)
    xhr = installFakeXhr()
  })

  afterEach(() => {
    xhr.restore()
    vi.unstubAllGlobals()
  })

  const pdf = (name: string) => new File(['x'], name, { type: 'application/pdf' })

  test('opens a batch, names it on every upload, and seals it with what wrote no row', async () => {
    const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-collection', projectId: 'proj-1' }))
    const files = [pdf('EG.pdf'), pdf('OG.pdf'), pdf('Rechnung 7.pdf')]

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(files, {
        excludedByScreening: [[{ term: 'Personal', segment: 'Personalakten', kind: 'folder' }]],
      })
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0]?.respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
      xhr.requests[1]?.respond(200, JSON.stringify({ documentId: 'doc-2', jobId: null, status: 'uploaded', unchanged: true }))
      await pending
    })

    const [openUrl, openInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(openUrl).toBe('/api/upload-batches')
    const opened = JSON.parse(String(openInit.body)) as Record<string, unknown>
    expect(opened).toMatchObject({ scope: 'project', projectId: 'proj-1', expectedCount: 2 })
    // The dialog's exclusion and the hook's own, by term; no file name.
    expect(opened.excluded).toEqual([
      { term: 'Personal', count: 1 },
      { term: 'Rechnung', count: 1 },
    ])
    expect(JSON.stringify(opened)).not.toContain('Rechnung 7.pdf')

    expect(xhr.requests.map((request) => (request.body as FormData).get('uploadBatchId'))).toEqual([opened.id, opened.id])

    const [sealUrl, sealInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(sealUrl).toBe(`/api/upload-batches/${String(opened.id)}/seal`)
    expect(JSON.parse(String(sealInit.body))).toEqual({ unchanged: 1, failed: 0 })
  })

  test('seals a file held because the document it replaces is held as neither failed nor arrived', async () => {
    const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-collection', projectId: 'proj-1' }))

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([pdf('EG.pdf'), pdf('OG.pdf')])
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0]?.respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
      xhr.requests[1]?.respond(
        409,
        JSON.stringify({ error: 'waiting in quarantine', code: 'CONFLICT', details: { reason: 'quarantined', documentId: 'doc-held', ownUpload: false } })
      )
      await pending
    })

    const [, sealInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(String(sealInit.body))).toEqual({ unchanged: 0, failed: 0 })
  })

  /*
   * The server repeats the name check (ADR-0086). A file it stops is „Nicht
   * hochgeladen“, as a stop of the browser's own check is: no failed row, the
   * name-check sentence on the batch's line, no retry, and counted on the
   * batch by term and count, never by name.
   */
  test('a file the server’s name check stops is not uploaded, not failed, and counted by term', async () => {
    const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-collection', projectId: 'proj-1' }))

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([pdf('EG.pdf'), pdf('scan_0042.pdf')])
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.requests[0]?.respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
      xhr.requests[1]?.respond(
        422,
        JSON.stringify({
          error: 'This file is excluded by the organization’s upload screening',
          code: 'UPLOAD_SCREENED',
          details: { matches: [{ term: 'Personal', segment: 'Personalakten', kind: 'folder' }] },
        })
      )
      await pending
    })

    // Not retried, and no row says it failed.
    expect(xhr.requests).toHaveLength(2)
    expect(mockDocumentsStoreState.dismissTrackedFiles).toHaveBeenCalledWith(['mock-uuid-1'])
    expect(
      mockDocumentsStoreState.trackedFiles.filter((file) => (file as { status?: string }).status === 'failed')
    ).toEqual([])
    // The name-check sentence, naming the file to its own uploader, in their language.
    const said = vi.mocked(mockDocumentsStoreState.setError).mock.calls.at(-1)?.[0]
    expect(said).toContain('scan_0042.pdf')
    expect(said).toContain('not uploaded')
    expect(said).not.toContain('excluded by the organization')

    const [sealUrl, sealInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(sealUrl).toMatch(/\/seal$/)
    const sealed = JSON.parse(String(sealInit.body)) as Record<string, unknown>
    expect(sealed).toEqual({ unchanged: 0, failed: 0, excluded: [{ term: 'Personal', count: 1 }] })
    expect(String(sealInit.body)).not.toContain('scan_0042')
  })

  test('uploads without a batch when it cannot be opened', async () => {
    fetchMock.mockReset().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) })
    const { result } = renderHook(() => useFileUpload({ collectionName: 'proj-collection', projectId: 'proj-1' }))

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles([pdf('EG.pdf')])
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, JSON.stringify({ documentId: 'doc-1', jobId: 'job-1', status: 'pending' }))
      await pending
    })

    expect(xhr.requests).toHaveLength(1)
    expect((xhr.last().body as FormData).get('uploadBatchId')).toBeNull()
    // Nothing to seal.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

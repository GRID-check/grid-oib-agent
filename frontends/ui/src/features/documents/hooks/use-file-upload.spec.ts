import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { en } from '@/i18n/dictionaries/en'
import type { Locale } from '@/i18n'

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

// Only the entry point is stubbed. `summarizeFileErrors` stays real, because
// the hook composes it into the message it shows and a stub would let the two
// halves of that sentence drift apart unnoticed.
vi.mock('../validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../validation')>()),
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
import { localeWrapper } from '@/test-utils/i18n'
import type { FileValidationError, FileValidationVariant } from '../validation'

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
        collectionKind: 'chat-session',
        existingTotalSize: 3000,
        existingFileCount: 2,
        existingFileNames: new Set(['file1.pdf', 'file2.pdf']),
      })
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
            variant: 'unsupported-type',
            message: 'blocked',
            values: { name: 'photo.png', accepted: '.pdf' },
            reason: 'image-vlm-unavailable',
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

    /*
      The batch limits were the last hardcoded English left on this path, in a
      UI that is otherwise localized and whose users are German-speaking. The
      validator emits the code, the variant and the numbers; the sentence comes
      from `files.errors.*`.
    */
    test('renders a batch-limit refusal from the dictionary, not the validator', async () => {
      const { validateFileUpload } = await import('../validation')
      const pdf = new File(['x'], 'neu.pdf', { type: 'application/pdf' })
      vi.mocked(validateFileUpload).mockReturnValueOnce({
        valid: false,
        canUpload: false,
        validFiles: [],
        fileErrors: [],
        batchErrors: [
          {
            code: 'MAX_FILES_EXCEEDED',
            variant: 'batch',
            message: '11 files exceeds the 10 file limit.',
            values: { total: 11, limit: 10 },
          },
        ],
        summary: '11 files exceeds the 10 file limit.',
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([pdf])
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
        '11 files exceed the limit of 10 files per upload.'
      )
    })

    test('the remaining-headroom variant names the space left', async () => {
      const { validateFileUpload } = await import('../validation')
      const pdf = new File(['x'], 'neu.pdf', { type: 'application/pdf' })
      vi.mocked(validateFileUpload).mockReturnValueOnce({
        valid: false,
        canUpload: false,
        validFiles: [],
        fileErrors: [],
        batchErrors: [
          {
            code: 'TOTAL_SIZE_EXCEEDED',
            variant: 'remaining',
            message: 'Total size would be 120 MB. Only 40 MB available (100 MB limit).',
            values: { total: '120 MB', available: '40 MB', limit: '100 MB' },
          },
        ],
        summary: 'Total size would be 120 MB. Only 40 MB available (100 MB limit).',
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([pdf])
      })

      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
        'Total size would be 120 MB. Only 40 MB available (100 MB limit).'
      )
    })

    test('keeps the file-level half of the message beside the localized batch half', async () => {
      const { validateFileUpload } = await import('../validation')
      const pdf = new File(['x'], 'neu.pdf', { type: 'application/pdf' })
      const exe = new File(['x'], 'setup.exe')
      vi.mocked(validateFileUpload).mockReturnValueOnce({
        valid: false,
        canUpload: false,
        validFiles: [],
        fileErrors: [
          {
            file: exe,
            code: 'INVALID_TYPE',
            variant: 'unsupported-type',
            message: '"setup.exe" is not a supported file type.',
            values: { name: 'setup.exe', accepted: '.pdf,.docx,.txt,.md' },
          },
        ],
        batchErrors: [
          {
            code: 'MAX_FILES_EXCEEDED',
            variant: 'batch',
            message: '11 files exceeds the 10 file limit.',
            values: { total: 11, limit: 10 },
          },
        ],
        summary: 'ignored',
      })

      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      await act(async () => {
        await result.current.uploadFiles([pdf, exe])
      })

      // Both halves now come from the dictionary — the file-level one used to be
      // whatever English the validator had put in `message`.
      expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
        '“setup.exe” is not a supported file type. Accepted: .pdf,.docx,.txt,.md ' +
          '11 files exceed the limit of 10 files per upload.'
      )
    })

    /*
      The file-level half was the other half of the same defect: the validator
      emitted English string literals, `summarizeFileErrors` handed them to the
      hook, and `errors.uploadingSkipped` interpolated them into a German
      sentence. These assert the sentence the user actually reads.
    */
    describe('file-level refusals come from the dictionary', () => {
      const refuse = async (
        fileErrors: FileValidationError[],
        options: Parameters<typeof useFileUpload>[0] = { collectionName: 'session-1' },
        locale?: Locale
      ) => {
        const { validateFileUpload } = await import('../validation')
        vi.mocked(validateFileUpload).mockReturnValueOnce({
          valid: false,
          canUpload: false,
          validFiles: [],
          batchErrors: [],
          fileErrors,
          summary: 'the validator’s English fallback, which must not be shown',
        })

        const { result } = renderHook(() => useFileUpload(options), {
          wrapper: locale ? localeWrapper(locale) : undefined,
        })
        await act(async () => {
          await result.current.uploadFiles([new File(['x'], 'egal.pdf')])
        })
        return mockDocumentsStoreState.setError.mock.calls.at(-1)?.[0] as string
      }

      const duplicate = (variant: FileValidationVariant): FileValidationError[] => [
        {
          file: new File(['x'], 'Einreichplan.pdf'),
          code: 'DUPLICATE_FILE',
          variant,
          message: 'english fallback',
          values: { name: 'Einreichplan.pdf' },
        },
      ]

      test('a duplicate inside the batch says so', async () => {
        expect(await refuse(duplicate('duplicate-in-batch'))).toBe(
          '“Einreichplan.pdf” is included more than once.'
        )
      })

      test('a chat session says the file is already attached', async () => {
        expect(await refuse(duplicate('duplicate-in-session'))).toBe(
          '“Einreichplan.pdf” is already attached to this chat.'
        )
      })

      // Issue #432's other half: "already exists in this session" was shown on a
      // project Dateiablage and in the org Archiv, where there is no session.
      test('a project Dateiablage names the project', async () => {
        expect(
          await refuse(duplicate('duplicate-in-collection'), {
            collectionName: 'proj_abc',
            projectId: 'proj-1',
          })
        ).toBe('“Einreichplan.pdf” is already in this project.')
      })

      test('the org Archiv names the Archiv', async () => {
        expect(
          await refuse(duplicate('duplicate-in-collection'), {
            collectionName: 'archiv_org-1',
            archiv: true,
          })
        ).toBe('“Einreichplan.pdf” is already in the Archiv.')
      })

      test('an unsupported type lists what is accepted', async () => {
        const message = await refuse([
          {
            file: new File(['x'], 'setup.exe'),
            code: 'INVALID_TYPE',
            variant: 'unsupported-type',
            message: 'english fallback',
            values: { name: 'setup.exe', accepted: '.pdf,.docx' },
          },
        ])

        expect(message).toBe('“setup.exe” is not a supported file type. Accepted: .pdf,.docx')
      })

      test('an oversized file names both sizes, as the validator formatted them', async () => {
        const message = await refuse([
          {
            file: new File(['x'], 'modell.ifc'),
            code: 'FILE_TOO_LARGE',
            variant: 'too-large',
            message: 'english fallback',
            values: { name: 'modell.ifc', size: '260 MB', limit: '250 MB' },
          },
        ])

        expect(message).toBe('“modell.ifc” is 260 MB, which exceeds the 250 MB limit.')
      })

      test('several at once become a count, not a wall of sentences', async () => {
        const message = await refuse([
          ...duplicate('duplicate-in-batch'),
          {
            file: new File(['x'], 'setup.exe'),
            code: 'INVALID_TYPE',
            variant: 'unsupported-type',
            message: 'english fallback',
            values: { name: 'setup.exe', accepted: '.pdf' },
          },
        ])

        expect(message).toBe('Issues with 2 files')
      })

      // The VLM explanation is about the deployment, not the file, so it still
      // replaces the whole half rather than being buried in a count.
      test('a missing VLM keeps its own explanation even beside other refusals', async () => {
        const message = await refuse([
          ...duplicate('duplicate-in-batch'),
          {
            file: new File(['x'], 'foto.png'),
            code: 'INVALID_TYPE',
            variant: 'unsupported-type',
            message: 'english fallback',
            values: { name: 'foto.png', accepted: '.pdf' },
            reason: 'image-vlm-unavailable',
          },
        ])

        expect(message).toBe(en.files.errors.imageVlmUnavailable)
      })

      test('the skipped-files notice interpolates the localized half, not English', async () => {
        const { validateFileUpload } = await import('../validation')
        const good = new File(['x'], 'gut.pdf')
        vi.mocked(validateFileUpload).mockReturnValueOnce({
          valid: false,
          canUpload: true,
          validFiles: [good],
          batchErrors: [],
          fileErrors: duplicate('duplicate-in-batch'),
          summary: 'the validator’s English fallback, which must not be shown',
        })
        mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
        mockClient.uploadFiles.mockResolvedValue({ job_id: 'job-1', file_ids: ['file-id-1'] })

        const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))
        await act(async () => {
          await result.current.uploadFiles([good])
        })

        expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
          'Uploading 1 file, skipped 1 (“Einreichplan.pdf” is included more than once.)'
        )
      })

      /*
        The whole point. #432 was reported by a German-speaking architect, and
        the mixed-language sentence — an English validator string interpolated
        into `errors.uploadingSkipped` — is what they were reading.
      */
      describe('and read as German when the app does', () => {
        test('each duplicate names the surface it is talking about', async () => {
          expect(await refuse(duplicate('duplicate-in-batch'), undefined, 'de')).toBe(
            '„Einreichplan.pdf“ ist mehrfach ausgewählt.'
          )
          expect(await refuse(duplicate('duplicate-in-session'), undefined, 'de')).toBe(
            '„Einreichplan.pdf“ ist bereits angehängt.'
          )
          expect(
            await refuse(
              duplicate('duplicate-in-collection'),
              { collectionName: 'proj_abc', projectId: 'proj-1' },
              'de'
            )
          ).toBe('„Einreichplan.pdf“ liegt bereits in diesem Projekt.')
          expect(
            await refuse(
              duplicate('duplicate-in-collection'),
              { collectionName: 'archiv_org-1', archiv: true },
              'de'
            )
          ).toBe('„Einreichplan.pdf“ liegt bereits im Archiv.')
        })

        test('an unsupported type and an oversized file', async () => {
          expect(
            await refuse(
              [
                {
                  file: new File(['x'], 'setup.exe'),
                  code: 'INVALID_TYPE',
                  variant: 'unsupported-type',
                  message: 'english fallback',
                  values: { name: 'setup.exe', accepted: '.pdf,.docx' },
                },
              ],
              undefined,
              'de'
            )
          ).toBe('„setup.exe“ ist kein unterstützter Dateityp. Zulässig: .pdf,.docx')

          expect(
            await refuse(
              [
                {
                  file: new File(['x'], 'modell.ifc'),
                  code: 'FILE_TOO_LARGE',
                  variant: 'too-large',
                  message: 'english fallback',
                  values: { name: 'modell.ifc', size: '260 MB', limit: '250 MB' },
                },
              ],
              undefined,
              'de'
            )
          ).toBe('„modell.ifc“ ist 260 MB groß und überschreitet das Limit von 250 MB.')
        })

        test('several at once', async () => {
          expect(
            await refuse(
              [...duplicate('duplicate-in-batch'), ...duplicate('duplicate-in-batch')],
              undefined,
              'de'
            )
          ).toBe('2 Dateien mit Problemen')
        })

        test('the skipped-files notice is German throughout, not half English', async () => {
          const { validateFileUpload } = await import('../validation')
          const good = new File(['x'], 'gut.pdf')
          vi.mocked(validateFileUpload).mockReturnValueOnce({
            valid: false,
            canUpload: true,
            validFiles: [good],
            batchErrors: [],
            fileErrors: duplicate('duplicate-in-batch'),
            summary: '"Einreichplan.pdf" is included multiple times',
          })
          mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
          mockClient.uploadFiles.mockResolvedValue({ job_id: 'job-1', file_ids: ['file-id-1'] })

          const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }), {
            wrapper: localeWrapper('de'),
          })
          await act(async () => {
            await result.current.uploadFiles([good])
          })

          // "Es wird", not "Es werden": one file is being uploaded.
          expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
            'Es wird 1 Datei hochgeladen, 1 übersprungen ' +
              '(„Einreichplan.pdf“ ist mehrfach ausgewählt.)'
          )
        })

        test('…and conjugates for more than one', async () => {
          const { validateFileUpload } = await import('../validation')
          const good = [new File(['x'], 'a.pdf'), new File(['x'], 'b.pdf')]
          vi.mocked(validateFileUpload).mockReturnValueOnce({
            valid: false,
            canUpload: true,
            validFiles: good,
            batchErrors: [],
            fileErrors: duplicate('duplicate-in-batch'),
            summary: 'english fallback',
          })
          mockClient.getCollection.mockResolvedValue({ name: 'session-1' })
          mockClient.uploadFiles.mockResolvedValue({
            job_id: 'job-1',
            file_ids: ['file-id-1', 'file-id-2'],
          })

          const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }), {
            wrapper: localeWrapper('de'),
          })
          await act(async () => {
            await result.current.uploadFiles(good)
          })

          expect(mockDocumentsStoreState.setError).toHaveBeenCalledWith(
            'Es werden 2 Dateien hochgeladen, 1 übersprungen ' +
              '(„Einreichplan.pdf“ ist mehrfach ausgewählt.)'
          )
        })
      })
    })

    /*
      495da2e moved this sentence into the dictionary and introduced "Only 1
      more are allowed" with it. This i18n has no ICU, so the count picks the
      key — the same way `permissionCountOne` does in the organization namespace.
    */
    describe('the remaining-files limit agrees with its count', () => {
      const refuseBatch = async (available: number, locale?: Locale) => {
        const { validateFileUpload } = await import('../validation')
        vi.mocked(validateFileUpload).mockReturnValueOnce({
          valid: false,
          canUpload: false,
          validFiles: [],
          fileErrors: [],
          batchErrors: [
            {
              code: 'MAX_FILES_EXCEEDED',
              variant: 'remaining',
              message: 'english fallback',
              values: { total: 12, available, limit: 10 },
            },
          ],
          summary: 'english fallback',
        })

        const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }), {
          wrapper: locale ? localeWrapper(locale) : undefined,
        })
        await act(async () => {
          await result.current.uploadFiles([new File(['x'], 'egal.pdf')])
        })
        return mockDocumentsStoreState.setError.mock.calls.at(-1)?.[0] as string
      }

      test('one slot left, in both languages', async () => {
        expect(await refuseBatch(1)).toBe(
          'That would be 12 files. Only one more is allowed (10 max).'
        )
        expect(await refuseBatch(1, 'de')).toBe(
          'Damit wären es 12 Dateien. Es ist nur noch eine weitere erlaubt (maximal 10).'
        )
      })

      test('more than one, in both languages', async () => {
        expect(await refuseBatch(3)).toBe(
          'That would be 12 files. Only 3 more are allowed (10 max).'
        )
        expect(await refuseBatch(3, 'de')).toBe(
          'Damit wären es 12 Dateien. Es sind nur noch 3 weitere erlaubt (maximal 10).'
        )
      })

      // Zero is plural in both languages, so it keeps the general sentence.
      test('none left keeps the plural', async () => {
        expect(await refuseBatch(0)).toBe(
          'That would be 12 files. Only 0 more are allowed (10 max).'
        )
        expect(await refuseBatch(0, 'de')).toBe(
          'Damit wären es 12 Dateien. Es sind nur noch 0 weitere erlaubt (maximal 10).'
        )
      })
    })
  })

  /*
    Issue #432: the project Dateiablage and the org Archiv reuse this hook, and
    `UploadOrchestrator.loadFilesForSession` writes their PERSISTED documents
    into the same `trackedFiles` array the session's in-flight uploads live in.
    Whether those existing files count toward the per-upload caps therefore has
    to be declared, and the declaration is the same signal that chooses the
    durable endpoint — not a guess at the collection name.
  */
  describe('the validation context declares what kind of store this is', () => {
    test('a chat session accumulates', () => {
      const { result } = renderHook(() => useFileUpload({ collectionName: 'session-1' }))

      expect(result.current.validationContext.collectionKind).toBe('chat-session')
    })

    test('a project Dateiablage does not', () => {
      const { result } = renderHook(() =>
        useFileUpload({ collectionName: 'proj_abc', projectId: 'proj-1' })
      )

      expect(result.current.validationContext.collectionKind).toBe('durable')
    })

    test('the org Archiv does not', () => {
      const { result } = renderHook(() =>
        useFileUpload({ collectionName: 'archiv_org-1', archiv: true })
      )

      expect(result.current.validationContext.collectionKind).toBe('durable')
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

  /*
    Issue #432 as reported, end to end and with the REAL validator: a project
    whose Dateiablage already holds `maxFileCount` documents could not accept an
    eleventh, because `loadFilesForSession` had written those persisted rows into
    the same `trackedFiles` array the session caps count. Every other test on
    this path stubs `validateFileUpload`, so the hook↔validator seam — the hook
    declaring `collectionKind`, the validator acting on it — is asserted by
    construction rather than by behaviour. This is the behaviour.
  */
  test('a project already holding the file-count limit still accepts an upload (#432)', async () => {
    const { validateFileUpload } = await import('../validation')
    const real = await vi.importActual<typeof import('../validation')>('../validation')
    vi.mocked(validateFileUpload).mockImplementationOnce(real.validateFileUpload)

    // The project's persisted documents, exactly as the orchestrator loads them.
    mockDocumentsStoreState.trackedFiles = Array.from({ length: 10 }, (_, i) => ({
      id: `doc-${i}`,
      fileName: `bestand-${i}.pdf`,
      collectionName: 'proj-collection',
      fileSize: 1024,
    })) as unknown[]

    const { result } = renderUpload()

    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.uploadFiles(makeFiles(1))
      await Promise.resolve()
    })
    await act(async () => {
      xhr.last().respond(200, uploadOk('doc-10'))
      await pending
    })

    // Not refused: the request went out and nothing was written to the error bar.
    expect(xhr.requests).toHaveLength(1)
    expect(xhr.requests[0].url).toBe('/api/documents/upload')
    expect(mockDocumentsStoreState.setError).not.toHaveBeenCalled()
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

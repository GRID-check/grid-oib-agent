/**
 * Dictation inside the real composer: where a transcript lands, and that a
 * failure leaves the message alone. The microphone itself is faked away (the
 * button has its own spec); the insertion rule and the composer are real.
 */
import { render, screen, fireEvent } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { DictationButtonProps } from '@/features/dictation'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))
vi.mock('@/features/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/chat')>()),
  useWebSocketChat: vi.fn(() => ({
    sendMessage: vi.fn(),
    isStreaming: false,
    isLoading: false,
    respondToInteraction: vi.fn(),
    noteSendIntent: vi.fn(),
    pendingInteraction: null,
  })),
  useIsCurrentSessionBusy: vi.fn(() => false),
}))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ idToken: 'test-token', authRequired: true }) }))
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf',
      acceptedMimeTypes: ['application/pdf'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))
vi.mock('@/features/documents', () => ({
  useFileUpload: vi.fn(() => ({
    uploadFiles: vi.fn(),
    sessionFiles: [],
    deleteFile: vi.fn(),
    retryFile: vi.fn(),
    isUploading: false,
    error: null,
    clearError: vi.fn(),
  })),
  useFileDragDrop: vi.fn(() => ({
    isDragging: false,
    isUnsupportedDrag: false,
    dragHandlers: { onDragEnter: vi.fn(), onDragLeave: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn() },
  })),
}))
vi.mock('./FileSourcesTab', () => ({ FileSourcesTab: () => null }))
vi.mock('@/features/documents/components/file-preview-dialog', () => ({ FilePreviewDialog: () => null }))

// A stand-in microphone: two buttons that deliver what a recording would.
vi.mock('@/features/dictation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/dictation')>()),
  DictationButton: ({ onTranscript, onError }: DictationButtonProps) => (
    <>
      <button type="button" onClick={() => onTranscript('the fire rating')}>
        fake transcript
      </button>
      <button type="button" onClick={() => onError('The recording could not be transcribed.')}>
        fake failure
      </button>
    </>
  ),
}))

import { InputArea } from './InputArea'

function composer(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('InputArea dictation', () => {
  test('appends to the end when the composer never had a caret', async () => {
    render(<InputArea isAuthenticated={true} />)

    fireEvent.click(screen.getByRole('button', { name: 'fake transcript' }))

    expect(composer().value).toBe('the fire rating')
  })

  test('inserts at the caret and keeps the text around it', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} />)
    await user.type(composer(), 'Prüf bitte im Stiegenhaus.')
    composer().setSelectionRange(10, 10)
    fireEvent.select(composer())

    fireEvent.click(screen.getByRole('button', { name: 'fake transcript' }))

    expect(composer().value).toBe('Prüf bitte the fire rating im Stiegenhaus.')
  })

  test('a caret placed without a select event is still found, through the blur', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} />)
    await user.type(composer(), 'Prüf bitte im Stiegenhaus.')
    composer().setSelectionRange(10, 10)
    fireEvent.blur(composer())

    fireEvent.click(screen.getByRole('button', { name: 'fake transcript' }))

    expect(composer().value).toBe('Prüf bitte the fire rating im Stiegenhaus.')
  })

  test('a failure shows inline and the message stays as it was', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} />)
    await user.type(composer(), 'Mein Entwurf')

    fireEvent.click(screen.getByRole('button', { name: 'fake failure' }))

    expect(screen.getByRole('alert').textContent).toContain('The recording could not be transcribed.')
    expect(composer().value).toBe('Mein Entwurf')
  })
})

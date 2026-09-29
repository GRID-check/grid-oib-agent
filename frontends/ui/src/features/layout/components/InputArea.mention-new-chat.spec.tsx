/**
 * The first `@` of a NEW chat, end to end on the client.
 *
 * `InputArea.spec.tsx` mocks the candidates hook and the chat store, which is
 * right for the composer's own logic and blind to the one path that keeps
 * breaking: a chat that exists only in the browser, whose server row is created
 * by the `@` itself while the candidates read races it. Here the store and the
 * hook are real, and only `fetch` is faked, as a server that answers 404 for a
 * conversation until its create has landed.
 */
import { act, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Conversation } from '@/features/chat/types'
import type { MentionCandidatesResponse } from '@/lib/mentions/types'

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

import { InputArea } from './InputArea'
import { useChatStore } from '@/features/chat'

const CANDIDATES: MentionCandidatesResponse = {
  candidates: [
    {
      targetId: 'agent:piloti',
      person: { userId: 'agent:piloti', name: 'Piloti', email: null, profilePictureUrl: null },
      isAgent: true,
      isParticipant: true,
      needsInvite: false,
    },
    {
      targetId: 'u-anna',
      person: { userId: 'u-anna', name: 'Anna Weber', email: 'anna@example.com', profilePictureUrl: null },
      isAgent: false,
      isParticipant: false,
      needsInvite: true,
    },
  ],
  canInvite: true,
}

/** A server that knows a conversation only once `POST /api/conversations` has created it. */
function fakeServer(existing: readonly string[] = []) {
  const created = new Set(existing)
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/api/conversations')) {
      const { id } = JSON.parse(String(init.body)) as { id: string }
      // The create lands after the first candidates read has already gone out.
      await new Promise((resolve) => setTimeout(resolve, 30))
      created.add(id)
      return new Response(JSON.stringify({ id }), { status: 201 })
    }
    const candidates = url.match(/\/api\/conversations\/([^/]+)\/mention-candidates/)
    if (candidates && created.has(decodeURIComponent(candidates[1]))) {
      return new Response(JSON.stringify(CANDIDATES), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

async function typeAtAndWaitForAnna(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('textbox'))
  await user.keyboard('@')
  // The first read 404s and the hook's retry ladder (500 ms first rung) reads again.
  await waitFor(() => expect(screen.getByTestId('mention-picker')).toHaveTextContent('Anna Weber'), {
    timeout: 3000,
  })
}

describe('InputArea — the first @ of a new chat', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('creates the conversation and lists the colleagues', async () => {
    vi.stubGlobal('fetch', fakeServer())
    useChatStore.setState({ currentUserId: 'u1', currentConversation: null, conversations: [] })
    render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

    await typeAtAndWaitForAnna()
  })

  test('still lists them after @ was used in the previous chat', async () => {
    // `mentionRequested` latches on the first `@` and the composer stays
    // mounted across "new chat", so the second chat starts from a hook that is
    // already enabled with a null conversation.
    vi.stubGlobal('fetch', fakeServer(['s_earlier']))
    const earlier = {
      id: 's_earlier',
      userId: 'u1',
      title: 'Vorher',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      projectId: null,
    } as unknown as Conversation
    useChatStore.setState({ currentUserId: 'u1', currentConversation: earlier, conversations: [earlier] })
    render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)
    await typeAtAndWaitForAnna()

    const user = userEvent.setup()
    await user.keyboard('{Escape}{Backspace}')
    act(() => useChatStore.getState().startNewSessionDraft())

    await typeAtAndWaitForAnna()
    expect(useChatStore.getState().currentConversation?.id).not.toBe('s_earlier')
  })
})

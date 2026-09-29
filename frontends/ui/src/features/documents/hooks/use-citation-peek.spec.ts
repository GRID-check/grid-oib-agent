import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from '@testing-library/react'
import { renderHook, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { useChatStore } from '@/features/chat/store'
import type { ChatMessage, CitationSource, Conversation } from '@/features/chat/types'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { resetFilePeekBinding } from '../lib/open-file-peek'
import { resetSurfacedDocumentsCache } from './use-surfaced-documents'
import { useCitationPeek } from './use-citation-peek'

const cited = (overrides: Partial<CitationSource> = {}): CitationSource => ({
  id: overrides.id ?? 'c1',
  content: 'Plan.pdf, p.1',
  timestamp: new Date(0),
  isCited: true,
  kind: 'projekt',
  fileName: 'Plan.pdf',
  collection: 'proj_abc',
  page: 1,
  ...overrides,
})

const answer = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'ans-1',
  role: 'assistant',
  messageType: 'agent_response',
  content: 'Die Fluchtweglänge beträgt 34 m.',
  timestamp: new Date(0),
  citations: [cited()],
  ...overrides,
})

const conversation = (messages: ChatMessage[]): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  title: 'Test',
  messages,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
})

const row = (id: string, filename: string) => ({
  id,
  filename,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
})

/**
 * Record every name the project by-name resolver is asked for, and every file
 * the peek opens.
 */
function observe() {
  const asked: string[] = []
  const opened: string[] = []
  server.use(
    http.post('/api/documents/by-name', async ({ request }) => {
      const { names } = (await request.json()) as { names: string[] }
      asked.push(...names)
      return HttpResponse.json({
        documents: names.map((name) => row(sameName(name, CONTROL_FILE) ? 'ctrl' : 'p1', name)),
      })
    }),
  )
  const unsubscribe = useFilePreviewStore.subscribe((state) => {
    if (state.file && opened.at(-1) !== state.file.id) opened.push(state.file.id)
  })
  return { asked, opened, unsubscribe }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** A name no test answer cites, so the control's request cannot be mistaken for one. */
const CONTROL_FILE = 'Kontrolle.pdf'

/**
 * The positive control: a later answer that DOES cite one file, awaited until
 * its peek opens. The hook resolves answers in order through one pipeline, so
 * once the control has gone all the way through, anything the answer under
 * test was going to ask for has been asked — on any runner, however slow. A
 * fixed sleep proved nothing when it expired first.
 */
async function flushWithControl() {
  const messages = useChatStore.getState().currentConversation?.messages ?? []
  act(() => {
    useChatStore.setState({
      currentConversation: conversation([
        ...messages,
        answer({
          id: 'ans-control',
          citations: [cited({ id: 'c-control', fileName: CONTROL_FILE, content: `${CONTROL_FILE}, p.1` })],
        }),
      ]),
    })
  })
  await waitFor(() => expect(useFilePreviewStore.getState().file?.id).toBe('ctrl'))
}

describe('useCitationPeek', () => {
  beforeEach(() => {
    resetSurfacedDocumentsCache()
    resetFilePeekBinding()
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekWidth: 320,
      context: {},
    })
    useChatStore.setState({
      currentConversation: conversation([]),
      composerSubject: null,
      projectId: 'proj-1',
    })
    server.use(
      http.post('/api/documents/by-name', () => HttpResponse.json({ documents: [row('p1', 'Plan.pdf')] })),
      http.post('/api/archiv/documents/by-name', () => HttpResponse.json({ documents: [] })),
    )
  })

  afterEach(() => {
    resetSurfacedDocumentsCache()
    resetFilePeekBinding()
    useFilePreviewStore.setState({ file: null, hidden: false, mode: 'modal', context: {} })
    useChatStore.setState({ currentConversation: null, composerSubject: null })
  })

  it('opens the peek for a finished answer that cites one project file', async () => {
    useChatStore.setState({ currentConversation: conversation([answer()]) })
    renderHook(() => useCitationPeek({ projectId: 'proj-1' }))

    await waitFor(() => expect(useFilePreviewStore.getState().file?.filename).toBe('Plan.pdf'))
    expect(useFilePreviewStore.getState().mode).toBe('peek')
    expect(useChatStore.getState().composerSubject?.filename).toBe('Plan.pdf')
  })

  it('does not reopen after the user hides the peek', async () => {
    useChatStore.setState({ currentConversation: conversation([answer()]) })
    const { rerender } = renderHook(() => useCitationPeek({ projectId: 'proj-1' }))

    await waitFor(() => expect(useFilePreviewStore.getState().file?.id).toBe('p1'))
    useFilePreviewStore.getState().hide()
    expect(useFilePreviewStore.getState().hidden).toBe(true)
    expect(useChatStore.getState().composerSubject?.filename).toBe('Plan.pdf')

    rerender()
    expect(useFilePreviewStore.getState().hidden).toBe(true)
    expect(useFilePreviewStore.getState().file?.id).toBe('p1')
  })

  it('does not peek while the answer is still streaming', async () => {
    const { asked, opened, unsubscribe } = observe()
    useChatStore.setState({
      currentConversation: conversation([answer({ isStreaming: true })]),
    })
    renderHook(() => useCitationPeek({ projectId: 'proj-1' }))
    // Nothing to peek is nothing to resolve: no document is asked for by name,
    // and only the control ever opens.
    await flushWithControl()
    unsubscribe()
    expect(asked.map((name) => name.toLowerCase())).toEqual([CONTROL_FILE.toLowerCase()])
    expect(opened).toEqual(['ctrl'])
  })

  it('does not peek when two project files are cited', async () => {
    const { asked, opened, unsubscribe } = observe()
    useChatStore.setState({
      currentConversation: conversation([
        answer({
          citations: [cited(), cited({ id: 'c2', fileName: 'Schnitt.pdf', content: 'Schnitt.pdf, p.1' })],
        }),
      ]),
    })
    renderHook(() => useCitationPeek({ projectId: 'proj-1' }))
    // Nothing to peek is nothing to resolve: no document is asked for by name,
    // and only the control ever opens.
    await flushWithControl()
    unsubscribe()
    expect(asked.map((name) => name.toLowerCase())).toEqual([CONTROL_FILE.toLowerCase()])
    expect(opened).toEqual(['ctrl'])
  })

  it('does not peek a baurecht-only answer', async () => {
    const { asked, opened, unsubscribe } = observe()
    useChatStore.setState({
      currentConversation: conversation([
        answer({
          citations: [
            cited({
              kind: 'baurecht',
              collection: 'oib_knowledge',
              fileName: 'oib-rl_2.pdf',
              content: 'oib-rl_2.pdf, p.5',
            }),
          ],
        }),
      ]),
    })
    renderHook(() => useCitationPeek({ projectId: 'proj-1' }))
    // Nothing to peek is nothing to resolve: no document is asked for by name,
    // and only the control ever opens.
    await flushWithControl()
    unsubscribe()
    expect(asked.map((name) => name.toLowerCase())).toEqual([CONTROL_FILE.toLowerCase()])
    expect(opened).toEqual(['ctrl'])
  })
})

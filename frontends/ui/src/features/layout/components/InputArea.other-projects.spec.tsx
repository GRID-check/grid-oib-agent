/**
 * The composer's notice about other projects (ADR-0094), through the real
 * composer and the real chat store.
 *
 * The notice lists what the SERVER says restricts the open chat now
 * (`restrictingOtherProjects` on `GET /api/conversations/:id`), never the
 * project status an answer's citations carried when it was written. The server
 * judges at read time: a project closed since restricts nobody, one reopened
 * restricts again, and a restricted folder of a closed project still does. So
 * every case here seeds citations that say one thing and a server that says
 * another, and the notice must follow the server.
 *
 * Its own file, beside `InputArea.screening.spec.tsx`, because
 * `InputArea.spec.tsx` is already the slowest file in the suite.
 */

import { act, render, screen, waitFor } from '@/test-utils'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { server } from '@/mocks/server'
import { useChatStore } from '@/features/chat/store'
import type { ChatMessage, CitationProject, CitationSource } from '@/features/chat/types'
import { InputArea } from './InputArea'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

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

vi.mock('@/features/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat')>()
  return {
    ...actual,
    useWebSocketChat: () => ({
      sendMessage: vi.fn(),
      isLoading: false,
      respondToInteraction: vi.fn(),
      pendingInteraction: null,
      noteSendIntent: vi.fn(),
    }),
  }
})

const CONVERSATION_ID = 's_other_projects'
const GRAZ: CitationProject = { id: '22222222-0000-4000-8000-000000000002', name: 'Wohnbau Graz', status: 'closed' }
const LINZ: CitationProject = { id: '33333333-0000-4000-8000-000000000003', name: 'Schule Linz', status: 'active' }

const answer = (id: string, project: CitationProject): ChatMessage => ({
  id,
  role: 'assistant',
  messageType: 'assistant',
  content: 'Die Traufe ist hinterlüftet.',
  timestamp: new Date('2026-10-06T14:30:00'),
  citations: [
    {
      id: '1',
      number: 1,
      content: `[KB] Detail Traufe.pdf (${project.name}), p.3`,
      citationKey: `Detail Traufe.pdf (${project.name}), p.3`,
      fileName: 'Detail Traufe.pdf',
      collection: `proj_${project.id.slice(0, 8)}`,
      title: 'Detail Traufe',
      origin: 'kb',
      kind: 'projekt',
      shelf: 'project',
      sourceType: 'knowledge_layer',
      page: 3,
      isCited: true,
      timestamp: new Date('2026-10-06T14:30:00'),
      project,
    } satisfies CitationSource,
  ],
})

const open = (messages: ChatMessage[]) =>
  act(() => {
    useChatStore.setState({
      currentConversation: { id: CONVERSATION_ID, messages } as never,
      conversations: [{ id: CONVERSATION_ID, messages }] as never,
      isStreaming: false,
    })
  })

/** What the server says restricts the chat; counts the reads. */
function serverSays(restricting: Array<{ id: string; name: string | null }>) {
  const reads = { count: 0, restricting }
  server.use(
    http.get(`/api/conversations/${CONVERSATION_ID}`, () => {
      reads.count += 1
      return HttpResponse.json({ id: CONVERSATION_ID, shared: false, restrictingOtherProjects: reads.restricting })
    })
  )
  return reads
}

const notice = () => screen.queryByTestId('other-projects-notice')

beforeEach(() => {
  useChatStore.setState({ currentConversation: null, conversations: [], isStreaming: false })
})
afterEach(() => {
  useChatStore.setState({ currentConversation: null, conversations: [], isStreaming: false })
})

describe('the other-projects notice follows the server’s record, not the answers’ citations', () => {
  test('a project that was running at answer time and is closed now is not listed, and the notice is gone', async () => {
    const reads = serverSays([])
    open([answer('a1', { ...LINZ, status: 'active' })])
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await waitFor(() => expect(reads.count).toBeGreaterThan(0))
    await act(async () => {})
    expect(notice()).not.toBeInTheDocument()
  })

  test('a closed project whose restricted folder the chat drew on still shows, named', async () => {
    serverSays([{ id: GRAZ.id, name: GRAZ.name }])
    open([answer('a1', GRAZ)])
    render(<InputArea isAuthenticated connectionMode="sse" />)

    const shown = await screen.findByTestId('other-projects-notice')
    expect(shown).toHaveTextContent('Wohnbau Graz')
  })

  test('a reopened project is listed although the citation recorded it closed', async () => {
    serverSays([{ id: GRAZ.id, name: GRAZ.name }, { id: LINZ.id, name: LINZ.name }])
    open([answer('a1', GRAZ), answer('a2', LINZ)])
    render(<InputArea isAuthenticated connectionMode="sse" />)

    const shown = await screen.findByTestId('other-projects-notice')
    expect(shown).toHaveTextContent('Wohnbau Graz and Schule Linz')
  })

  test('nothing restricting: no notice, whatever the citations carry', async () => {
    const reads = serverSays([])
    open([answer('a1', LINZ), answer('a2', GRAZ)])
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await waitFor(() => expect(reads.count).toBeGreaterThan(0))
    await act(async () => {})
    expect(notice()).not.toBeInTheDocument()
  })

  test('a project that is gone is named as such, so the restriction is still said', async () => {
    serverSays([{ id: GRAZ.id, name: null }])
    open([answer('a1', GRAZ)])
    render(<InputArea isAuthenticated connectionMode="sse" />)

    expect(await screen.findByTestId('other-projects-notice')).toHaveTextContent('a project that no longer exists')
  })

  test('it is read again when a turn ends: the notice appears after the answer that drew on another project', async () => {
    const reads = serverSays([])
    open([{ ...answer('a0', LINZ), citations: [] }])
    render(<InputArea isAuthenticated connectionMode="sse" />)
    await waitFor(() => expect(reads.count).toBe(1))
    expect(notice()).not.toBeInTheDocument()

    reads.restricting = [{ id: LINZ.id, name: LINZ.name }]
    act(() => {
      useChatStore.setState({ isStreaming: true })
    })
    act(() => {
      useChatStore.setState({
        isStreaming: false,
        currentConversation: {
          id: CONVERSATION_ID,
          messages: [{ ...answer('a0', LINZ), citations: [] }, answer('a1', LINZ)],
        } as never,
      })
    })

    expect(await screen.findByTestId('other-projects-notice')).toHaveTextContent('Schule Linz')
    expect(reads.count).toBeGreaterThan(1)
  })

  test('a failed read keeps what was shown', async () => {
    const reads = serverSays([{ id: LINZ.id, name: LINZ.name }])
    open([answer('a0', LINZ)])
    render(<InputArea isAuthenticated connectionMode="sse" />)
    await screen.findByTestId('other-projects-notice')

    server.use(http.get(`/api/conversations/${CONVERSATION_ID}`, () => HttpResponse.json({}, { status: 502 })))
    open([answer('a0', LINZ), answer('a1', LINZ)])

    await act(async () => {})
    expect(reads.count).toBe(1)
    expect(notice()).toHaveTextContent('Schule Linz')
  })
})

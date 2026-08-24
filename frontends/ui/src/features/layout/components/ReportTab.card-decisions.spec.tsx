/**
 * A decision made on a report card is the SAME decision the thread shows.
 *
 * Report cards are drawn from the finished job's output, which carries no
 * message id — so an interactive card here used to fall back to mount-local
 * state and forget what the reader pressed, while the identical card in the
 * thread recorded it properly (ADR-0030 §Open Questions). One card, two answers,
 * decided by which panel the reader happened to click in.
 *
 * These tests run against the REAL chat store, because the whole claim is about
 * where the decision lands: it has to be readable from the thread's own view of
 * the same card, not merely from the panel that took it.
 */
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import { GridCards } from '@/features/grid-cards'
import { useChatStore } from '@/features/chat/store'
import type { ChatMessage, Conversation } from '@/features/chat/types'
import { ReportTab } from './ReportTab'

// The report body itself is not what these tests are about; the real renderer
// parses markdown on every keystroke of setup for nothing.
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))
vi.mock('./ExportFooter', () => ({ ExportFooter: () => <div data-testid="export-footer" /> }))

// The server mirror is best-effort and irrelevant here — the claim is about the
// store, which is what both surfaces render from.
const conversationsClient = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  updateTitle: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  createMessages: vi.fn().mockResolvedValue(undefined),
  updateMessageCardInteractions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({ conversationsClient }))

const STORAGE_KEY = 'aiq-chat-store'
const JOB_ID = 'job-42'
const ANSWER_MESSAGE_ID = 'msg-job-answer'
const CARD_KEY = 'memory_proposal-0'

/**
 * What the run produced. The job output and `metadata.cards` on the answer
 * message are two reads of one list, so both surfaces are given the same
 * values — spelled out twice here exactly as they arrive twice in production
 * (over the job API, and over the message row).
 */
const reportCards = (): GridCard[] => [
  {
    type: 'memory_proposal',
    title: 'Save this finding to memory?',
    content: 'The office always specifies REI 90 for GK4.',
    kind: 'preference',
    confidence: 'high',
  } as GridCard,
]

const message = (overrides: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  role: 'assistant',
  content: '',
  timestamp: new Date('2026-08-19T09:00:00.000Z'),
  messageType: 'agent_response',
  ...overrides,
})

const conversationWith = (messages: ChatMessage[]): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  title: 'Brandschutz',
  messages,
  createdAt: new Date('2026-08-19T09:00:00.000Z'),
  updatedAt: new Date('2026-08-19T09:00:00.000Z'),
})

/** The run's tracking bubble: written when the job starts, carrying no cards. */
const trackingMessage = message({
  id: 'msg-tracking',
  deepResearchJobId: JOB_ID,
  showViewReport: true,
})

/** The answer the worker wrote into the thread when the run finished. */
const answerMessage = message({
  id: ANSWER_MESSAGE_ID,
  content: 'Bericht',
  deepResearchJobId: JOB_ID,
  cards: reportCards(),
})

const showReport = (conversation: Conversation) => {
  useChatStore.setState({
    currentUserId: 'user-1',
    currentConversation: conversation,
    conversations: [conversation],
    projectId: null,
    reportContent: '# Bericht',
    reportContentCategory: 'final_report',
    isStreaming: false,
    currentStatus: null,
    deepResearchJobId: JOB_ID,
    deepResearchCards: reportCards(),
    deepResearchCitations: [],
  })
}

const messageInStore = (messageId: string) =>
  useChatStore.getState().currentConversation?.messages.find((m) => m.id === messageId)

describe('report-tab card decisions', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
  })

  afterEach(() => {
    useChatStore.setState({
      currentConversation: null,
      conversations: [],
      deepResearchCards: [],
      deepResearchJobId: null,
      reportContent: '',
      reportContentCategory: null,
    })
    localStorage.removeItem(STORAGE_KEY)
  })

  it('records the decision on the run’s own answer message', async () => {
    const user = userEvent.setup()
    showReport(conversationWith([trackingMessage, answerMessage]))

    render(<ReportTab />)
    await user.click(screen.getByRole('button', { name: 'No' }))

    expect(messageInStore(ANSWER_MESSAGE_ID)?.cardInteractions?.[CARD_KEY]?.decision).toBe(
      'dismissed'
    )
    // Never onto the tracking bubble: its own cards (none here, but they can
    // arrive from the escalation frame) are a different card set under the very
    // same positional keys.
    expect(messageInStore('msg-tracking')?.cardInteractions).toBeUndefined()
  })

  it('shows that decision in the thread’s view of the same card', async () => {
    const user = userEvent.setup()
    showReport(conversationWith([trackingMessage, answerMessage]))

    const panel = render(<ReportTab />)
    await user.click(screen.getByRole('button', { name: 'No' }))
    panel.unmount()

    // How the chat draws it: the message's own cards, keyed on the message.
    const thread = render(
      <GridCards cards={messageInStore(ANSWER_MESSAGE_ID)?.cards ?? []} messageId={ANSWER_MESSAGE_ID} />
    )

    expect(within(thread.container).getByText('Not saved.')).toBeInTheDocument()
    expect(thread.queryByRole('button', { name: 'No' })).toBeNull()
  })

  it('offers no decision at all when no message owns the cards', async () => {
    // The run is still in flight: the worker writes the answer message when it
    // finishes, so nothing in the thread carries these cards yet.
    showReport(conversationWith([trackingMessage]))

    render(<ReportTab />)

    // The proposal still READS — the reader is told what the run wants
    // remembered — but nothing here takes an answer it would drop.
    expect(screen.getByText('The office always specifies REI 90 for GK4.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Yes, remember org-wide' })).toBeNull()
  })

  it('offers no decision when the same run’s message carries a DIFFERENT card set', () => {
    // Positional keys: filing this report's `memory_proposal-0` against that
    // message's other `memory_proposal-0` would answer a proposal the reader
    // never saw.
    const divergent = message({
      id: 'msg-other-cards',
      deepResearchJobId: JOB_ID,
      cards: [{ ...reportCards()[0], content: 'Something else entirely' } as GridCard],
    })
    showReport(conversationWith([trackingMessage, divergent]))

    render(<ReportTab />)

    expect(screen.queryByRole('button', { name: 'No' })).toBeNull()
    expect(messageInStore('msg-other-cards')?.cardInteractions).toBeUndefined()
  })
})

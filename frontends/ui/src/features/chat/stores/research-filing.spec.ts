/**
 * @vitest-environment node
 */
/**
 * Recording a filed report on the run's success banner.
 *
 * The two facts arrive separately and over different transports: the success
 * banner is written from the SSE stream the moment the run finishes, and the
 * filing is only known once the report route has been asked for the report —
 * that GET is where the BFF observes completion and files the document. These
 * tests pin the seam between them.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../store'
import type { ChatMessage, Conversation, DeepResearchBannerType } from '../types'

const banner = (bannerType: DeepResearchBannerType, jobId: string, id: string): ChatMessage => ({
  id,
  role: 'assistant',
  content: '',
  timestamp: new Date('2026-08-20T09:00:00Z'),
  messageType: 'deep_research_banner',
  deepResearchBannerData: { bannerType, jobId },
})

const conversation = (id: string, messages: ChatMessage[]): Conversation => ({
  id,
  userId: 'user-1',
  title: 'Test',
  messages,
  createdAt: new Date('2026-08-20T08:00:00Z'),
  updatedAt: new Date('2026-08-20T08:00:00Z'),
})

const FILED = { documentId: 'doc-9', filename: 'fluchtwege-gk4-2026-08-20.docx' }

const bannerDataFor = (conversationId: string, messageId: string) =>
  useChatStore
    .getState()
    .conversations.find((c) => c.id === conversationId)
    ?.messages.find((m) => m.id === messageId)?.deepResearchBannerData

describe('recordDeepResearchFiling', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], currentConversation: null })
  })

  it('attaches the filed document to that run’s success banner', () => {
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(bannerDataFor('conv-1', 'banner-1')?.filedDocument).toEqual(FILED)
    expect(useChatStore.getState().currentConversation?.messages[0].deepResearchBannerData?.filedDocument).toEqual(FILED)
  })

  it('finds the banner in a thread that is not the open one', () => {
    // A report can be re-read — and so first filed — from the run history or
    // after the reader has moved on to another thread. Searching by job id is
    // what makes the filing land on the run that produced it either way.
    const other = conversation('conv-2', [banner('success', 'job-1', 'banner-2')])
    const open = conversation('conv-1', [])
    useChatStore.setState({ conversations: [other, open], currentConversation: open })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(bannerDataFor('conv-2', 'banner-2')?.filedDocument).toEqual(FILED)
  })

  it('leaves another run’s banner alone', () => {
    const conv = conversation('conv-1', [
      banner('success', 'job-1', 'banner-1'),
      banner('success', 'job-2', 'banner-2'),
    ])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(bannerDataFor('conv-1', 'banner-2')?.filedDocument).toBeUndefined()
  })

  it('does not decorate a failed or cancelled run', () => {
    // Only a success banner can carry a file, because only a successful run
    // produced one. A failure banner offering to open a document would be
    // claiming the run left something behind — G6 says it deliberately does not.
    const conv = conversation('conv-1', [banner('failure', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(bannerDataFor('conv-1', 'banner-1')?.filedDocument).toBeUndefined()
  })

  it('is a no-op for a run with no banner in any thread', () => {
    // An attached run (a workflow run, or one opened from the history) has no
    // owning thread and therefore no banner to write into.
    const conv = conversation('conv-1', [banner('success', 'job-other', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    const before = useChatStore.getState().conversations

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(useChatStore.getState().conversations).toBe(before)
  })

  it('does not re-render when the same document is reported twice', () => {
    // The report route is asked again every time the tab is opened, and it
    // answers with the same `filed` object each time.
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)
    const afterFirst = useChatStore.getState().conversations
    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(useChatStore.getState().conversations).toBe(afterFirst)
  })
})

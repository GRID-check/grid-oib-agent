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

const FILED = { documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf' }

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

/**
 * The other half of the same answer.
 *
 * `filed` absent used to mean four things at once. The report route now
 * separates them: `filingFailed` is raised only when a project was resolved and
 * the write still failed — the same condition under which the starting banner
 * printed „wird abgelegt". These tests pin that this fact reaches the banner,
 * and that it never outranks a document that actually exists.
 */
describe('recordDeepResearchFilingFailure', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], currentConversation: null })
  })

  it('marks that run’s success banner as a promise broken', () => {
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(bannerDataFor('conv-1', 'banner-1')?.filingFailed).toBe(true)
    expect(
      useChatStore.getState().currentConversation?.messages[0].deepResearchBannerData?.filingFailed
    ).toBe(true)
  })

  it('finds the banner in a thread that is not the open one', () => {
    const other = conversation('conv-2', [banner('success', 'job-1', 'banner-2')])
    const open = conversation('conv-1', [])
    useChatStore.setState({ conversations: [other, open], currentConversation: open })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(bannerDataFor('conv-2', 'banner-2')?.filingFailed).toBe(true)
  })

  it('leaves another run’s banner alone', () => {
    const conv = conversation('conv-1', [
      banner('success', 'job-1', 'banner-1'),
      banner('success', 'job-2', 'banner-2'),
    ])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(bannerDataFor('conv-1', 'banner-2')?.filingFailed).toBeUndefined()
  })

  it('never overrides a document that already exists', () => {
    // A report is re-fetched every time its tab is opened, and a later attempt
    // can fail for a document that landed on the first one. Retracting a filing
    // the reader can still open is the one dishonesty worse than the silence
    // this whole flag replaces.
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)
    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(bannerDataFor('conv-1', 'banner-1')?.filedDocument).toEqual(FILED)
    expect(bannerDataFor('conv-1', 'banner-1')?.filingFailed).toBeFalsy()
  })

  it('clears a recorded failure when a later fetch does file the document', () => {
    // The failure is best-effort in both directions: reopening the report
    // re-triggers the filing, so a run whose first attempt was refused can land
    // on the second. The banner must then name the file and stop denying it.
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')
    useChatStore.getState().recordDeepResearchFiling('job-1', FILED)

    expect(bannerDataFor('conv-1', 'banner-1')?.filedDocument).toEqual(FILED)
    expect(bannerDataFor('conv-1', 'banner-1')?.filingFailed).toBe(false)
  })

  it('does not decorate a failed or cancelled run', () => {
    // No promise was made on a run that never reached success — its starting
    // banner is gone and its outcome is already stated.
    const conv = conversation('conv-1', [banner('failure', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(bannerDataFor('conv-1', 'banner-1')?.filingFailed).toBeUndefined()
  })

  it('is a no-op for a run with no banner in any thread', () => {
    const conv = conversation('conv-1', [banner('success', 'job-other', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    const before = useChatStore.getState().conversations

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(useChatStore.getState().conversations).toBe(before)
  })

  it('does not re-render when the same failure is reported twice', () => {
    const conv = conversation('conv-1', [banner('success', 'job-1', 'banner-1')])
    useChatStore.setState({ conversations: [conv], currentConversation: conv })

    useChatStore.getState().recordDeepResearchFilingFailure('job-1')
    const afterFirst = useChatStore.getState().conversations
    useChatStore.getState().recordDeepResearchFilingFailure('job-1')

    expect(useChatStore.getState().conversations).toBe(afterFirst)
  })
})

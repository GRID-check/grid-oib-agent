/**
 * @vitest-environment node
 */
/**
 * A turn's retrieval is CUMULATIVE — a document the turn has read cannot become
 * un-read halfway through the stream.
 *
 * Regression: thinking steps are keyed by function name alone, so every call a
 * ReAct-style agent makes to the same tool within one turn lands on the same
 * step, and each "Function Complete: X" frame replaced that step's `content`
 * wholesale. The Herleitung rebuilds its cards from the CURRENT step content
 * (`buildCitationModel({ traceLanes: deriveTraceLanes(steps) })`), so the
 * `## Trace-Lanes` block of call #1 — and the source card already rendered from
 * it — disappeared the moment call #2 completed with a different payload. The
 * store now folds the lanes of both payloads into the step's `traceLanes` before
 * overwriting `content`, which `deriveTraceLanes` prefers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import { buildCitationModel } from '../lib/citations'
import { deriveTraceLanes } from '../lib/trace-lanes'
import { pruneMessageForStorage } from '../lib/prune-message-for-storage'
import type { Conversation } from '../types'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      closeRightPanel: vi.fn(),
      enabledDataSourceIds: [],
      availableDataSources: [],
      setEnabledDataSources: vi.fn(),
    }),
  },
}))

vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))

vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listMessages: vi.fn().mockResolvedValue([]),
    createMessage: vi.fn().mockResolvedValue(undefined),
    createMessages: vi.fn().mockResolvedValue(undefined),
    updateMessageCardInteractions: vi.fn().mockResolvedValue(undefined),
  },
}))

const TOOL = 'knowledge_search_tool'

/** Payload of the tool's FIRST call — one OIB hit, with the backend's block. */
const firstCallPayload = `Found 1 relevant document(s):

--- Result 1 ---
Source: OIB-RL_2_Brandschutz.pdf
Collection: oib_knowledge
Page: 12
Citation: OIB-RL_2_Brandschutz.pdf, p.12

Brandschutzanforderungen für Gebäudeklasse 4

## Trace-Lanes
{"lanes":[{"key":"baurecht_oib","label":"OIB-Richtlinie","kind":"baurecht","hitCount":1,"sources":[{"name":"OIB-RL_2_Brandschutz.pdf","title":"OIB-Richtlinie 2 Brandschutz","detail":"p.12"}]}]}
`

/** Payload of the SECOND call — a different document, in a different lane. */
const secondCallPayload = `Found 1 relevant document(s):

--- Result 1 ---
Source: Brandschutzkonzept.pdf
Collection: proj_abc-123
Page: 3
Citation: Brandschutzkonzept.pdf, p.3

Projektspezifisches Konzept

## Trace-Lanes
{"lanes":[{"key":"projekt","label":"Projektwissen","kind":"projekt","hitCount":1,"sources":[{"name":"Brandschutzkonzept.pdf","detail":"p.3"}]}]}
`

/** Payload of a call that found nothing — no block at all. */
const emptyCallPayload = 'Found 0 relevant document(s):\n'

const conversationWithUserMessage = (): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  title: 'Brandschutz',
  messages: [
    {
      id: 'msg-1',
      role: 'user',
      content: 'Welche Brandschutzauflagen gelten?',
      timestamp: new Date('2026-07-28T09:00:00.000Z'),
      messageType: 'user',
    },
  ],
  createdAt: new Date('2026-07-28T09:00:00.000Z'),
  updatedAt: new Date('2026-07-28T09:00:00.000Z'),
})

/** Start the tool step the way `onIntermediateStep` does on "Function Start". */
const startToolStep = (): void => {
  useChatStore.getState().addThinkingStep({
    category: 'tools',
    functionName: TOOL,
    displayName: 'Knowledge Search',
    content: '',
    isComplete: false,
  })
}

/** The documents the Herleitung would render for the turn, right now. */
const renderedDocumentNames = (): string[] =>
  buildCitationModel({
    traceLanes: deriveTraceLanes(useChatStore.getState().getThinkingStepsForMessage('msg-1')),
  }).map((doc) => doc.fileName ?? doc.title)

describe('updateThinkingStepByFunctionName — repeated calls of the same tool', () => {
  beforeEach(() => {
    const conversation = conversationWithUserMessage()
    useChatStore.setState({
      currentUserId: 'user-1',
      currentUserMessageId: 'msg-1',
      currentConversation: conversation,
      conversations: [conversation],
      thinkingSteps: [],
    })
  })

  it('keeps the first call\'s document after a second call overwrites the step', () => {
    startToolStep()

    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)
    expect(renderedDocumentNames()).toContain('OIB-RL_2_Brandschutz.pdf')

    // Same functionName, different Trace-Lanes block: the card built from call
    // #1 used to vanish here, because the step content it was derived from was
    // gone. Retrieval is cumulative, so BOTH documents must be present.
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, secondCallPayload, true)

    expect(renderedDocumentNames()).toEqual(
      expect.arrayContaining(['OIB-RL_2_Brandschutz.pdf', 'Brandschutzkonzept.pdf'])
    )
  })

  it('keeps both documents when a later call finds nothing at all', () => {
    startToolStep()
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, secondCallPayload, true)
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, emptyCallPayload, true)

    expect(renderedDocumentNames()).toEqual(
      expect.arrayContaining(['OIB-RL_2_Brandschutz.pdf', 'Brandschutzkonzept.pdf'])
    )
  })

  it('still shows the latest payload as the step text and marks it complete', () => {
    startToolStep()
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, secondCallPayload, true)

    // The visible step text is untouched by the fix — the lanes ride alongside.
    const step = useChatStore.getState().findThinkingStepByFunctionName(TOOL)
    expect(step?.content).toBe(secondCallPayload)
    expect(step?.isComplete).toBe(true)
  })

  it('does not double-count a hit the tool reports twice', () => {
    startToolStep()
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)

    const lanes = deriveTraceLanes(useChatStore.getState().getThinkingStepsForMessage('msg-1'))
    expect(lanes).toHaveLength(1)
    expect(lanes[0].sources).toHaveLength(1)
    expect(lanes[0].hitCount).toBe(1)
  })

  it('carries the accumulated lanes on the message copy, so the storage prune keeps them', () => {
    startToolStep()
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, firstCallPayload, true)
    useChatStore.getState().updateThinkingStepByFunctionName(TOOL, secondCallPayload, true)

    const message = useChatStore.getState().currentConversation?.messages[0]
    expect(message).toBeDefined()
    const pruned = pruneMessageForStorage(message!)
    const stored = pruned.thinkingSteps?.[0].traceLanes ?? []

    // The prune drops `content`, so anything it did not take from the step's
    // own `traceLanes` would be unrecoverable after a reload.
    expect(stored.map((lane) => lane.key).sort()).toEqual(['baurecht_oib', 'projekt'])
    expect(stored.flatMap((lane) => lane.sources.map((s) => s.name)).sort()).toEqual([
      'Brandschutzkonzept.pdf',
      'OIB-RL_2_Brandschutz.pdf',
    ])
  })

  it('leaves a tool with no structured block on the URL-scan fallback', () => {
    // Web/RIS output ships no `## Trace-Lanes`, so the step must NOT gain an
    // empty `traceLanes` — that would make `deriveTraceLanes` prefer nothing
    // over the URL scan and lose the web sources entirely.
    useChatStore.getState().addThinkingStep({
      category: 'tools',
      functionName: 'web_search_tool',
      displayName: 'Web Search',
      content: '',
      isComplete: false,
    })
    useChatStore
      .getState()
      .updateThinkingStepByFunctionName('web_search_tool', 'See https://example.org/doc', true)

    expect(useChatStore.getState().findThinkingStepByFunctionName('web_search_tool')?.traceLanes)
      .toBeUndefined()
    expect(
      deriveTraceLanes(useChatStore.getState().getThinkingStepsForMessage('msg-1')).map((l) => l.key)
    ).toContain('web')
  })
})

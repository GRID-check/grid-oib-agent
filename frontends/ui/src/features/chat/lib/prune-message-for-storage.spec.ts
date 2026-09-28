/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { pruneMessageForStorage } from './prune-message-for-storage'
import type { ChatMessage, CitationSource } from '../types'

const citation = (overrides: Partial<CitationSource> = {}): CitationSource => ({
  id: 'c1',
  url: 'https://example.com',
  content: 'OIB-RL 2, 5.1.1',
  timestamp: new Date('2026-09-25T09:00:00.000Z'),
  isCited: true,
  ...overrides,
})

const answer = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content: 'Höchstens 40 m.',
  timestamp: new Date('2026-09-25T09:00:00.000Z'),
  messageType: 'agent_response',
  ...overrides,
})

describe('pruneMessageForStorage', () => {
  test('hands back a message without citations as it is', () => {
    const message = answer({
      thinkingSteps: [
        { id: 's1', userMessageId: 'u1', timestamp: '2026-09-25T09:00:00.000Z', isComplete: true, kind: 'tool', tool: 'knowledge_search' },
      ],
    })
    expect(pruneMessageForStorage(message)).toBe(message)
  })

  test('keeps a small citation as the same object', () => {
    const kept = citation()
    expect(pruneMessageForStorage(answer({ citations: [kept] })).citations![0]).toBe(kept)
  })

  test('caps the locator and the passage, the two free-text fields of a citation', () => {
    const pruned = pruneMessageForStorage(
      answer({ citations: [citation({ content: 'x'.repeat(5_000), snippet: 'y'.repeat(5_000) })] })
    )
    expect(pruned.citations![0]!.content).toHaveLength(300)
    expect(pruned.citations![0]!.snippet).toHaveLength(1_200)
  })
})

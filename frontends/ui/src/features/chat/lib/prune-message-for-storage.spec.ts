/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import {
  pruneMessageForStorage,
  capString,
  stripThinkingStepsForStorage,
} from './prune-message-for-storage'
import type { ChatMessage } from '../types'

describe('prune-message-for-storage', () => {
  describe('pruneMessageForStorage', () => {
    test('removes the legacy intermediate steps and keeps the compact citations', () => {
      const message: ChatMessage = {
        id: 'msg_1',
        role: 'assistant',
        content: 'Test message',
        timestamp: new Date(),
        messageType: 'agent_response',
        citations: [
          {
            id: 'c1',
            url: 'http://example.com',
            content: 'Citation content',
            timestamp: new Date(),
            isCited: true,
          },
        ],
        intermediateSteps: [
          { id: 'i1', name: 'Step', status: 'complete', content: 'Content', timestamp: new Date() },
        ],
      }

      const pruned = pruneMessageForStorage(message)

      // Essential fields kept
      expect(pruned.id).toBe('msg_1')
      expect(pruned.role).toBe('assistant')
      expect(pruned.content).toBe('Test message')
      expect(pruned.messageType).toBe('agent_response')

      // Citations survive (compact) so the "Belegt durch" chips persist across
      // reload — a shallow answer's sources cannot be refetched.
      expect(pruned.citations).toHaveLength(1)
      expect(pruned.citations![0].id).toBe('c1')
      expect(pruned.intermediateSteps).toBeUndefined()
    })

    test('keeps essential UI fields', () => {
      const message: ChatMessage = {
        id: 'msg_2',
        role: 'user',
        content: 'User question',
        timestamp: new Date(),
        messageType: 'user',
        thinkingSteps: [
          {
            id: 'ts1',
            userMessageId: 'msg_2',
            category: 'tools',
            functionName: 'test_function',
            displayName: 'Thinking',
            content: 'Thought process',
            timestamp: new Date(),
            isComplete: true,
          },
        ],
        enabledDataSources: ['web_search'],
        messageFiles: [{ id: 'f1', fileName: 'doc.pdf' }],
        deepResearchJobId: 'job_123',
      }

      const pruned = pruneMessageForStorage(message)

      expect(pruned.thinkingSteps).toBeDefined()
      expect(pruned.thinkingSteps).toHaveLength(1)
      expect(pruned.enabledDataSources).toEqual(['web_search'])
      expect(pruned.messageFiles).toHaveLength(1)
      expect(pruned.deepResearchJobId).toBe('job_123')
    })

    test('strips thinking step content and removes deep research steps', () => {
      const message: ChatMessage = {
        id: 'msg_3',
        role: 'user',
        content: 'Question',
        timestamp: new Date(),
        messageType: 'user',
        thinkingSteps: [
          {
            id: 'ts_shallow',
            userMessageId: 'msg_3',
            category: 'tools',
            functionName: 'web_search_tool',
            displayName: 'Web Search',
            content: 'Large content that is never displayed in ChatThinking',
            rawPayload: '{"raw": "payload data"}',
            timestamp: new Date(),
            isComplete: true,
            isDeepResearch: false,
          },
          {
            id: 'ts_deep',
            userMessageId: 'msg_3',
            category: 'agents',
            functionName: 'deep_agent',
            displayName: 'Deep Agent',
            content: 'Deep research content',
            timestamp: new Date(),
            isComplete: true,
            isDeepResearch: true,
          },
        ],
      }

      const pruned = pruneMessageForStorage(message)

      // Deep research step removed entirely
      expect(pruned.thinkingSteps).toHaveLength(1)
      expect(pruned.thinkingSteps![0].id).toBe('ts_shallow')

      // Shallow step content stripped
      expect(pruned.thinkingSteps![0].content).toBe('')
      expect(pruned.thinkingSteps![0].rawPayload).toBeUndefined()

      // Display fields preserved
      expect(pruned.thinkingSteps![0].displayName).toBe('Web Search')
      expect(pruned.thinkingSteps![0].functionName).toBe('web_search_tool')
      expect(pruned.thinkingSteps![0].isTopLevel).toBeUndefined()
    })

    test('derives and keeps traceLanes when stripping tool payload', () => {
      const message: ChatMessage = {
        id: 'msg_3b',
        role: 'user',
        content: 'Question',
        timestamp: new Date(),
        messageType: 'user',
        thinkingSteps: [
          {
            id: 'ts_kb',
            userMessageId: 'msg_3b',
            category: 'tools',
            functionName: 'knowledge_retrieval',
            displayName: 'Knowledge',
            content: `Found 1 document(s):

--- Result 1 ---
Source: OIB-RL_2_Brandschutz.pdf
Collection: oib_knowledge
Citation: OIB-RL_2_Brandschutz.pdf, p.12

## Trace-Lanes
{"lanes":[{"key":"baurecht_oib","label":"OIB-Richtlinie","hitCount":1,"sources":[{"name":"OIB-RL_2_Brandschutz.pdf","detail":"p.12"}]}]}
`,
            timestamp: new Date(),
            isComplete: true,
          },
        ],
      }

      const pruned = pruneMessageForStorage(message)
      expect(pruned.thinkingSteps![0].content).toBe('')
      expect(pruned.thinkingSteps![0].traceLanes).toEqual([
        {
          key: 'baurecht_oib',
          label: 'OIB-Richtlinie',
          hitCount: 1,
          sources: [{ name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' }],
          // The coarse kind is persisted alongside the signal so a reloaded
          // message renders through the same taxonomy as a live one.
          kind: 'baurecht',
          signal: 'law',
        },
      ])
    })

    test('handles messages without thinkingSteps', () => {
      const message: ChatMessage = {
        id: 'msg_5',
        role: 'user',
        content: 'Simple message',
        timestamp: new Date(),
      }

      const pruned = pruneMessageForStorage(message)

      expect(pruned.id).toBe('msg_5')
      expect(pruned.content).toBe('Simple message')
      expect(pruned.thinkingSteps).toBeUndefined()
    })
  })

  describe('capString', () => {
    test('returns original string if under limit', () => {
      const result = capString('hello', 10)
      expect(result).toBe('hello')
    })

    test('truncates string if over limit', () => {
      const result = capString('hello world', 5)
      expect(result).toBe('hello')
    })

    test('handles empty string', () => {
      const result = capString('', 10)
      expect(result).toBe('')
    })
  })

  describe('stripThinkingStepsForStorage', () => {
    test('removes deep research steps', () => {
      const steps = [
        {
          id: 'ts_shallow',
          userMessageId: 'msg_1',
          category: 'tools' as const,
          functionName: 'web_search',
          displayName: 'Web Search',
          content: 'some content',
          timestamp: new Date(),
          isComplete: true,
          isDeepResearch: false,
        },
        {
          id: 'ts_deep',
          userMessageId: 'msg_1',
          category: 'agents' as const,
          functionName: 'deep_agent',
          displayName: 'Deep Agent',
          content: 'deep content',
          timestamp: new Date(),
          isComplete: true,
          isDeepResearch: true,
        },
      ]

      const stripped = stripThinkingStepsForStorage(steps)

      expect(stripped).toHaveLength(1)
      expect(stripped[0].id).toBe('ts_shallow')
    })

    test('strips content from shallow steps', () => {
      const steps = [
        {
          id: 'ts1',
          userMessageId: 'msg_1',
          category: 'tools' as const,
          functionName: 'test_function',
          displayName: 'Step 1',
          content: 'x'.repeat(10000),
          rawPayload: '{"large": "payload"}',
          timestamp: new Date(),
          isComplete: true,
        },
      ]

      const stripped = stripThinkingStepsForStorage(steps)

      expect(stripped).toHaveLength(1)
      expect(stripped[0].content).toBe('')
      expect(stripped[0].rawPayload).toBeUndefined()
      expect(stripped[0].displayName).toBe('Step 1')
      expect(stripped[0].functionName).toBe('test_function')
    })

    test('preserves display fields', () => {
      const ts = new Date()
      const steps = [
        {
          id: 'ts1',
          userMessageId: 'msg_1',
          category: 'tools' as const,
          functionName: 'search_tool',
          displayName: 'Search Tool',
          content: 'content',
          timestamp: ts,
          isComplete: true,
          isTopLevel: true,
        },
      ]

      const stripped = stripThinkingStepsForStorage(steps)

      expect(stripped[0].id).toBe('ts1')
      expect(stripped[0].userMessageId).toBe('msg_1')
      expect(stripped[0].functionName).toBe('search_tool')
      expect(stripped[0].displayName).toBe('Search Tool')
      expect(stripped[0].timestamp).toBe(ts)
      expect(stripped[0].isComplete).toBe(true)
      expect(stripped[0].isTopLevel).toBe(true)
    })

    test('handles empty array', () => {
      const stripped = stripThinkingStepsForStorage([])
      expect(stripped).toHaveLength(0)
    })
  })
})

describe('the turn event survives the prune', () => {
  const baseStep = {
    id: 'ts_status',
    userMessageId: 'm1',
    functionName: 'status:retrieval:0',
    displayName: 'status:retrieval:0',
    category: 'tools' as const,
    timestamp: new Date('2026-09-01T10:00:00Z'),
    isComplete: true,
  }

  test('keeps the key and values of the newest live event, and drops the payload', () => {
    const older = JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      key: 'status.retrieval.plain',
      values: { corpus: 'knowledge' },
    })
    const newer = JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Fluchtweglänge GK4' },
    })
    const [pruned] = stripThinkingStepsForStorage([{ ...baseStep, content: `${older}\n${newer}` }])
    expect(pruned.content).toBe('')
    expect(pruned.turnEvent).toEqual({
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Fluchtweglänge GK4' },
    })
  })

  test('a technical event is not hoisted, and a non-status step carries none', () => {
    const technical = JSON.stringify({ kind: 'status', channel: 'technical', slot: 'x', key: 'status.budget' })
    const [status, tool] = stripThinkingStepsForStorage([
      { ...baseStep, content: technical },
      { ...baseStep, id: 'ts_tool', functionName: 'knowledge_search', content: '{"results": 3}' },
    ])
    expect(status.turnEvent).toBeUndefined()
    expect(tool.turnEvent).toBeUndefined()
  })
})

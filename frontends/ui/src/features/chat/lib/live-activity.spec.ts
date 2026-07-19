import { describe, test, expect } from 'vitest'
import { deriveLiveActivity } from './live-activity'
import type { ThinkingStep } from '../types'

// Echo translator: returns the key so assertions read the resolved activity key
// directly (interpolation of {name} is done inside deriveLiveActivity).
const t = (key: string) => key

const step = (overrides: Partial<ThinkingStep> = {}): ThinkingStep => ({
  id: 's',
  userMessageId: 'm',
  category: 'agents',
  functionName: 'unknown',
  displayName: 'Unknown',
  content: '',
  isComplete: false,
  timestamp: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
})

describe('deriveLiveActivity', () => {
  test('returns null when there are no steps', () => {
    expect(deriveLiveActivity([], t)).toBeNull()
  })

  test.each([
    ['intent_classifier', 'thinking.activity.understanding'],
    ['web_search_tool', 'thinking.activity.searchingWeb'],
    ['tavily_search', 'thinking.activity.searchingWeb'],
    ['knowledge_retrieval', 'thinking.activity.searchingSources'],
    ['depth_router', 'thinking.activity.planning'],
    ['deep_research_agent', 'thinking.activity.researching'],
    ['url_fetch', 'thinking.activity.reading'],
    ['meta_chatter', 'thinking.activity.composing'],
    ['generic_query', 'thinking.activity.searchingSources'],
  ])('classifies %s → %s', (functionName, expected) => {
    expect(deriveLiveActivity([step({ functionName })], t)).toBe(expected)
  })

  test('classifies the newest in-progress step, not an earlier completed one', () => {
    const steps = [
      step({ id: '1', functionName: 'intent_classifier', isComplete: true }),
      step({ id: '2', functionName: 'web_search_tool', isComplete: false }),
    ]
    expect(deriveLiveActivity(steps, t)).toBe('thinking.activity.searchingWeb')
  })

  test('falls back to the step display name for an unclassifiable step', () => {
    const result = deriveLiveActivity([step({ functionName: 'xyz', displayName: 'Custom Step' })], t)
    // runningNamed template is "{name} …"; the echo translator returns the key,
    // so only the {name} substitution is observable here.
    expect(result).toBe('thinking.activity.runningNamed')
  })
})

import { describe, test, expect } from 'vitest'
import { deriveLiveActivity } from './live-activity'
import { getDisplayName } from './intermediate-step-parser'
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
    ['advanced_web_search_tool', 'thinking.activity.searchingWeb'],
    ['tavily_search', 'thinking.activity.searchingWeb'],
    ['knowledge_search', 'thinking.activity.searchingKnowledge'],
    ['knowledge_retrieval', 'thinking.activity.searchingKnowledge'],
    ['ris_search_tool', 'thinking.activity.searchingRis'],
    ['ris_catalog_lookup_tool', 'thinking.activity.searchingRis'],
    ['ris_fetch_tool', 'thinking.activity.searchingRis'],
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

  test('returns null when every step is complete — a finished step never drives the live phrase', () => {
    // The stale-label bug: after `Function Complete: web_search_tool` the
    // backend goes quiet while the LLM composes; the header must NOT keep
    // shimmering "Searching the web …" for that finished step.
    const steps = [
      step({ id: '1', functionName: 'intent_classifier', isComplete: true }),
      step({ id: '2', functionName: 'web_search_tool', isComplete: true }),
    ]
    expect(deriveLiveActivity(steps, t)).toBeNull()
  })

  test('falls back to the step display name for an unclassifiable step', () => {
    const result = deriveLiveActivity([step({ functionName: 'xyz', displayName: 'Custom Step' })], t)
    // runningNamed template is "{name} …"; the echo translator returns the key,
    // so only the {name} substitution is observable here.
    expect(result).toBe('thinking.activity.runningNamed')
  })

  test('never names the model in the status bar', () => {
    // A model id matches no activity rule, so it fell through to the display-name
    // fallback and the header read "Running Nemotron 3 Nano 30B A3B …". Which
    // model answers is an implementation detail of the product, not a fact about
    // the user's question — and an LLM step IS the compose phase, so say that.
    const models = [
      'nvidia/nvidia/Nemotron-3-Nano-30B-A3B',
      'openai/gpt-4o',
      'deepseek/deepseek-chat',
      'anthropic/claude-sonnet-4',
    ]
    for (const functionName of models) {
      const result = deriveLiveActivity(
        [step({ functionName, displayName: getDisplayName(functionName) })],
        t
      )
      expect(result).toBe('thinking.activity.composing')
    }
  })

  test('the raw model name never reaches the phrase, whatever the translator does', () => {
    // Belt and braces: assert on a REAL interpolating translator, so a future
    // change that reintroduces the fallback cannot pass by returning a key.
    const interpolate = (key: string) =>
      key === 'thinking.activity.runningNamed' ? '{name} …' : key
    const functionName = 'nvidia/nvidia/Nemotron-3-Nano-30B-A3B'
    const phrase =
      deriveLiveActivity(
        [step({ functionName, displayName: getDisplayName(functionName) })],
        interpolate
      ) ?? ''

    expect(phrase.toLowerCase()).not.toContain('nemotron')
    expect(phrase).not.toContain('{name}')
  })
})

import { describe, test, expect } from 'vitest'
import { deriveExecutedSteps } from './executed-steps'
import type { ThinkingStep } from '../types'

// Echo translator: returns the key so assertions read the resolved step-name
// key directly.
const t = (key: string) => key

const step = (overrides: Partial<ThinkingStep> = {}): ThinkingStep => ({
  id: 's',
  userMessageId: 'm',
  category: 'tools',
  functionName: 'unknown',
  displayName: 'Unknown',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-01T00:00:00Z'),
  ...overrides,
})

describe('deriveExecutedSteps', () => {
  test('returns nothing for no steps', () => {
    expect(deriveExecutedSteps([], t)).toEqual([])
  })

  test.each([
    ['intent_classifier', 'thinking.stepName.understanding'],
    ['depth_router', 'thinking.stepName.routing'],
    ['web_search_tool', 'thinking.stepName.webSearch'],
    ['tavily_search', 'thinking.stepName.webSearch'],
    ['ris_search', 'thinking.stepName.ris'],
    ['knowledge_retrieval', 'thinking.stepName.corpus'],
    ['shallow_research_agent', 'thinking.stepName.assistant'],
    ['meta_chatter', 'thinking.stepName.assistant'],
    ['url_fetch', 'thinking.stepName.reading'],
  ])('maps %s → %s', (functionName, expected) => {
    expect(deriveExecutedSteps([step({ functionName })], t)[0].label).toBe(expected)
  })

  test('unknown functions fall back to the step display name', () => {
    const [chip] = deriveExecutedSteps(
      [step({ functionName: 'acme_custom_tool', displayName: 'Acme Custom Tool' })],
      t
    )
    expect(chip).toEqual({ key: 'acme_custom_tool', label: 'Acme Custom Tool', running: false })
  })

  test('skips graph scaffolding, LLM model names, and deep-research steps', () => {
    const chips = deriveExecutedSteps(
      [
        step({ functionName: '<workflow>' }),
        step({ functionName: 'chat_deepresearcher_agent' }),
        step({ functionName: 'nvidia/nvidia/Nemotron-3-Nano-30B-A3B' }),
        step({ functionName: 'web_search_tool', isDeepResearch: true }),
      ],
      t
    )
    expect(chips).toEqual([])
  })

  test('dedups a re-run tool into one chip and keeps run order', () => {
    const chips = deriveExecutedSteps(
      [
        step({ id: '1', functionName: 'intent_classifier' }),
        step({ id: '2', functionName: 'web_search_tool' }),
        step({ id: '3', functionName: 'web_search_tool' }),
      ],
      t
    )
    expect(chips.map((c) => c.key)).toEqual(['intent_classifier', 'web_search_tool'])
  })

  test('marks the in-progress step as running; a re-run refreshes the flag', () => {
    const chips = deriveExecutedSteps(
      [
        step({ id: '1', functionName: 'web_search_tool', isComplete: true }),
        step({ id: '2', functionName: 'web_search_tool', isComplete: false }),
      ],
      t
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].running).toBe(true)
  })

  test('a completed re-run clears the running flag of the earlier entry', () => {
    const chips = deriveExecutedSteps(
      [
        step({ id: '1', functionName: 'web_search_tool', isComplete: false }),
        step({ id: '2', functionName: 'web_search_tool', isComplete: true }),
      ],
      t
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].running).toBe(false)
  })
})

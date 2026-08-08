/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { getDisplayName } from './intermediate-step-parser'

describe('getDisplayName', () => {
  test('relabels the shallow node neutrally as "Assistant"', () => {
    // The shallow node doubles as the conversational assistant (greetings,
    // capability questions, memory) — the raw title-cased "Shallow Research
    // Agent" mislabels a simple greeting as a research run. It must read
    // neutrally for every turn that node handles.
    expect(getDisplayName('shallow_research_agent')).toBe('Assistant')
    expect(getDisplayName('shallow_research')).toBe('Assistant')
    expect(getDisplayName('shallow_research_agent')).not.toContain('Research')
  })

  test('keeps the existing special-case labels', () => {
    expect(getDisplayName('chat_deepresearcher_agent')).toBe('Chat Researcher')
    expect(getDisplayName('<workflow>')).toBe('Workflow')
  })

  test('still title-cases other function names', () => {
    expect(getDisplayName('intent_classifier')).toBe('Intent Classifier')
    expect(getDisplayName('web_search_tool')).toBe('Web Search Tool')
  })

  test('humanizes LLM model names by their last path segment', () => {
    expect(getDisplayName('google/gemini-3.6-flash')).toBe('Gemini 3.6 Flash')
  })
})

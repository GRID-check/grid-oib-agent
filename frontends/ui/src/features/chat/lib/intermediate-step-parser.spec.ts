/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { formatPayload, getDisplayName } from './intermediate-step-parser'

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

describe('formatPayload', () => {
  test('decodes each HTML entity exactly once', () => {
    expect(formatPayload('a &lt; b &gt; c &amp; d &quot; e &#39; f')).toBe('a < b > c & d " e \' f')
  })

  test('never re-unescapes an entity that was itself encoded', () => {
    // `&amp;quot;` is a literal `&quot;` after one decode round — it must not
    // become a quote (the js/double-escaping regression this guards against).
    expect(formatPayload('&amp;quot;')).toBe('&quot;')
    expect(formatPayload('&amp;lt;')).toBe('&lt;')
    expect(formatPayload('&amp;amp;')).toBe('&amp;')
  })

  test('still strips Function Input/Output headers and code fences', () => {
    expect(formatPayload('**Function Input:** x')).toBe('x')
    expect(formatPayload('```python\nprint(1)\n```')).toBe('print(1)')
  })
})

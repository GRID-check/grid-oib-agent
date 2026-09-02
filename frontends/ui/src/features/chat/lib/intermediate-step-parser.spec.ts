/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { formatPayload, getDisplayName, getStepLabel } from './intermediate-step-parser'

const tDe = createTranslator(de, 'chat')
const tEn = createTranslator(en, 'chat')

/** A step as the technical panel sees it. */
const step = (functionName: string, displayName?: string) => ({ functionName, displayName })

describe('getStepLabel', () => {
  test('names a known node from the dictionary, in the reader\u2019s locale', () => {
    // The words are this side's job. A label derived from the id can only be
    // English, and this UI is German first — which is how "Use Skill" ended up
    // in front of a German reader.
    expect(getStepLabel(step('knowledge_search'), tDe)).toBe('OIB-Wissen')
    expect(getStepLabel(step('knowledge_search'), tEn)).toBe('OIB knowledge')
    expect(getStepLabel(step('web_search_tool'), tDe)).toBe('Websuche')
    expect(getStepLabel(step('web_search_tool'), tEn)).toBe('Web search')
    expect(getStepLabel(step('<workflow>'), tDe)).toBe('Ablauf')
    expect(getStepLabel(step('chat_deepresearcher_agent'), tDe)).toBe('Ablauf')
  })

  test('reads the same node the same way as the \u201cAusgef\u00fchrt:\u201d chips', () => {
    // Both sides resolve `stepName.*` for a node that earns a chip, so the
    // panel and the chip row cannot word one node two ways.
    expect(getStepLabel(step('web_search_tool'), tDe)).toBe(tDe('thinking.stepName.webSearch'))
    expect(getStepLabel(step('Tool: use_skill'), tDe)).toBe(tDe('thinking.stepName.skillUnnamed'))
  })

  test('the shallow node still reads neutrally as the assistant', () => {
    // It doubles as the conversational assistant (greetings, capability
    // questions, memory) — "Shallow Research Agent" mislabels a bare greeting
    // as a research run.
    expect(getStepLabel(step('shallow_research_agent'), tEn)).toBe('Assistant')
    expect(getStepLabel(step('shallow_research'), tEn)).toBe('Assistant')
    expect(getStepLabel(step('shallow_research_agent'), tDe)).toBe('Assistent')
    expect(getStepLabel(step('shallow_research_agent'), tEn)).not.toContain('Research')
  })

  test('a skill name stays the raw identifier', () => {
    // It is an id, not prose: `skill:oib-brandschutz` must never read
    // "Oib Brandschutz", and never be translated either.
    expect(getStepLabel(step('skill:oib-brandschutz'), tDe)).toBe('oib-brandschutz')
    expect(getStepLabel(step('skill:oib-brandschutz'), tEn)).toBe('oib-brandschutz')
  })

  test('a status slot stays raw in the technical panel', () => {
    // A closed, learnable vocabulary, and the panel is where a power user came
    // to see exactly which slot fired. The reader-facing sentence for the same
    // event is the live line's job.
    expect(getStepLabel(step('status:retrieval:0'), tDe)).toBe('status:retrieval:0')
    expect(getStepLabel(step('status:routing'), tEn)).toBe('status:routing')
  })

  test('an unknown node never shows its internal identifier', () => {
    // NAT forwards LangChain span names verbatim, so a CamelCase class name
    // reaches this function on a normal turn. Neither the class name nor a
    // title-cased id is something a reader can do anything with.
    for (const t of [tDe, tEn]) {
      for (const name of ['ClassificationAssistant', 'RunnableSequence', 'acme_custom_tool']) {
        const label = getStepLabel(step(name), t)
        expect(label).toBe(t('thinking.nodeName.internal'))
        expect(label).not.toContain(name)
      }
    }
    expect(getStepLabel(step('ClassificationAssistant'), tDe)).toBe('Interner Schritt')
  })

  test('an unknown node prefers a name another path deliberately supplied', () => {
    // The deep-research stream names its own rows "<sub-agent> > <model>",
    // which says more than either half alone; the neutral fallback is for rows
    // nobody named, not a way to discard one.
    expect(getStepLabel(step('llm:kimi-k2', 'Planner > Kimi K2'), tDe)).toBe('Planner > Kimi K2')
  })

  test('a stored label from an older build never beats the dictionary', () => {
    // A turn restored from the server carries the label the build that ran it
    // wrote — English, title-cased from the id. The node is known, so it is
    // renamed on the way to the page rather than frozen into the record.
    expect(getStepLabel(step('web_search_tool', 'Web Search Tool'), tDe)).toBe('Websuche')
  })

  test('model names survive as names', () => {
    expect(getStepLabel(step('google/gemini-3.6-flash'), tDe)).toBe('Gemini 3.6 Flash')
    expect(getStepLabel(step('llm:kimi-k2'), tDe)).toBe('Kimi K2')
  })
})

describe('getDisplayName', () => {
  test('keeps the identifiers that are their own label', () => {
    expect(getDisplayName('skill:oib-brandschutz')).toBe('oib-brandschutz')
    expect(getDisplayName('status:retrieval:0')).toBe('status:retrieval:0')
    expect(getDisplayName('google/gemini-3.6-flash')).toBe('Gemini 3.6 Flash')
  })

  test('no longer title-cases an identifier into a name', () => {
    // Empty means "nobody has named this", which `getStepLabel` answers from
    // the dictionary. Persisting "Web Search Tool" (or, for a CamelCase span
    // name, the class name itself) is what put an identifier on the page and
    // froze an English label into every stored turn.
    expect(getDisplayName('web_search_tool')).toBe('')
    expect(getDisplayName('shallow_research_agent')).toBe('')
    expect(getDisplayName('ClassificationAssistant')).toBe('')
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

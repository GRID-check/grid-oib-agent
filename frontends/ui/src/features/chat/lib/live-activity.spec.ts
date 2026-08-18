/**
 * @vitest-environment node
 */
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

  test('an unclassifiable step produces NO phrase — an identifier is not a status', () => {
    // The old behaviour surfaced the step's own display name, so any unknown
    // internal name became a plausible-looking English status line. The caller
    // shows the calm generic instead.
    expect(deriveLiveActivity([step({ functionName: 'xyz', displayName: 'Custom Step' })], t)).toBeNull()
  })

  test('an unphraseable step falls back to the open step that CAN be phrased', () => {
    // Steps nest: the shallow agent is still open while an unnamed sub-call
    // runs. The header holds the parent's meaningful phrase rather than
    // flashing the sub-call's identifier.
    const steps = [
      step({ id: '1', functionName: 'web_search_tool', isComplete: false }),
      step({ id: '2', functionName: 'acme_internal_thing', isComplete: false }),
    ]
    expect(deriveLiveActivity(steps, t)).toBe('thinking.activity.searchingWeb')
  })

  test('graph scaffolding never drives the phrase', () => {
    // `chat_deepresearcher_agent` is the ROOT node of every turn and matches
    // /research/; letting it through announced "Recherche läuft …" over a bare
    // greeting — the same overclaim as the phantom web search.
    expect(deriveLiveActivity([step({ functionName: 'chat_deepresearcher_agent' })], t)).toBeNull()
    expect(deriveLiveActivity([step({ functionName: '<workflow>' })], t)).toBeNull()
  })

  test('the shallow node reads as composing, not as a Recherche', () => {
    // It doubles as the conversational assistant, so /research/ would have
    // called a greeting a research run.
    expect(deriveLiveActivity([step({ functionName: 'shallow_research_agent' })], t)).toBe(
      'thinking.activity.composing'
    )
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
    // change that reintroduces a name-echoing fallback cannot pass by returning
    // a key.
    const interpolate = (key: string) => (key.endsWith('Named') ? '{name} …' : key)
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

/**
 * Skills on the live line.
 *
 * `use_skill` is an ordinary LangChain tool, so `getDisplayName` title-cased it
 * and the German header read "Use Skill …". The per-skill steps replace that
 * with the one fact worth a line: WHICH skill is shaping this answer.
 */
describe('deriveLiveActivity — skills', () => {
  const skillStep = (name: string, payload: Record<string, unknown>) =>
    step({ functionName: `skill:${name}`, displayName: name, content: JSON.stringify(payload) })

  // A translator that really interpolates, so the assertions see the phrase a
  // reader would see rather than a bare key.
  const real = (key: string) =>
    key === 'thinking.activity.usingSkill' ? 'Skill „{name}“ wird angewendet …' : key

  test('an activated skill names itself by its authored title', () => {
    const phrase = deriveLiveActivity(
      [skillStep('oib-brandschutz', { phase: 'activated', name: 'oib-brandschutz', title: 'Brandschutznachweis' })],
      real
    )
    expect(phrase).toBe('Skill „Brandschutznachweis“ wird angewendet …')
  })

  test('with no title the bare identifier is used verbatim, never title-cased', () => {
    const phrase = deriveLiveActivity(
      [skillStep('oib-brandschutz', { phase: 'activated', name: 'oib-brandschutz' })],
      real
    )
    expect(phrase).toBe('Skill „oib-brandschutz“ wird angewendet …')
  })

  test('the loaded phase reuses the SAME line — the load is plumbing, not a second beat', () => {
    const phrase = deriveLiveActivity(
      [skillStep('a', { phase: 'loaded', name: 'a', title: 'Alpha', body_chars: 4096 })],
      real
    )
    expect(phrase).toBe('Skill „Alpha“ wird angewendet …')
    // A byte count is a number the reader cannot act on.
    expect(phrase).not.toContain('4096')
  })

  test('an OFFERED skill is availability and never reaches the live line', () => {
    expect(
      deriveLiveActivity([skillStep('a', { phase: 'offered', name: 'a', description: 'x' })], real)
    ).toBeNull()
  })

  test('skill_selection bookkeeping never reaches the live line', () => {
    expect(
      deriveLiveActivity(
        [
          step({
            functionName: 'skill_selection',
            content: JSON.stringify({ phase: 'offered', offered_count: 6 }),
          }),
        ],
        real
      )
    ).toBeNull()
  })

  test('a filtered skill step falls back to the previous meaningful phrase', () => {
    const steps = [
      step({ id: '1', functionName: 'knowledge_search', isComplete: false }),
      { ...skillStep('a', { phase: 'offered', name: 'a' }), id: '2' },
    ]
    expect(deriveLiveActivity(steps, t)).toBe('thinking.activity.searchingKnowledge')
  })

  test('bare use_skill says a skill is being applied — never the English "Use Skill"', () => {
    const phrase = deriveLiveActivity(
      [step({ functionName: 'use_skill', displayName: getDisplayName('use_skill') })],
      (key) => (key === 'thinking.activity.usingSkillUnnamed' ? 'Skill wird angewendet …' : key)
    )
    expect(phrase).toBe('Skill wird angewendet …')
    expect(phrase).not.toContain('Use Skill')
  })
})

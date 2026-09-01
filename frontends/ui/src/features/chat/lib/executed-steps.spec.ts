/**
 * @vitest-environment node
 */
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

  test('an unlabelled internal function gets no chip — it is not title-cased into work', () => {
    // The display-name fallback is what manufactured the noise: it took any
    // internal name, title-cased it, and presented an identifier as a step the
    // reader could learn something from. The step still appears in the
    // technical steps panel for anyone who opts in — neutrally labelled, never
    // under its internal name.
    expect(
      deriveExecutedSteps(
        [step({ functionName: 'acme_custom_tool', displayName: 'Acme Custom Tool' })],
        t
      )
    ).toEqual([])
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

/**
 * Skill chips.
 *
 * `use_skill` is an ordinary LangChain tool, so before the `skill:` steps
 * existed the chip row said "Use Skill" — English, in a German UI, naming the
 * mechanism rather than the skill — and three activated skills collapsed into
 * one entry because the raw tool name is the same every time. The per-skill
 * steps give each activation its own identity; the label comes from the single
 * authority in `features/skills/lib/skill-activity`.
 */
describe('deriveExecutedSteps — skills', () => {
  const skillStep = (name: string, payload: Record<string, unknown>, over = {}) =>
    step({
      id: `skill-${name}`,
      functionName: `skill:${name}`,
      displayName: name,
      content: JSON.stringify(payload),
      ...over,
    })

  test('an activated skill with a title reads as the title, in proportional text', () => {
    const [chip] = deriveExecutedSteps(
      [skillStep('oib-brandschutz', { phase: 'activated', name: 'oib-brandschutz', title: 'Brandschutznachweis' })],
      t
    )
    expect(chip.label).toBe('thinking.stepName.skill')
    expect(chip.mono).toBeUndefined()
    expect(chip.prefix).toBeUndefined()
  })

  test('an activated skill without a title keeps its bare identifier, in mono', () => {
    const [chip] = deriveExecutedSteps(
      [skillStep('oib-brandschutz', { phase: 'activated', name: 'oib-brandschutz' })],
      t
    )
    expect(chip.mono).toBe('oib-brandschutz')
    // Never title-cased into "Oib Brandschutz".
    expect(chip.mono).not.toMatch(/Oib/)
  })

  test('three activated skills produce three chips, not one', () => {
    const chips = deriveExecutedSteps(
      [
        skillStep('a', { phase: 'activated', name: 'a' }),
        skillStep('b', { phase: 'loaded', name: 'b' }),
        skillStep('c', { phase: 'activated', name: 'c' }),
      ],
      t
    )
    expect(chips.map((c) => c.key)).toEqual(['skill:a', 'skill:b', 'skill:c'])
  })

  test('an OFFERED skill is availability and gets no chip', () => {
    // The same rule that killed the phantom "Websuche": a skill being in the
    // catalogue is not something this turn did.
    expect(
      deriveExecutedSteps([skillStep('a', { phase: 'offered', name: 'a', description: 'x' })], t)
    ).toEqual([])
  })

  test('the round-level skill_selection bookkeeping gets no chip', () => {
    expect(
      deriveExecutedSteps(
        [
          step({
            functionName: 'skill_selection',
            content: JSON.stringify({ phase: 'offered', offered_count: 6, forced_names: [] }),
          }),
        ],
        t
      )
    ).toEqual([])
  })

  test('a skill step with an unreadable payload is dropped rather than guessed at', () => {
    // Without a phase we cannot tell an offer from an activation, and guessing
    // in the direction that overclaims is the bug this whole change removes.
    expect(deriveExecutedSteps([skillStep('a', {} as Record<string, unknown>)], t)).toEqual([])
  })

  test('the phases of one skill arrive under one step name and stay one chip', () => {
    // The store appends each phase's payload to the same step, so `content`
    // holds several JSON objects; the newest phase wins.
    const chips = deriveExecutedSteps(
      [
        step({
          functionName: 'skill:a',
          content:
            JSON.stringify({ phase: 'offered', name: 'a' }) +
            '\n' +
            JSON.stringify({ phase: 'loaded', name: 'a', body_chars: 4096 }),
        }),
      ],
      t
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].mono).toBe('a')
  })

  test('bare use_skill is labelled honestly and unnamed, never "Use Skill"', () => {
    const [chip] = deriveExecutedSteps([step({ functionName: 'use_skill' })], t)
    expect(chip.label).toBe('thinking.stepName.skillUnnamed')
  })

  test('named skill chips supersede the bare use_skill chip — one fact, one chip', () => {
    const chips = deriveExecutedSteps(
      [step({ functionName: 'use_skill' }), skillStep('a', { phase: 'activated', name: 'a' })],
      t
    )
    expect(chips.map((c) => c.key)).toEqual(['skill:a'])
  })
})

/**
 * Status one-liners must not become chips.
 *
 * They are sentences about the turn, and NAT reports them as TOP-LEVEL
 * functions — so without an explicit rule they land here under raw machine
 * names. `status:retrieval:0` is the sharp case: it matches the corpus rule on
 * "retriev" and would render a second, plausible-looking "OIB-Korpus" chip
 * beside the real retrieval tool's own.
 */
describe('deriveExecutedSteps — turn status events', () => {
  const statusStep = (slot: string, payload: Record<string, unknown>) =>
    step({
      id: `status-${slot}`,
      functionName: `status:${slot}`,
      displayName: `status:${slot}`,
      content: JSON.stringify({ kind: 'status', channel: 'live', slot, ...payload }),
    })

  test.each([['routing'], ['retrieval:0'], ['documents'], ['citations'], ['escalation']])(
    'status:%s earns no chip',
    (slot) => {
      expect(
        deriveExecutedSteps([statusStep(slot, { key: 'status.citations', values: {} })], t)
      ).toEqual([])
    }
  )

  test('the retrieval status does not duplicate the tool chip it describes', () => {
    const chips = deriveExecutedSteps(
      [
        statusStep('retrieval:0', {
          key: 'status.retrieval.withQuery',
          values: { corpus: 'knowledge', query: 'GK4' },
          tools: ['knowledge_search'],
        }),
        step({ id: 'tool', functionName: 'knowledge_search_tool' }),
      ],
      t
    )
    expect(chips.map((c) => c.key)).toEqual(['knowledge_search_tool'])
    expect(chips[0].label).toBe('thinking.stepName.corpus')
  })

  describe('one chip per kind of work, not per tool call', () => {
    /**
     * The stakeholder report was „AUSGEFÜHRT: Einordnung, Assistent,
     * OIB-Wissen, OIB-Wissen, OIB-Wissen…" — a word repeated, which reads as a
     * stutter rather than as three tools and tells the reader nothing the first
     * chip had not. The cause was deduplicating on the internal tool NAME while
     * labelling by rule: `ris_search_tool`, `ris_fetch_tool` and
     * `ris_catalog_lookup_tool` are three names for one chip.
     */
    test('renders RIS once, however many RIS tools ran', () => {
      const steps = [
        step({ functionName: 'ris_search_tool' }),
        step({ functionName: 'ris_fetch_tool' }),
        step({ functionName: 'ris_catalog_lookup_tool' }),
      ]

      expect(deriveExecutedSteps(steps, t).map((chip) => chip.label)).toEqual([
        'thinking.stepName.ris',
      ])
    })

    test('renders the corpus once, however many retrieval tools ran', () => {
      const steps = [
        step({ functionName: 'knowledge_search' }),
        step({ functionName: 'knowledge_search' }),
        step({ functionName: 'corpus_retrieve' }),
      ]

      expect(deriveExecutedSteps(steps, t)).toHaveLength(1)
    })

    test('still shows different kinds of work as different chips', () => {
      const steps = [
        step({ functionName: 'intent_classifier' }),
        step({ functionName: 'knowledge_search' }),
        step({ functionName: 'ris_search_tool' }),
        step({ functionName: 'web_search_tool' }),
      ]

      expect(deriveExecutedSteps(steps, t)).toHaveLength(4)
    })

    test('a later tool under one chip still clears the running flag', () => {
      // Steps are newest last, so the completed fetch must un-run the chip the
      // in-progress search raised — otherwise a finished turn keeps a spinner.
      const steps = [
        step({ functionName: 'ris_search_tool', isComplete: false }),
        step({ functionName: 'ris_fetch_tool', isComplete: true }),
      ]

      const chips = deriveExecutedSteps(steps, t)

      expect(chips).toHaveLength(1)
      expect(chips[0]!.running).toBe(false)
    })

    test('and a later tool under one chip can raise it', () => {
      const steps = [
        step({ functionName: 'ris_search_tool', isComplete: true }),
        step({ functionName: 'ris_fetch_tool', isComplete: false }),
      ]

      expect(deriveExecutedSteps(steps, t)[0]!.running).toBe(true)
    })
  })
})

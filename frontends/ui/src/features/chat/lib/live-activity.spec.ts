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
 * Turn events on the live line.
 *
 * The backend states, in German, what it is doing at the moment it does it
 * (`aiq_agent/common/turn_status.py`, `aiq_agent/skills/events.py`). Those
 * sentences carry what the frontend cannot know — the corpus AND the query, the
 * routing reason, a skill's authored title — so once a turn emits any of them
 * they drive the line alone.
 *
 * Wire facts these tests pin, each of which breaks naive handling:
 *   • every event is a balanced START/END pair, so it is COMPLETE on arrival;
 *   • `channel: 'technical'` may never be rendered, and such events carry no
 *     `text` at all, which is the structural half of the same guarantee;
 *   • `loaded` follows `activated` under the SAME step name, so taking the
 *     newest payload would blank the line the instant the skill loaded.
 */
describe('deriveLiveActivity — turn events', () => {
  const eventStep = (name: string, ...payloads: Array<Record<string, unknown>>) =>
    step({
      id: name,
      functionName: name,
      displayName: name,
      // Balanced pair: these arrive already finished.
      isComplete: true,
      content: payloads.map((p) => JSON.stringify(p)).join('\n'),
    })

  const status = (slot: string, text: string, extra: Record<string, unknown> = {}) =>
    eventStep(`status:${slot}`, { kind: 'status', channel: 'live', slot, text, ...extra })

  test('a status one-liner speaks even though it is already complete', () => {
    const phrase = deriveLiveActivity(
      [status('retrieval:0', 'Sucht im OIB-Wissen: „Fluchtweglänge GK4“', { tools: ['knowledge_search'] })],
      t
    )
    expect(phrase).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
  })

  test('the newest event wins — the line replaces, it never accumulates', () => {
    const phrase = deriveLiveActivity(
      [
        status('routing', 'Kurzrecherche: Frage betrifft OIB 2'),
        status('retrieval:0', 'Sucht im RIS: „§ 3 BO Wien“'),
        status('citations', 'Belege werden geprüft …'),
      ],
      t
    )
    expect(phrase).toBe('Belege werden geprüft …')
  })

  test('a tool step never overwrites the richer sentence that announced it', () => {
    // `status:retrieval:0` names the corpus AND quotes the query; the
    // `knowledge_search_tool` span opens a moment later and would otherwise
    // replace it with a generic "searching your sources".
    const steps = [
      status('retrieval:0', 'Sucht im OIB-Wissen: „Fluchtweglänge GK4“'),
      step({ id: 'tool', functionName: 'knowledge_search_tool', isComplete: false }),
    ]
    expect(deriveLiveActivity(steps, t)).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
  })

  test('a technical event is never rendered, and carries no text to render', () => {
    const steps = [
      status('routing', 'Kurzrecherche: Frage betrifft OIB 2'),
      eventStep('skill_selection', {
        kind: 'skill',
        channel: 'technical',
        phase: 'offered',
        offered_count: 6,
        forced_names: [],
      }),
    ]
    // Falls back to the newest event that MAY speak.
    expect(deriveLiveActivity(steps, t)).toBe('Kurzrecherche: Frage betrifft OIB 2')
  })

  test('an activated skill says which skill, by its authored title', () => {
    const phrase = deriveLiveActivity(
      [
        eventStep('skill:oib-brandschutznachweis', {
          kind: 'skill',
          channel: 'live',
          phase: 'activated',
          name: 'oib-brandschutznachweis',
          title: 'Brandschutznachweis',
          text: 'Skill „Brandschutznachweis“ wird angewendet',
        }),
      ],
      t
    )
    expect(phrase).toBe('Skill „Brandschutznachweis“ wird angewendet')
  })

  test('the loaded phase does not blank the line it followed', () => {
    // Both phases land on the SAME step name; `loaded` is technical and has no
    // text, so reading only the newest payload would erase the sentence.
    const phrase = deriveLiveActivity(
      [
        eventStep(
          'skill:oib-brandschutznachweis',
          {
            kind: 'skill',
            channel: 'live',
            phase: 'activated',
            name: 'oib-brandschutznachweis',
            title: 'Brandschutznachweis',
            text: 'Skill „Brandschutznachweis“ wird angewendet',
          },
          {
            kind: 'skill',
            channel: 'technical',
            phase: 'loaded',
            name: 'oib-brandschutznachweis',
            title: 'Brandschutznachweis',
            body_chars: 4096,
          }
        ),
      ],
      t
    )
    expect(phrase).toBe('Skill „Brandschutznachweis“ wird angewendet')
    expect(phrase).not.toContain('4096')
  })

  test('a skill activated without an authored title stays silent', () => {
    // An id like `oib-brandschutznachweis-2024` in a status line is worse than
    // silence, and synthesising a title would make a missing name
    // indistinguishable from a real one. The backend marks it technical; we do
    // not second-guess that.
    const steps = [
      eventStep('skill:oib-2024', {
        kind: 'skill',
        channel: 'technical',
        phase: 'activated',
        name: 'oib-2024',
      }),
    ]
    expect(deriveLiveActivity(steps, t)).toBeNull()
  })

  test('the raw wire payload is html-escaped, and the sentence survives it', () => {
    // NAT runs `html.escape(…, quote=False)`, and `&` is not JSON-structural —
    // so `JSON.parse` SUCCEEDS on the escaped form and quietly hands back
    // "Brand &amp; Rauch" as the sentence. `content` has already been decoded
    // once by `formatPayload`; `rawPayload` has not, and is decoded here.
    const wire = JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      text: 'Sucht im OIB-Wissen: „Brand & Rauch“',
    }).replace(/&/g, '&amp;')

    const phrase = deriveLiveActivity(
      [step({ functionName: 'status:retrieval:0', isComplete: true, content: '', rawPayload: wire })],
      t
    )
    expect(phrase).toBe('Sucht im OIB-Wissen: „Brand & Rauch“')
  })

  test('an already-decoded content payload is NOT decoded a second time', () => {
    // `&amp;amp;` on the wire is a literal `&amp;` the sender meant; decoding
    // it twice would collapse it to `&`.
    const decodedOnce = JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      text: 'Sucht nach „&amp; Co“',
    })
    const phrase = deriveLiveActivity(
      [step({ functionName: 'status:retrieval:0', isComplete: true, content: decodedOnce })],
      t
    )
    expect(phrase).toBe('Sucht nach „&amp; Co“')
  })

  test('legacy bare use_skill still says a skill is being applied — never "Use Skill"', () => {
    // No turn events on this turn, so the legacy classification path runs.
    const phrase = deriveLiveActivity(
      [step({ functionName: 'Tool: use_skill', displayName: getDisplayName('Tool: use_skill') })],
      (key) => (key === 'thinking.activity.usingSkillUnnamed' ? 'Skill wird angewendet …' : key)
    )
    expect(phrase).toBe('Skill wird angewendet …')
    expect(phrase).not.toContain('Use Skill')
  })
})

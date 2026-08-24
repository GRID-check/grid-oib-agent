/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
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
/**
 * Turn events on the live line.
 *
 * The newer era: the backend states what it is doing as a stable KEY plus
 * interpolation VALUES, and every word is written on this side, in the reader's
 * locale. These tests run the real dictionaries rather than an echo translator,
 * because the regression they guard — German prose reaching an English reader —
 * is invisible to a translator that returns its key.
 */
describe('deriveLiveActivity — turn events', () => {
  const tDe = createTranslator(de, 'chat')
  const tEn = createTranslator(en, 'chat')

  const eventStep = (name: string, ...payloads: Array<Record<string, unknown>>) =>
    step({
      id: name,
      functionName: name,
      displayName: name,
      // Balanced pair: these arrive already finished.
      isComplete: true,
      content: payloads.map((p) => JSON.stringify(p)).join('\n'),
    })

  const status = (slot: string, key: string, values: Record<string, string> = {}) =>
    eventStep(`status:${slot}`, { kind: 'status', channel: 'live', slot, key, values })

  const activated = {
    kind: 'skill',
    channel: 'live',
    phase: 'activated',
    name: 'oib-brandschutznachweis',
    title: 'Brandschutznachweis',
    key: 'skill.activated',
    values: { skill: 'Brandschutznachweis' },
  }

  test('a status one-liner speaks even though it is already complete', () => {
    const steps = [
      status('retrieval:0', 'status.retrieval.withQuery', {
        corpus: 'knowledge',
        query: 'Fluchtweglänge GK4',
      }),
    ]
    expect(deriveLiveActivity(steps, tDe)).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
    expect(deriveLiveActivity(steps, tEn)).toBe(
      'Searching the OIB knowledge base: “Fluchtweglänge GK4”'
    )
  })

  test('an English reader never sees German — the whole point of the change', () => {
    const steps = [
      status('documents', 'status.documents.archiv'),
      status('routing', 'status.routing.shallow'),
      status('retrieval:0', 'status.retrieval.plain', { corpus: 'ris' }),
      status('citations', 'status.citations'),
      status('escalation', 'status.escalation'),
    ]
    // Walk the turn one event at a time, in both locales.
    const english = steps.map((_, i) => deriveLiveActivity(steps.slice(0, i + 1), tEn))
    expect(english).toEqual([
      'Reviewing documents from the office archive …',
      'Quick lookup: searching the relevant provisions',
      'Searching RIS (Austrian law) …',
      'Checking every citation against the sources …',
      'A quick lookup is not enough — starting deep research',
    ])
    const german = steps.map((_, i) => deriveLiveActivity(steps.slice(0, i + 1), tDe))
    expect(german).toEqual([
      'Unterlagen aus dem Büroarchiv werden gesichtet …',
      'Kurzrecherche: einschlägige Stellen werden gesucht',
      'Sucht im RIS …',
      'Belege werden gegen die Quellen geprüft …',
      'Kurzrecherche reicht nicht — Tiefenrecherche startet',
    ])
  })

  test('the newest event wins — the line replaces, it never accumulates', () => {
    const phrase = deriveLiveActivity(
      [
        status('routing', 'status.routing.shallow'),
        status('retrieval:0', 'status.retrieval.withQuery', { corpus: 'ris', query: '§ 3 BO Wien' }),
        status('citations', 'status.citations'),
      ],
      tDe
    )
    expect(phrase).toBe('Belege werden gegen die Quellen geprüft …')
  })

  test('a tool step never overwrites the richer sentence that announced it', () => {
    // `status:retrieval:0` names the corpus AND quotes the query; the
    // `knowledge_search_tool` span opens a moment later and would otherwise
    // replace it with a generic "searching your sources".
    const steps = [
      status('retrieval:0', 'status.retrieval.withQuery', {
        corpus: 'knowledge',
        query: 'Fluchtweglänge GK4',
      }),
      step({ id: 'tool', functionName: 'knowledge_search_tool', isComplete: false }),
    ]
    expect(deriveLiveActivity(steps, tDe)).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
  })

  test('a technical event is never rendered, and carries no key to render', () => {
    const steps = [
      status('routing', 'status.routing.shallow'),
      eventStep('skill_selection', {
        kind: 'skill',
        channel: 'technical',
        phase: 'offered',
        offered_count: 6,
        forced_names: [],
      }),
    ]
    // Falls back to the newest event that MAY speak.
    expect(deriveLiveActivity(steps, tDe)).toBe('Kurzrecherche: einschlägige Stellen werden gesucht')
  })

  test('an unknown key falls back to the previous phrase, never to the key', () => {
    // The specific failure this guards: a backend one release ahead adds a
    // slot, and the live line prints `status.somethingNew` at the reader.
    const steps = [
      status('routing', 'status.routing.shallow'),
      status('somethingNew', 'status.somethingNew'),
    ]
    expect(deriveLiveActivity(steps, tEn)).toBe('Quick lookup: searching the relevant provisions')
    // And with nothing older to fall back to, the caller's generic copy wins.
    expect(deriveLiveActivity([status('somethingNew', 'status.somethingNew')], tEn)).toBeNull()
  })

  test('an activated skill says which skill, by its authored title', () => {
    const steps = [eventStep('skill:oib-brandschutznachweis', activated)]
    expect(deriveLiveActivity(steps, tDe)).toBe('Skill „Brandschutznachweis“ wird angewendet')
    expect(deriveLiveActivity(steps, tEn)).toBe('Applying the “Brandschutznachweis” skill')
  })

  test('the loaded phase does not blank the line it followed', () => {
    // Both phases land on the SAME step name; `loaded` is technical and has no
    // key, so reading only the newest payload would erase the sentence.
    const phrase = deriveLiveActivity(
      [
        eventStep('skill:oib-brandschutznachweis', activated, {
          kind: 'skill',
          channel: 'technical',
          phase: 'loaded',
          name: 'oib-brandschutznachweis',
          title: 'Brandschutznachweis',
          body_chars: 4096,
        }),
      ],
      tDe
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
    expect(deriveLiveActivity(steps, tDe)).toBeNull()
  })

  test('the raw wire payload is html-escaped, and the query survives it', () => {
    // NAT runs `html.escape(…, quote=False)`, and `&` is not JSON-structural —
    // so `JSON.parse` SUCCEEDS on the escaped form and quietly hands back
    // "Brand &amp; Rauch" as the query. `content` has already been decoded
    // once by `formatPayload`; `rawPayload` has not, and is decoded here.
    const wire = JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Brand & Rauch' },
    }).replace(/&/g, '&amp;')

    const phrase = deriveLiveActivity(
      [step({ functionName: 'status:retrieval:0', isComplete: true, content: '', rawPayload: wire })],
      tDe
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
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: '&amp; Co' },
    })
    const phrase = deriveLiveActivity(
      [step({ functionName: 'status:retrieval:0', isComplete: true, content: decodedOnce })],
      tDe
    )
    expect(phrase).toBe('Sucht im OIB-Wissen: „&amp; Co“')
  })

  test('a pre-key backend still speaks, for one release', () => {
    // Backward compatibility, one-directional: `text` is read and never
    // written. See `turn-events.spec.ts` for the contract.
    const legacy = eventStep('status:citations', {
      kind: 'status',
      channel: 'live',
      slot: 'citations',
      text: 'Belege werden geprüft …',
    })
    expect(deriveLiveActivity([legacy], tEn)).toBe('Belege werden geprüft …')
  })

  test('legacy bare use_skill produces no line at all — never "Use Skill", never "Skill"', () => {
    // No turn events on this turn, so the legacy classification path runs. The
    // frame names the mechanism and cannot name the skill, so there is nothing
    // to say that a reader could act on; the caller shows the generic working
    // copy instead.
    const phrase = deriveLiveActivity(
      [step({ functionName: 'Tool: use_skill', displayName: getDisplayName('Tool: use_skill') })],
      (key) => key
    )
    expect(phrase).toBeNull()
  })

  test('an unnameable skill step lets the enclosing step keep speaking', () => {
    const phrase = deriveLiveActivity(
      [
        step({ functionName: 'knowledge_search' }),
        step({ functionName: 'Tool: use_skill', displayName: getDisplayName('Tool: use_skill') }),
      ],
      tDe
    )
    expect(phrase).toBe('OIB-Wissen wird durchsucht …')
  })
})

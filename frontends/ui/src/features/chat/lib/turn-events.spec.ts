/**
 * @vitest-environment node
 */

/**
 * Turn events — recognition, the live/technical boundary, and WHOSE WORDS.
 *
 * These steps look like ordinary top-level functions to everything upstream
 * (`isFunctionStepName` returns true for `status:retrieval:0`), so if this
 * module fails to recognise them they do not disappear — they surface as raw
 * machine names in the "Ran:" chip row, which is the single most likely way the
 * integration ships looking broken.
 *
 * The other half is newer and is the reason this file changed. The backend
 * ships a stable KEY plus interpolation VALUES; every word on the live line is
 * written on this side, in the locale the reader chose. It previously shipped
 * finished German sentences, which the line rendered verbatim — so these tests
 * assert both locales, because that regression was invisible in one of them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator, getByPath } from '@/i18n/translate'
import { TURN_EVENT_KEYS } from '@/adapters/api/step-event-schemas'
import {
  answerDegradations,
  deepResearchCutoff,
  isStatusStepName,
  isTurnEventStepName,
  researchTruncation,
  stepEventPayload,
  turnEventLiveText,
} from './turn-events'

const tDe = createTranslator(de, 'chat')
const tEn = createTranslator(en, 'chat')

const event = (functionName: string, ...payloads: Array<Record<string, unknown>>) => ({
  functionName,
  content: payloads.map((p) => JSON.stringify(p)).join('\n'),
})

const status = (slot: string, key: string, values: Record<string, string> = {}) =>
  event(`status:${slot}`, { kind: 'status', channel: 'live', slot, key, values })

describe('recognition', () => {
  test.each([
    ['status:routing', true],
    ['status:retrieval:0', true],
    ['status:retrieval:12', true],
    ['status:documents', true],
    ['status:citations', true],
    ['status:escalation', true],
    ['Tool: status:routing', true],
    ['knowledge_search_tool', false],
    ['skill:a', false],
  ])('isStatusStepName(%s) === %s', (name, expected) => {
    expect(isStatusStepName(name)).toBe(expected)
  })

  test('turn events are the status slots plus the skill events', () => {
    expect(isTurnEventStepName('status:routing')).toBe(true)
    expect(isTurnEventStepName('skill:oib-brandschutz')).toBe(true)
    expect(isTurnEventStepName('skill_selection')).toBe(true)
    expect(isTurnEventStepName('web_search_tool')).toBe(false)
    expect(isTurnEventStepName('use_skill')).toBe(false)
  })
})

describe('turnEventLiveText', () => {
  test('a live status is phrased HERE, from key and values', () => {
    // The event carries what the frontend cannot know — which corpus, and the
    // query the model actually sent. The words around them are ours.
    const step = status('retrieval:0', 'status.retrieval.withQuery', {
      corpus: 'knowledge',
      query: 'Fluchtweglänge GK4',
    })
    expect(turnEventLiveText(step, tDe)).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
    expect(turnEventLiveText(step, tEn)).toBe(
      'Searching the OIB knowledge base: “Fluchtweglänge GK4”'
    )
  })

  test('two corpora are joined in the reader\'s language, not the backend\'s', () => {
    // `und` is grammar, and so is the preposition welded onto each name. The
    // wire carries `knowledge,ris` and nothing else.
    const step = status('retrieval:0', 'status.retrieval.plain', { corpus: 'knowledge,ris' })
    expect(turnEventLiveText(step, tDe)).toBe('Sucht im OIB-Wissen und im RIS …')
    expect(turnEventLiveText(step, tEn)).toBe(
      'Searching the OIB knowledge base and RIS (Austrian law) …'
    )
  })

  test('the routing DECISION is phrased; the model\'s reason never reaches the line', () => {
    const step = event('status:routing', {
      kind: 'status',
      channel: 'live',
      slot: 'routing',
      key: 'status.routing.deep',
      values: {},
      // Free-text prose in whatever language the classifier wrote. It travels
      // for the secondary "why this route?" row, which attributes it.
      reason: 'Mehrere klar getrennte Teilfragen.',
    })
    expect(turnEventLiveText(step, tEn)).toBe('Deep research: working through several sources')
    expect(turnEventLiveText(step, tEn)).not.toContain('Teilfragen')
    expect(turnEventLiveText(step, tDe)).toBe('Tiefenrecherche: mehrere Quellen werden geprüft')
  })

  test('a technical event is refused even if it somehow carries a key', () => {
    // `channel` is the contract; the absent `key` is the structural backup.
    // Belt and braces, because a leak here is the phantom-Websuche class of bug.
    expect(
      turnEventLiveText(
        event('status:routing', {
          kind: 'status',
          channel: 'technical',
          slot: 'routing',
          key: 'status.routing.deep',
          values: {},
        }),
        tDe
      )
    ).toBeNull()
  })

  test('an unknown key renders NOTHING — never the key, never an identifier', () => {
    // `createTranslator` returns the KEY on a miss and only warns outside
    // production, so a naive lookup would print `status.somethingNew` on the
    // live line. An earlier bug in this exact area title-cased unknown internal
    // names into plausible-looking English; silence is the only safe answer.
    for (const t of [tDe, tEn]) {
      expect(turnEventLiveText(status('retrieval:0', 'status.somethingNew'), t)).toBeNull()
      expect(turnEventLiveText(status('routing', 'thinking.working'), t)).toBeNull()
      expect(turnEventLiveText(status('routing', ''), t)).toBeNull()
    }
  })

  test('a corpus id we cannot name drops the whole line, not just the slot', () => {
    // A template rendered with an empty `{corpus}` reads as a broken sentence,
    // which is worse than the line the reader was already looking at.
    expect(
      turnEventLiveText(
        status('retrieval:0', 'status.retrieval.plain', { corpus: 'graphdb' }),
        tDe
      )
    ).toBeNull()
    // …and a mixed batch keeps the corpora it does know.
    expect(
      turnEventLiveText(
        status('retrieval:0', 'status.retrieval.plain', { corpus: 'graphdb,ris' }),
        tDe
      )
    ).toBe('Sucht im RIS …')
  })

  test('the catalogue event says nothing — its size is availability', () => {
    expect(
      turnEventLiveText(
        event('skill_selection', {
          kind: 'skill',
          channel: 'technical',
          phase: 'offered',
          offered_count: 6,
          forced_names: ['oib-brandschutz'],
        }),
        tDe
      )
    ).toBeNull()
    // And a number the reader cannot act on never reaches a sentence.
    const citations = event('status:citations', {
      kind: 'status',
      channel: 'live',
      slot: 'citations',
      key: 'status.citations',
      values: {},
      source_count: 17,
    })
    expect(turnEventLiveText(citations, tDe)).toBe('Belege werden gegen die Quellen geprüft …')
    expect(turnEventLiveText(citations, tEn)).toBe('Checking every citation against the sources …')
    expect(turnEventLiveText(citations, tEn)).not.toContain('17')
  })

  test('an ordinary tool step is not a turn event and says nothing here', () => {
    expect(turnEventLiveText(event('knowledge_search_tool', { anything: true }), tDe)).toBeNull()
  })

  test('the adaptor repeats the object under Function Output — still one sentence', () => {
    const payload = {
      kind: 'status',
      channel: 'live',
      slot: 'escalation',
      key: 'status.escalation',
      values: {},
    }
    const step = {
      functionName: 'status:escalation',
      content: `**Function Input:**\n${JSON.stringify(payload)}\n**Function Output:**\n${JSON.stringify(payload)}`,
    }
    expect(turnEventLiveText(step, tDe)).toBe(
      'Kurzrecherche reicht nicht — Tiefenrecherche startet'
    )
  })

  test('a pre-key backend still speaks, for one release', () => {
    // Backward compatibility, one-directional: `text` is read and never
    // written. Blank is worse than a German sentence for the days a deployment
    // takes to roll forward, and the Python side has a test saying it is gone.
    const legacy = event('status:citations', {
      kind: 'status',
      channel: 'live',
      slot: 'citations',
      text: 'Belege werden geprüft …',
    })
    expect(turnEventLiveText(legacy, tEn)).toBe('Belege werden geprüft …')
  })

  test('key beats text wherever a backend sends both', () => {
    const both = event('status:citations', {
      kind: 'status',
      channel: 'live',
      slot: 'citations',
      key: 'status.citations',
      values: {},
      text: 'Belege werden geprüft …',
    })
    expect(turnEventLiveText(both, tEn)).toBe('Checking every citation against the sources …')
  })
})

/**
 * The two halves of the contract, checked against each other.
 *
 * The backend decides which ids exist; this side decides what they say. Either
 * half can be edited alone, and the failure mode is silent — a blank live line
 * in one locale, in production, with nothing anywhere that says why. So the
 * registries are compared directly, and the Python file is the source read.
 */
describe('every key the backend can emit has words in every locale', () => {
  const repoRoot = join(process.cwd(), '..', '..')

  /** The string literals inside a `ALL_*_KEYS: tuple[str, ...] = ( … )` block. */
  const registry = (file: string, constant: string): string[] => {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    const block = source.split(`${constant}: tuple[str, ...] = (`)[1]
    expect(block, `${constant} not found in ${file}`).toBeDefined()
    return [...block.split('\n)')[0].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
  }

  const backendKeys = [
    ...registry('src/aiq_agent/common/turn_status.py', 'ALL_STATUS_KEYS'),
    ...registry('src/aiq_agent/skills/events.py', 'ALL_SKILL_KEYS'),
  ]

  test('the guard is actually reading the backend', () => {
    // A regex that quietly stopped matching would make everything below pass
    // over an empty list.
    expect(backendKeys.length).toBeGreaterThan(10)
    expect(backendKeys).toContain('status.retrieval.withQuery')
    expect(backendKeys).toContain('skill.activated')
  })

  test('this UI declares exactly the keys the backend emits', () => {
    expect(backendKeys.slice().sort()).toEqual(Object.keys(TURN_EVENT_KEYS).sort())
  })

  test.each(['de', 'en'])('%s has a string for every declared key', (locale) => {
    const dictionary = locale === 'de' ? de : en
    const missing = Object.entries(TURN_EVENT_KEYS).filter(
      ([key, prefix]) => typeof getByPath(dictionary, `chat.${prefix}${key}`) !== 'string'
    )
    expect(missing.map(([key]) => key)).toEqual([])
  })

  test.each(['de', 'en'])('%s names every corpus the backend can send', (locale) => {
    const t = locale === 'de' ? tDe : tEn
    // Mirrors `_SEARCH_CORPORA` in `common/turn_status.py`.
    for (const corpus of ['knowledge', 'ris', 'web', 'documents', 'ifc']) {
      const step = status('retrieval:0', 'status.retrieval.plain', { corpus })
      expect(turnEventLiveText(step, t), corpus).toBeTruthy()
    }
  })
})

describe('stepEventPayload — decoded exactly once', () => {
  test('content is taken as-is: formatPayload already decoded it', () => {
    // Decoding again would turn `&amp;amp;` (a literal `&amp;` the sender meant)
    // into `&`.
    expect(stepEventPayload({ functionName: 'status:x', content: '{"a":"&amp; b"}' })).toBe(
      '{"a":"&amp; b"}'
    )
  })

  test('rawPayload is the untouched wire string and IS decoded', () => {
    expect(
      stepEventPayload({ functionName: 'status:x', content: '', rawPayload: '{"a":"&amp; b"}' })
    ).toBe('{"a":"& b"}')
  })

  test('no payload at all is undefined, not an empty parse', () => {
    expect(stepEventPayload({ functionName: 'status:x' })).toBeUndefined()
  })
})

describe('researchTruncation — where a cut-off turn stopped', () => {
  const budget = (extra: Record<string, unknown>) =>
    event('status:budget', { kind: 'status', channel: 'technical', slot: 'budget', ...extra })

  test('a turn with no budget step was never truncated', () => {
    expect(researchTruncation([status('retrieval:0', 'status.retrieval.plain', { corpus: 'knowledge' })])).toBeNull()
  })

  test('the last tool of the shape is where the chain stopped', () => {
    const found = researchTruncation([
      budget({ truncated: true, tools: ['use_skill', 'knowledge_search', 'find_elements', 'light_incidence'] }),
    ])
    expect(found).toEqual({ lastTool: 'light_incidence' })
  })

  test('truncated with no tools at all still reports the truncation', () => {
    // The budget can be gone before the first tool runs. "Truncated, and I
    // cannot name a step" is a true thing to say; inventing one is not.
    expect(researchTruncation([budget({ truncated: true, tools: [] })])).toEqual({})
  })

  test('a budget step that is not a truncation says nothing', () => {
    // The slot is reserved for the record; only `truncated` makes it one.
    expect(researchTruncation([budget({ ceiling: 9, spent: 4 })])).toBeNull()
  })

  test('a non-status step is never mined for one', () => {
    expect(researchTruncation([event('knowledge_search', { slot: 'budget', truncated: true })])).toBeNull()
  })
})

/**
 * The deep researcher's own limits.
 *
 * Both records are technical-channel and both used to be a `logger.warning`
 * beside a `return`: a deep run that ran out of clock or steps, and an answer
 * that shipped in a known-weaker form. From the outside they looked exactly
 * like a complete, grounded answer — which is the whole reason for reading them
 * here rather than leaving them to an operator's log.
 *
 * Note the slot: `budget:deep` is NOT `budget`, and the two derivations must
 * not read each other's records. They are separate slots on the wire precisely
 * because the frontend dedupes steps by name.
 */
describe('deepResearchCutoff — a deep run that stopped early', () => {
  const deepBudget = (extra: Record<string, unknown>) =>
    event('status:budget:deep', {
      kind: 'status',
      channel: 'technical',
      slot: 'budget:deep',
      agent: 'deep',
      ...extra,
    })

  test('a turn with no cutoff record was never cut off', () => {
    expect(deepResearchCutoff([status('citations', 'status.citations')])).toBeNull()
    // The shallow tool-ceiling record is a different fact in a different slot.
    expect(
      deepResearchCutoff([
        event('status:budget', { kind: 'status', channel: 'technical', slot: 'budget', truncated: true }),
      ])
    ).toBeNull()
  })

  test('the wall clock, with the partial report salvaged', () => {
    expect(
      deepResearchCutoff([
        deepBudget({
          truncated: true,
          reason: 'wall_clock',
          salvaged: true,
          source_count: 12,
          report_chars: 4210,
          elapsed_seconds: 486.4,
        }),
      ])
    ).toEqual({
      reason: 'wall_clock',
      salvaged: true,
      sourceCount: 12,
      elapsedSeconds: 486.4,
    })
  })

  test('the step limit, with nothing salvaged', () => {
    expect(
      deepResearchCutoff([
        deepBudget({ truncated: true, reason: 'step_limit', salvaged: false, source_count: 0, report_chars: 0 }),
      ])
    ).toEqual({ reason: 'step_limit', salvaged: false, sourceCount: 0, elapsedSeconds: undefined })
  })

  test('salvage is strictly `true` — an absent field is not a rescue', () => {
    // The difference decides whether the panel tells the reader the partial
    // findings reached their answer. Guessing in the generous direction is the
    // overclaim this whole area exists to prevent.
    const found = deepResearchCutoff([deepBudget({ truncated: true, reason: 'wall_clock' })])
    expect(found?.salvaged).toBe(false)
  })

  test('a reason token this build does not know becomes null, never the token', () => {
    // Same rule as an unknown turn-event key: THAT it stopped early is true
    // whatever ended it, and a raw token on a reader-facing line is noise.
    const found = deepResearchCutoff([
      deepBudget({ truncated: true, reason: 'quota_exhausted', salvaged: true }),
    ])
    expect(found).toEqual({ reason: null, salvaged: true, sourceCount: undefined, elapsedSeconds: undefined })
  })

  test('the record only counts when it says it is a truncation', () => {
    expect(deepResearchCutoff([deepBudget({ reason: 'wall_clock', salvaged: true })])).toBeNull()
  })

  test('a non-status step carrying the same shape is never mined', () => {
    expect(
      deepResearchCutoff([event('deep_research', { slot: 'budget:deep', truncated: true, reason: 'wall_clock' })])
    ).toBeNull()
  })
})

describe('answerDegradations — an answer weaker than it looks', () => {
  const degraded = (extra: Record<string, unknown>) =>
    event('status:degraded', {
      kind: 'status',
      channel: 'technical',
      slot: 'degraded',
      agent: 'deep',
      ...extra,
    })

  test('no record at all is the ordinary case', () => {
    expect(answerDegradations([status('citations', 'status.citations')])).toEqual([])
  })

  test('both known reasons survive, in the order the backend recorded them', () => {
    expect(
      answerDegradations([degraded({ degraded: true, reasons: ['no_report_file', 'no_valid_citations'] })])
    ).toEqual(['no_report_file', 'no_valid_citations'])
  })

  test('an unknown token is dropped, not surfaced', () => {
    // A caveat line one item shorter beats a caveat line with a raw token on it.
    expect(
      answerDegradations([degraded({ degraded: true, reasons: ['no_report_file', 'sky_fell', 42] })])
    ).toEqual(['no_report_file'])
  })

  test('a repeated reason is stated once', () => {
    expect(
      answerDegradations([degraded({ degraded: true, reasons: ['no_valid_citations', 'no_valid_citations'] })])
    ).toEqual(['no_valid_citations'])
  })

  test('the record only counts when it says the answer degraded', () => {
    expect(answerDegradations([degraded({ reasons: ['no_report_file'] })])).toEqual([])
    expect(answerDegradations([degraded({ degraded: true })])).toEqual([])
  })
})

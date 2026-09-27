/**
 * @vitest-environment node
 */

/**
 * Turn events: the live line, the technical records, and WHOSE WORDS. The backend ships a stable KEY plus interpolation
 * VALUES; every word is written on this side, in the reader's locale — so these
 * tests assert both locales.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator, getByPath } from '@/i18n/translate'
import { fixtureSteps, storedStep } from '@/test-utils/wire-v2-steps'
import { TURN_EVENT_KEYS } from './turn-event-keys'
import { answerDegradations, deepResearchCutoff, liveLine, researchTruncation } from './turn-events'

const tDe = createTranslator(de, 'chat')
const tEn = createTranslator(en, 'chat')

const status = (slot: string, fields: Record<string, unknown> = {}) =>
  storedStep({ id: `status:${slot}`, kind: 'status', slot, ...fields })

const retrieval = (round: number, key: string, values: Record<string, string>, extra = {}) =>
  storedStep({ id: `status:retrieval:${round}`, kind: 'retrieval', round, key, values, ...extra })

const tool = () =>
  storedStep({ id: 'tool:1', kind: 'tool', tool: 'knowledge_search', status: 'ok' })

const technical = (slot: string, detail: Record<string, unknown>) =>
  status(slot, { channel: 'technical', detail })

describe('liveLine', () => {
  test('a live status is phrased HERE, from key and values', () => {
    const steps = [
      retrieval(0, 'status.retrieval.withQuery', {
        corpus: 'knowledge',
        query: 'Fluchtweglänge GK4',
      }),
    ]
    expect(liveLine(steps, tDe)).toBe('Sucht im Wissen: „Fluchtweglänge GK4“')
    expect(liveLine(steps, tEn)).toBe('Searching the knowledge base: “Fluchtweglänge GK4”')
  })

  test("two corpora are joined in the reader's language", () => {
    const steps = [retrieval(0, 'status.retrieval.plain', { corpus: 'knowledge,ris' })]
    expect(liveLine(steps, tDe)).toBe('Sucht im Wissen und im RIS …')
    expect(liveLine(steps, tEn)).toBe('Searching the knowledge base and RIS (Austrian law) …')
  })

  test('the newest phraseable step wins; a technical record says nothing', () => {
    const steps = [
      status('synthesis', { key: 'status.synthesis' }),
      technical('budget', { truncated: true }),
      tool(),
    ]
    expect(liveLine(steps, tDe)).toBe('Antwort wird formuliert …')
  })

  test('an unknown key renders NOTHING — never the key', () => {
    expect(liveLine([status('x', { key: 'status.nope' })], tDe)).toBeNull()
  })

  test('a corpus id we cannot name drops the whole line', () => {
    expect(
      liveLine([retrieval(0, 'status.retrieval.plain', { corpus: 'intranet' })], tDe)
    ).toBeNull()
  })

  test('a skill activation names the authored title', () => {
    const steps = fixtureSteps('turn-answered.jsonl').filter((step) => step.kind === 'skill')
    expect(liveLine(steps, tDe)).toContain('Brandschutznachweis')
  })
})

describe('every key the backend can emit has words in every locale', () => {
  const repoRoot = join(process.cwd(), '..', '..')

  /** The string literals inside an `ALL_*_KEYS: tuple[str, ...] = ( … )` block, cut at the first `)`. */
  const registry = (file: string, constant: string): string[] => {
    const source = readFileSync(join(repoRoot, file), 'utf8')
    const block = source.split(`${constant}: tuple[str, ...] = (`)[1]
    expect(block, `${constant} not found in ${file}`).toBeDefined()
    return [...block.split(')')[0].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
  }

  const backendKeys = [
    ...registry('src/aiq_agent/common/turn_status.py', 'ALL_STATUS_KEYS'),
    ...registry('src/aiq_agent/skills/events.py', 'ALL_SKILL_KEYS'),
  ]

  test('the guard is actually reading the backend', () => {
    expect(backendKeys.length).toBeGreaterThan(10)
    expect(backendKeys).toContain('status.retrieval.withQuery')
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
    for (const corpus of ['knowledge', 'ris', 'web', 'documents', 'ifc']) {
      expect(liveLine([retrieval(0, 'status.retrieval.plain', { corpus })], t), corpus).toBeTruthy()
    }
  })
})

describe('researchTruncation', () => {
  test('a turn with no budget record was never truncated', () => {
    expect(researchTruncation(fixtureSteps('turn-answered.jsonl'))).toBeNull()
  })

  test('the last tool of the record is where the chain stopped', () => {
    const steps = [
      technical('budget', { truncated: true, tools: ['knowledge_search', 'ris_search_tool'] }),
    ]
    expect(researchTruncation(steps)).toEqual({ lastTool: 'ris_search_tool' })
  })

  test('the input-token ceiling is a truncation in its own slot', () => {
    expect(researchTruncation([technical('budget:input', { truncated: true })])).toEqual({})
  })

  test('a budget record that is not a truncation says nothing', () => {
    expect(researchTruncation([technical('budget', { spent: 3 })])).toBeNull()
  })
})

describe('deepResearchCutoff', () => {
  test('the wall clock, with the partial report salvaged', () => {
    const steps = [
      technical('budget:deep', {
        truncated: true,
        reason: 'wall_clock',
        salvaged: true,
        source_count: 7,
        elapsed_seconds: 900,
      }),
    ]
    expect(deepResearchCutoff(steps)).toEqual({
      reason: 'wall_clock',
      salvaged: true,
      sourceCount: 7,
      elapsedSeconds: 900,
    })
  })

  test('an unknown reason becomes null and an absent salvage is not one', () => {
    expect(
      deepResearchCutoff([technical('budget:deep', { truncated: true, reason: 'oom' })])
    ).toEqual({
      reason: null,
      salvaged: false,
      sourceCount: undefined,
      elapsedSeconds: undefined,
    })
  })

  test('no record, no cutoff', () => {
    expect(deepResearchCutoff([technical('budget', { truncated: true })])).toBeNull()
  })
})

describe('answerDegradations', () => {
  test('known reasons survive in order, deduped; unknown tokens are dropped', () => {
    const steps = [
      technical('degraded', {
        degraded: true,
        reasons: ['no_valid_citations', 'mystery', 'no_report_file', 'no_valid_citations'],
      }),
    ]
    expect(answerDegradations(steps)).toEqual(['no_valid_citations', 'no_report_file'])
  })

  test('no record is the ordinary case', () => {
    expect(answerDegradations(fixtureSteps('turn-answered.jsonl'))).toEqual([])
  })
})

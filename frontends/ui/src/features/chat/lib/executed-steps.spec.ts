/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { fixtureSteps, storedStep } from '@/test-utils/wire-v2-steps'
import { deriveExecutedSteps, stepNameLabel } from './executed-steps'

// Echo translator: returns the key, except for the skill template.
const t = (key: string) => (key === 'thinking.stepName.skill' ? 'Skill: {name}' : key)

let n = 0
const tool = (name: string, status: 'running' | 'ok' | 'error' = 'ok') =>
  storedStep({ id: `tool:${(n += 1)}`, kind: 'tool', tool: name, status })

const skill = (fields: Record<string, unknown>) =>
  storedStep({ id: `skill:${String(fields.skill ?? 'x')}`, kind: 'skill', ...fields })

describe('stepNameLabel', () => {
  test.each([
    ['web_search_tool', 'thinking.stepName.webSearch'],
    ['advanced_web_search_tool', 'thinking.stepName.webSearch'],
    ['ris_catalog_lookup_tool', 'thinking.stepName.ris'],
    ['knowledge_search', 'thinking.stepName.corpus'],
    // ADR-0094: a settled Herleitung says the chat looked beyond its own project.
    ['project_lookup', 'thinking.stepName.otherProjects'],
    ['read_passage', 'thinking.stepName.reading'],
    ['view_knowledge_image', 'thinking.stepName.drawing'],
    ['write_file', 'thinking.stepName.draft'],
    ['file_draft', 'thinking.stepName.filing'],
    ['set_doc_class', 'thinking.stepName.fileProposal'],
  ])('%s → %s', (name, key) => {
    expect(stepNameLabel(name, t)).toBe(key)
  })

  test('a basename without an entry has no label; nothing is pattern-matched', () => {
    expect(stepNameLabel('ask_user', t)).toBeNull()
    expect(stepNameLabel('my_knowledge_thing', t)).toBeNull()
  })
})

describe('deriveExecutedSteps', () => {
  test('returns nothing for no steps', () => {
    expect(deriveExecutedSteps([], t)).toEqual([])
  })

  test('a recorded turn: the tool and the activated skill, and no status line', () => {
    expect(
      deriveExecutedSteps(fixtureSteps('turn-answered.jsonl'), t).map((chip) => chip.label)
    ).toEqual(['thinking.stepName.corpus', 'Skill: Brandschutznachweis'])
  })

  test('tools of one kind share one chip, in run order', () => {
    const chips = deriveExecutedSteps(
      [
        tool('ris_search_tool'),
        tool('knowledge_search'),
        tool('ris_fetch_tool'),
        tool('write_file'),
      ],
      t
    )
    expect(chips.map((chip) => chip.label)).toEqual([
      'thinking.stepName.ris',
      'thinking.stepName.corpus',
      'thinking.stepName.draft',
    ])
  })

  test('an unlabelled tool gets no chip', () => {
    expect(deriveExecutedSteps([tool('ask_user')], t)).toEqual([])
  })

  test('the newest step under a chip decides whether it is running', () => {
    expect(deriveExecutedSteps([tool('ris_search_tool', 'running')], t)[0].running).toBe(true)
    expect(
      deriveExecutedSteps([tool('ris_search_tool', 'running'), tool('ris_fetch_tool')], t)[0]
        .running
    ).toBe(false)
    expect(
      deriveExecutedSteps([tool('ris_search_tool'), tool('ris_fetch_tool', 'running')], t)[0]
        .running
    ).toBe(true)
  })

  test('deep-research steps get no chip', () => {
    const deep = storedStep({ id: 'tool:d', kind: 'tool', tool: 'web_search_tool', scope: 'deep' })
    expect(deriveExecutedSteps([deep], t)).toEqual([])
  })

  test('an activated skill with a title reads as the title', () => {
    const [chip] = deriveExecutedSteps(
      [skill({ phase: 'activated', skill: 'a', title: 'Brandschutz' })],
      t
    )
    expect(chip).toMatchObject({ label: 'Skill: Brandschutz', skill: true })
    expect(chip.mono).toBeUndefined()
  })

  test('an activated skill without a title keeps its bare identifier, in mono', () => {
    const [chip] = deriveExecutedSteps([skill({ phase: 'activated', skill: 'oib-bsn' })], t)
    expect(chip).toMatchObject({ label: 'Skill: oib-bsn', prefix: 'Skill:', mono: 'oib-bsn' })
  })

  test('offered and hidden skills are availability and get no chip', () => {
    expect(
      deriveExecutedSteps(
        [
          skill({ phase: 'offered', count: 4 }),
          skill({ phase: 'activated', skill: 'h', title: 'H', hidden: true }),
        ],
        t
      )
    ).toEqual([])
  })

  test('two named skills are two chips; loaded after activated stays one', () => {
    const chips = deriveExecutedSteps(
      [
        skill({ phase: 'activated', skill: 'a', title: 'A' }),
        skill({ phase: 'loaded', skill: 'a', title: 'A' }),
        storedStep({ id: 'skill:b', kind: 'skill', phase: 'activated', skill: 'b', title: 'B' }),
      ],
      t
    )
    expect(chips.map((chip) => chip.label)).toEqual(['Skill: A', 'Skill: B'])
  })
})

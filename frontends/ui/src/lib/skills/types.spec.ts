/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { BadRequestError } from '@/lib/api/errors'
import {
  createSkillScheduleSchema,
  createSkillSchema,
  executionOf,
  isSchedulable,
  METADATA_CARDS,
  METADATA_EXECUTION,
  METADATA_SCHEDULABLE,
  patchSkillSchema,
  preferredCardsOf,
  skillNameSchema,
  snapshotOf,
} from './types'

describe('skillNameSchema (agentskills.io name rule)', () => {
  it('accepts lowercase alphanumerics with single internal hyphens', () => {
    expect(skillNameSchema.parse('data-table-analysis')).toBe('data-table-analysis')
    expect(skillNameSchema.parse('a')).toBe('a')
    expect(skillNameSchema.parse('forecast-analysis-2025')).toBe('forecast-analysis-2025')
  })

  it('rejects uppercase, underscores, spaces and edge-hyphens', () => {
    expect(() => skillNameSchema.parse('Data-Table')).toThrow()
    expect(() => skillNameSchema.parse('data_table')).toThrow()
    expect(() => skillNameSchema.parse('-data')).toThrow()
    expect(() => skillNameSchema.parse('data-')).toThrow()
    expect(() => skillNameSchema.parse('data--table')).toThrow()
    expect(() => skillNameSchema.parse('data table')).toThrow()
    expect(() => skillNameSchema.parse('')).toThrow()
  })

  it('enforces the 64-char cap', () => {
    expect(() => skillNameSchema.parse('a'.repeat(65))).toThrow()
    expect(skillNameSchema.parse('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

describe('createSkillSchema / patchSkillSchema', () => {
  const valid = {
    name: 'my-skill',
    description: 'Does the thing.',
    body: '# Skill\n\nDo the thing.',
  }

  it('accepts a valid skill', () => {
    expect(createSkillSchema.parse(valid).name).toBe('my-skill')
  })

  it('rejects a description over 1024 chars and a body over 32000 chars', () => {
    expect(() => createSkillSchema.parse({ ...valid, description: 'x'.repeat(1025) })).toThrow()
    expect(() => createSkillSchema.parse({ ...valid, body: 'x'.repeat(32001) })).toThrow()
  })

  it('rejects non-string metadata values and over-large metadata maps', () => {
    expect(() => createSkillSchema.parse({ ...valid, metadata: { grid: 1 } })).toThrow()
    const big = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']))
    expect(() => createSkillSchema.parse({ ...valid, metadata: big })).toThrow()
  })

  it('patch schema leaves every field optional', () => {
    expect(patchSkillSchema.parse({}).name).toBeUndefined()
    expect(patchSkillSchema.parse({ enabled: false }).enabled).toBe(false)
  })
})

describe('executionOf', () => {
  it('defaults to chat', () => {
    expect(executionOf({})).toBe('chat')
    expect(executionOf({ [METADATA_EXECUTION]: 'chat' })).toBe('chat')
    expect(executionOf({ [METADATA_EXECUTION]: 'deep-research' })).toBe('deep-research')
  })

  it('throws BadRequestError for invalid values (deterministic, fail at write time)', () => {
    expect(() => executionOf({ [METADATA_EXECUTION]: 'deep_research' })).toThrow(BadRequestError)
    expect(() => executionOf({ [METADATA_EXECUTION]: 'anything' })).toThrow(BadRequestError)
  })
})

describe('isSchedulable', () => {
  it('is false only for the literal grid-schedulable=false', () => {
    expect(isSchedulable({})).toBe(true)
    expect(isSchedulable({ [METADATA_SCHEDULABLE]: 'true' })).toBe(true)
    expect(isSchedulable({ [METADATA_SCHEDULABLE]: 'false' })).toBe(false)
    expect(isSchedulable({ anything: 'false' })).toBe(true)
  })
})

describe('preferredCardsOf', () => {
  it('parses the comma list, trimming and deduplicating', () => {
    expect(preferredCardsOf({})).toEqual([])
    expect(preferredCardsOf({ [METADATA_CARDS]: '' })).toEqual([])
    expect(preferredCardsOf({ [METADATA_CARDS]: ' summary , legal_basis ' })).toEqual([
      'summary',
      'legal_basis',
    ])
    expect(preferredCardsOf({ [METADATA_CARDS]: 'summary,summary' })).toEqual(['summary'])
  })

  it('drops names the catalogue no longer offers, including system cards', () => {
    expect(
      preferredCardsOf({ [METADATA_CARDS]: 'summary,memory_proposal,gibt_es_nicht' })
    ).toEqual(['summary'])
  })
})

describe('createSkillSchema — grid-cards write boundary', () => {
  const valid = { name: 'my-skill', description: 'Does the thing.', body: 'Do the thing.' }

  it('accepts known card types', () => {
    const parsed = createSkillSchema.parse({
      ...valid,
      metadata: { [METADATA_CARDS]: 'summary,comparison_table' },
    })
    expect(parsed.metadata?.[METADATA_CARDS]).toBe('summary,comparison_table')
  })

  it('rejects unknown card types and system cards', () => {
    expect(() =>
      createSkillSchema.parse({ ...valid, metadata: { [METADATA_CARDS]: 'gibt_es_nicht' } })
    ).toThrow(/gibt_es_nicht/)
    // A real union member, but tool-emitted: the model must never be asked for one.
    expect(() =>
      createSkillSchema.parse({ ...valid, metadata: { [METADATA_CARDS]: 'memory_proposal' } })
    ).toThrow(/memory_proposal/)
    expect(() =>
      patchSkillSchema.parse({ metadata: { [METADATA_CARDS]: 'summary,document_grid' } })
    ).toThrow(/document_grid/)
  })

  it('treats an empty value as no preference rather than an error', () => {
    expect(() => createSkillSchema.parse({ ...valid, metadata: { [METADATA_CARDS]: '' } })).not.toThrow()
  })
})

describe('snapshotOf', () => {
  it('copies every field (defensive copy of metadata)', () => {
    const skill = {
      name: 'a',
      description: 'd',
      body: 'b',
      metadata: {} as Record<string, string>,
      origin: 'platform' as const,
    }
    const snapshot = snapshotOf(skill)
    expect(snapshot).toEqual(skill)
    snapshot.metadata['grid-execution'] = 'deep-research'
    expect(skill.metadata['grid-execution']).toBeUndefined()
  })
})

describe('createSkillScheduleSchema', () => {
  const base = { name: 'Weekly run', skillName: 'data-table-analysis' }

  it('accepts a manual schedule (no cron)', () => {
    expect(createSkillScheduleSchema.parse(base).scheduleCron).toBeUndefined()
  })

  it('rejects an invalid cron and an unknown timezone', () => {
    expect(() => createSkillScheduleSchema.parse({ ...base, scheduleCron: '0 9 * *' })).toThrow()
    expect(() =>
      createSkillScheduleSchema.parse({ ...base, scheduleTimezone: 'Not/AZone' })
    ).toThrow()
  })

  it('accepts a valid 5-field cron with an IANA timezone', () => {
    const parsed = createSkillScheduleSchema.parse({
      ...base,
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'Europe/Vienna',
    })
    expect(parsed.scheduleCron).toBe('0 9 * * 1')
  })
})
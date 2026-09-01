/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  createSkillSchema,
  isAutoInvokeSkill,
  isHiddenSkill,
  METADATA_AUTO_INVOKE,
  METADATA_CARDS,
  METADATA_HIDDEN,
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

describe('preferredCardsOf', () => {
  it('parses the comma list, trimming and deduplicating', () => {
    expect(preferredCardsOf({})).toEqual([])
    expect(preferredCardsOf({ [METADATA_CARDS]: '' })).toEqual([])
    expect(preferredCardsOf({ [METADATA_CARDS]: ' condition_tree , legal_basis ' })).toEqual([
      'condition_tree',
      'legal_basis',
    ])
    expect(preferredCardsOf({ [METADATA_CARDS]: 'condition_tree,condition_tree' })).toEqual([
      'condition_tree',
    ])
  })

  it('drops names the catalogue no longer offers, including system and envelope cards', () => {
    expect(
      preferredCardsOf({ [METADATA_CARDS]: 'condition_tree,memory_proposal,gibt_es_nicht' })
    ).toEqual(['condition_tree'])
    // Envelope shapes are answer fields now, never a card preference.
    expect(preferredCardsOf({ [METADATA_CARDS]: 'summary,verdict_header,callout' })).toEqual([])
  })
})

describe('createSkillSchema — grid-cards write boundary', () => {
  const valid = { name: 'my-skill', description: 'Does the thing.', body: 'Do the thing.' }

  it('accepts known card types', () => {
    const parsed = createSkillSchema.parse({
      ...valid,
      metadata: { [METADATA_CARDS]: 'condition_tree,comparison_table' },
    })
    expect(parsed.metadata?.[METADATA_CARDS]).toBe('condition_tree,comparison_table')
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
    snapshot.metadata['grid-agents'] = 'deep_researcher'
    expect(skill.metadata['grid-agents']).toBeUndefined()
  })
})

describe('isHiddenSkill (grid-hidden)', () => {
  it('reads the truthy tokens case- and whitespace-insensitively', () => {
    for (const token of ['true', '1', 'yes', 'TRUE', '  Yes  ']) {
      expect(isHiddenSkill({ [METADATA_HIDDEN]: token })).toBe(true)
    }
  })

  it('reads absent, falsy and unrecognised values as visible (fail-open)', () => {
    expect(isHiddenSkill({})).toBe(false)
    for (const token of ['false', '0', 'no', '', 'maybe']) {
      expect(isHiddenSkill({ [METADATA_HIDDEN]: token })).toBe(false)
    }
  })
})

describe('isAutoInvokeSkill (grid-auto-invoke)', () => {
  it('reads absent and truthy tokens as on (the default)', () => {
    expect(isAutoInvokeSkill({})).toBe(true)
    for (const token of ['true', '1', 'yes', 'TRUE', '', 'maybe']) {
      expect(isAutoInvokeSkill({ [METADATA_AUTO_INVOKE]: token })).toBe(true)
    }
  })

  it('reads the falsy tokens as off', () => {
    for (const token of ['false', '0', 'no', 'FALSE', '  No  ']) {
      expect(isAutoInvokeSkill({ [METADATA_AUTO_INVOKE]: token })).toBe(false)
    }
  })
})

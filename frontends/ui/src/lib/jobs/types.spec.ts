/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_FOR_OUTPUT,
  createJobSchema,
  KNOWLEDGE_SOURCE_ID,
  MAX_JOB_PROMPT_LENGTH,
  patchJobSchema,
  withAlwaysOnKnowledge,
} from './types'

const base = { name: 'Weekly run', prompt: 'Fasse die Woche zusammen.', output: 'chat' as const }

describe('createJobSchema', () => {
  it('accepts a plain prompt with no skill — a job need not have one', () => {
    const parsed = createJobSchema.parse(base)
    expect(parsed.prompt).toBe('Fasse die Woche zusammen.')
    expect(parsed.skillName).toBeUndefined()
    expect(parsed.scheduleCron).toBeUndefined()
  })

  it('requires a prompt, trims it, and caps its length', () => {
    expect(() => createJobSchema.parse({ ...base, prompt: undefined })).toThrow()
    expect(() => createJobSchema.parse({ ...base, prompt: '   ' })).toThrow()
    expect(createJobSchema.parse({ ...base, prompt: '  hallo  ' }).prompt).toBe('hallo')
    expect(() =>
      createJobSchema.parse({ ...base, prompt: 'x'.repeat(MAX_JOB_PROMPT_LENGTH + 1) })
    ).toThrow()
  })

  it('requires a valid output kind and rejects anything else', () => {
    expect(createJobSchema.parse({ ...base, output: 'deep-research' }).output).toBe('deep-research')
    expect(() => createJobSchema.parse({ ...base, output: 'deep_research' })).toThrow()
    expect(() => createJobSchema.parse({ ...base, output: undefined })).toThrow()
  })

  it('accepts an attached skill name, or an explicit null for none', () => {
    expect(createJobSchema.parse({ ...base, skillName: 'data-table-analysis' }).skillName).toBe(
      'data-table-analysis'
    )
    expect(createJobSchema.parse({ ...base, skillName: null }).skillName).toBeNull()
    // Still the agentskills.io name rule when a name IS given.
    expect(() => createJobSchema.parse({ ...base, skillName: 'Not A Name' })).toThrow()
  })

  it('rejects an invalid cron and an unknown timezone', () => {
    expect(() => createJobSchema.parse({ ...base, scheduleCron: '0 9 * *' })).toThrow()
    expect(() => createJobSchema.parse({ ...base, scheduleTimezone: 'Not/AZone' })).toThrow()
  })

  it('accepts a valid 5-field cron with an IANA timezone', () => {
    const parsed = createJobSchema.parse({
      ...base,
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'Europe/Vienna',
    })
    expect(parsed.scheduleCron).toBe('0 9 * * 1')
  })
})

describe('patchJobSchema', () => {
  it('leaves every field optional', () => {
    expect(patchJobSchema.parse({}).prompt).toBeUndefined()
    expect(patchJobSchema.parse({ enabled: false }).enabled).toBe(false)
  })

  it('distinguishes "leave the skill alone" from "detach it"', () => {
    expect(patchJobSchema.parse({}).skillName).toBeUndefined()
    expect(patchJobSchema.parse({ skillName: null }).skillName).toBeNull()
  })

  it('still rejects an empty prompt when one is given', () => {
    expect(() => patchJobSchema.parse({ prompt: '  ' })).toThrow()
  })
})

describe('AGENT_FOR_OUTPUT', () => {
  it('maps each output kind onto the one agent that runs it', () => {
    // The mirror of `_OUTPUT_AGENT_TYPES` in routes/skills.py, and what the
    // skill picker filters `grid-agents` by.
    expect(AGENT_FOR_OUTPUT).toEqual({
      chat: 'shallow_researcher',
      'deep-research': 'deep_researcher',
    })
  })
})

describe('withAlwaysOnKnowledge', () => {
  it('keeps null (all sources) as null', () => {
    expect(withAlwaysOnKnowledge(null)).toBeNull()
  })

  it('prepends the knowledge source when absent, including for an empty list', () => {
    expect(withAlwaysOnKnowledge([])).toEqual([KNOWLEDGE_SOURCE_ID])
    expect(withAlwaysOnKnowledge(['other'])).toEqual([KNOWLEDGE_SOURCE_ID, 'other'])
  })

  it('returns a COPY when the source is already present, never the caller’s array', () => {
    const input = [KNOWLEDGE_SOURCE_ID, 'other']
    const result = withAlwaysOnKnowledge(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })
})

/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { storedStep } from '@/test-utils/wire-v2-steps'
import { skillActivityOf, skillLabel } from './skill-activity'

describe('skillActivityOf', () => {
  test('reads the skill a stored skill step records', () => {
    const step = storedStep({
      id: 'skill:oib-bsn',
      kind: 'skill',
      phase: 'activated',
      skill: 'oib-bsn',
      title: 'Brandschutznachweis',
    })
    expect(skillActivityOf(step)).toEqual({
      phase: 'activated',
      name: 'oib-bsn',
      title: 'Brandschutznachweis',
      hidden: false,
    })
  })

  test('the per-turn offer carries no name', () => {
    const step = storedStep({ id: 'skill:offered', kind: 'skill', phase: 'offered', count: 3 })
    expect(skillActivityOf(step)).toEqual({ phase: 'offered', hidden: false })
  })

  test('a hidden skill says so', () => {
    const step = storedStep({
      id: 'skill:h',
      kind: 'skill',
      phase: 'loaded',
      skill: 'h',
      hidden: true,
    })
    expect(skillActivityOf(step)?.hidden).toBe(true)
  })

  test('any other kind is not a skill', () => {
    expect(
      skillActivityOf(storedStep({ id: 'tool:1', kind: 'tool', tool: 'use_skill' }))
    ).toBeNull()
  })
})

describe('skillLabel', () => {
  test('an authored title wins, in proportional text', () => {
    expect(skillLabel({ name: 'oib-bsn', title: 'Brandschutznachweis' })).toEqual({
      text: 'Brandschutznachweis',
      mono: false,
    })
  })

  test('a bare identifier falls back to font-mono, never rewritten', () => {
    expect(skillLabel({ name: 'oib_brandschutz-2024' })).toEqual({
      text: 'oib_brandschutz-2024',
      mono: true,
    })
  })

  test('nothing to say means the row is dropped', () => {
    expect(skillLabel({ name: '  ', title: '' })).toBeNull()
    expect(skillLabel(null)).toBeNull()
  })
})

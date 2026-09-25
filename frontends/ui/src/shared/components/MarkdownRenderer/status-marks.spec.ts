import { describe, expect, test } from 'vitest'
import { statusTone } from './status-marks'

describe('statusTone', () => {
  test('a cell that is exactly a status word gets its tone, in German and English', () => {
    expect(statusTone('erfüllt')).toBe('success')
    expect(statusTone('  Nicht   erfüllt ')).toBe('destructive')
    expect(statusTone('teilweise')).toBe('warning')
    expect(statusTone('bedingt')).toBe('info')
    expect(statusTone('Not met')).toBe('destructive')
  })

  test('a sentence that merely contains a status word stays text', () => {
    expect(statusTone('offen bis zur Bauverhandlung')).toBeNull()
    expect(statusTone('R 90')).toBeNull()
    expect(statusTone('')).toBeNull()
  })
})

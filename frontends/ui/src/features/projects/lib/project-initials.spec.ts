import { describe, expect, test } from 'vitest'

import { projectInitials } from './project-initials'

describe('projectInitials', () => {
  test('takes the first letter of the first two words', () => {
    expect(projectInitials('Wohnbau Seestadt Baufeld D12')).toBe('WS')
  })

  test('uses the first two characters of a single-word name', () => {
    expect(projectInitials('Seestadt')).toBe('SE')
  })

  test('keeps German letters', () => {
    expect(projectInitials('Bürohaus Änderung')).toBe('BÄ')
  })

  test('skips punctuation between words', () => {
    expect(projectInitials('Hotel — Semmering')).toBe('HS')
    expect(projectInitials('  Turnsaal-Zubau BG  ')).toBe('TZ')
  })

  test('handles digits as words', () => {
    expect(projectInitials('19 Grinzing')).toBe('1G')
  })

  test('falls back to a dot rather than an empty tile', () => {
    expect(projectInitials('———')).toBe('·')
    expect(projectInitials('')).toBe('·')
  })
})

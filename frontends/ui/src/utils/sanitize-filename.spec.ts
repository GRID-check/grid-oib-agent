import { describe, test, expect } from 'vitest'
import { sanitizeFilename } from './sanitize-filename'

describe('sanitizeFilename', () => {
  test('converts spaces to hyphens and lowercases', () => {
    expect(sanitizeFilename('Market Analysis Report')).toBe('market-analysis-report')
  })

  test('strips invalid filename characters', () => {
    expect(sanitizeFilename('Report: Q1/Q2 <2026>')).toBe('report-q1q2-2026')
  })

  test('collapses consecutive hyphens', () => {
    expect(sanitizeFilename('AI --- Future')).toBe('ai-future')
  })

  test('trims leading and trailing hyphens', () => {
    expect(sanitizeFilename(' - hello - ')).toBe('hello')
  })

  test('returns fallback for empty string', () => {
    expect(sanitizeFilename('')).toBe('report')
  })

  test('returns fallback when only invalid characters remain', () => {
    expect(sanitizeFilename('***???')).toBe('report')
  })

  test('truncates to 100 characters', () => {
    const longTitle = 'a'.repeat(150)
    expect(sanitizeFilename(longTitle)).toHaveLength(100)
  })

  test('handles quotes and pipes', () => {
    expect(sanitizeFilename('"Test" | Report')).toBe('test-report')
  })

  test('handles backslashes', () => {
    expect(sanitizeFilename('path\\to\\report')).toBe('pathtoreport')
  })
})

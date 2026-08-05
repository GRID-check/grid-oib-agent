/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { formatFileSize } from './format-file-size'

describe('formatFileSize', () => {
  test('uses a period decimal separator for English', () => {
    expect(formatFileSize(1536, 'en-US')).toBe('1.5 KB')
  })

  test('uses a comma decimal separator for German', () => {
    expect(formatFileSize(1536, 'de')).toBe('1,5 KB')
  })

  test('scales through units, always keeping one fraction digit', () => {
    expect(formatFileSize(1024, 'en-US')).toBe('1.0 KB')
    expect(formatFileSize(1024 * 1024 * 1.5, 'en-US')).toBe('1.5 MB')
    expect(formatFileSize(1024 * 1024 * 1024 * 2, 'de')).toBe('2,0 GB')
  })

  test('returns 0 B for null / zero', () => {
    expect(formatFileSize(null)).toBe('0 B')
    expect(formatFileSize(0)).toBe('0 B')
  })

  test('omitting the locale still formats (runtime default)', () => {
    expect(formatFileSize(1536)).toMatch(/^1[.,]5 KB$/)
  })
})

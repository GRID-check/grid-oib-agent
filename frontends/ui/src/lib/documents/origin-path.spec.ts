import { describe, expect, it } from 'vitest'
import { normalizeOriginPath, sanitizeOriginPath } from './origin-path'

describe('origin paths', () => {
  it('normalise slashes, control characters and climbing segments alike', () => {
    const raw = '\\\\Server\\Akt/./../Personal\u0007akt/ scan.pdf'
    expect(normalizeOriginPath(raw)).toBe('Server/Akt/Personalakt/scan.pdf')
    expect(sanitizeOriginPath(raw)).toBe('Server/Akt/Personalakt/scan.pdf')
    expect(normalizeOriginPath('  /  ')).toBeNull()
    expect(normalizeOriginPath(null)).toBeNull()
  })

  // The stored label is bounded; the name screening reads the whole path
  // (ADR-0086), so a folder past the cut is still screened.
  it('cut only the stored label, never what the screening reads', () => {
    const deep = `${'a'.repeat(1100)}/Personalunterlagen/scan.pdf`
    expect(sanitizeOriginPath(deep)).toHaveLength(1024)
    expect(sanitizeOriginPath(deep)).not.toContain('Personal')
    expect(normalizeOriginPath(deep)).toBe(deep)
  })
})

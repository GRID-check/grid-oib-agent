/**
 * @vitest-environment node
 *
 * The office's screening on a held mail: names flag, text findings are kinds.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { SUGGESTED_SCREENING_POLICY, type UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { mailScreening, MAX_NAME_STOP_TERMS } from './screening'

describe('mailScreening', () => {
  const screening = mailScreening(SUGGESTED_SCREENING_POLICY)

  it('names the office terms a file or subject name matches, once each', () => {
    expect(screening.nameStops('Honorarnote_Honorar_Mai.pdf')).toEqual(['Honorar'])
    expect(screening.nameStops('Einreichplan.pdf')).toEqual([])
    expect(screening.nameStops('   ')).toEqual([])
  })

  it('finds kinds in the own text, never the matched value', () => {
    const findings = screening.contentFindings('Konto: AT61 1904 3002 3457 3201, danke.')
    expect(findings).toEqual(['iban'])
    expect(JSON.stringify(findings)).not.toContain('AT61')
  })

  it('finds nothing when the office switched screening off', () => {
    const off: UploadScreeningPolicy = { ...SUGGESTED_SCREENING_POLICY, enabled: false }
    expect(mailScreening(off).nameStops('Honorarnote.pdf')).toEqual([])
    expect(mailScreening(off).contentFindings('AT61 1904 3002 3457 3201')).toEqual([])
  })

  it('keeps at most as many terms as a part may store', () => {
    const many: UploadScreeningPolicy = {
      ...SUGGESTED_SCREENING_POLICY,
      nameTerms: Array.from({ length: 30 }, (_, i) => `Wort${String.fromCharCode(97 + i)}x`),
    }
    const name = many.nameTerms.join('_')
    expect(mailScreening(many).nameStops(name).length).toBeLessThanOrEqual(MAX_NAME_STOP_TERMS)
  })
})

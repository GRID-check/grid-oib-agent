import { describe, expect, it } from 'vitest'
import { redactPii } from './redact-pii'

describe('redactPii', () => {
  it('scrubs email addresses', () => {
    const result = redactPii('Bitte an office@planbau.at melden.')
    expect(result).not.toContain('office@planbau.at')
  })

  it('scrubs Austrian phone-shaped digit runs (the library only knows US formats)', () => {
    const result = redactPii('Rückruf unter +43 664 123 45 67 bitte.')
    expect(result).not.toContain('664 123 45 67')
  })

  it('scrubs IBANs', () => {
    const result = redactPii('Konto AT611904300234573201 wurde belastet.')
    expect(result).not.toContain('AT611904300234573201')
  })

  it('scrubs credential keywords through the end of their line, in German too', () => {
    const result = redactPii('erste Zeile\npasswort: hunter2 xyz\nletzte Zeile')
    expect(result).not.toContain('hunter2')
    expect(result).toContain('erste Zeile')
    expect(result).toContain('letzte Zeile')
  })

  it('scrubs Austrian ID keywords', () => {
    const result = redactPii('Meine Sozialversicherungsnummer lautet 1234 010180.')
    expect(result).not.toContain('1234 010180')
  })

  it('leaves ordinary German feedback text intact', () => {
    const text = 'Die Antwort zitiert die falsche OIB-Richtlinie für Fluchtwege.'
    expect(redactPii(text)).toBe(text)
  })
})

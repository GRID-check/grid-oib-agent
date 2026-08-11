/**
 * The shared transliteration, tested where it lives rather than three times
 * over in the surfaces that slug with it.
 *
 * It exists because three of those surfaces had grown a private copy and the
 * copies disagreed — the newest had no table at all, so a BCF export of
 * `Beispielstraße` downloaded as `Beispielstra-e`.
 */

import { describe, expect, it } from 'vitest'
import { foldDiacritics, latinize, transliterateGerman } from './latinize'

describe('transliterateGerman', () => {
  it('spells the letters Unicode cannot decompose', () => {
    // `ß` has NO decomposition, which is the whole reason a table is needed:
    // NFKD leaves it intact for a later `[^A-Za-z0-9]` pass to destroy.
    expect(transliterateGerman('Beispielstraße')).toBe('Beispielstrasse')
    expect(transliterateGerman('Grünanger Höfe')).toBe('Gruenanger Hoefe')
    expect(transliterateGerman('Außenwand')).toBe('Aussenwand')
  })

  it('keeps case, because a filename does', () => {
    // `Öbb` must not become `OEbb`; the uppercase forms are separate entries
    // for exactly this.
    expect(transliterateGerman('ÖBB Ärztezentrum')).toBe('OeBB Aerztezentrum')
    expect(transliterateGerman('Über')).toBe('Ueber')
  })

  it('matches a decomposed umlaut too', () => {
    // What a macOS filesystem hands over. Without the NFC pass the table sees
    // no `ü` at all and the caller silently falls through to a bare `u`.
    expect(transliterateGerman('Grünanger'.normalize('NFD'))).toBe('Gruenanger')
  })

  it('leaves every other accent for the generic pass', () => {
    // Not this function's job: a per-language table is the thing this design
    // avoids.
    expect(transliterateGerman('Dvořák')).toBe('Dvořák')
  })

  it('handles the capital sharp S', () => {
    expect(transliterateGerman('STRAẞE')).toBe('STRASSE')
  })
})

describe('foldDiacritics', () => {
  it('drops marks whatever language put them there', () => {
    expect(foldDiacritics('Dvořák')).toBe('Dvorak')
    expect(foldDiacritics('Café Frýdek')).toBe('Cafe Frydek')
  })

  it('expands compatibility forms, which is what a filename wants', () => {
    expect(foldDiacritics('ﬁnal')).toBe('final')
  })

  it('cannot spell German, which is why it is not used alone', () => {
    // NFKD reduces `ü` to the wrong word and cannot touch `ß` at all.
    expect(foldDiacritics('Grünanger')).toBe('Grunanger')
    expect(foldDiacritics('Straße')).toBe('Straße')
  })
})

describe('latinize', () => {
  it('spells German and folds the rest, in that order', () => {
    expect(latinize('Beispielstraße 14')).toBe('Beispielstrasse 14')
    expect(latinize('Grünanger')).toBe('Gruenanger')
    expect(latinize('Rezidence Dvořák')).toBe('Rezidence Dvorak')
  })

  it('would lose the German spelling if the order were reversed', () => {
    // Pins the ordering rather than the output: folding first reduces `ü` to
    // `u` and leaves the German table nothing to spell.
    expect(latinize('Grünanger')).not.toBe(transliterateGerman(foldDiacritics('Grünanger')))
  })

  it('passes plain ASCII through untouched', () => {
    expect(latinize('Wohnbau Nord 2026')).toBe('Wohnbau Nord 2026')
  })

  it('leaves a script it cannot latinize alone rather than mangling it', () => {
    // The caller decides what to do with a stem that reduces to nothing; this
    // function does not invent letters.
    expect(latinize('日本橋')).toBe('日本橋')
  })
})

/**
 * @vitest-environment node
 */

/**
 * The naming rules, tested where they live.
 *
 * These four functions decide what every file surface prints and what the
 * rename endpoint will accept, and both the dialog and the service call them —
 * so a change here is a change to the product's behaviour in two tiers at once.
 * Logic in a module, spec'd in milliseconds (see the note on `InputArea.spec`
 * in AGENTS.md).
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_DOCUMENT_NAME_LENGTH,
  composeDocumentName,
  documentDisplayName,
  splitDocumentName,
  validateDocumentName,
} from './display-name'

describe('documentDisplayName', () => {
  it('shows the rename when there is one', () => {
    expect(documentDisplayName({ filename: 'plan.pdf', displayName: 'Einreichplan.pdf' })).toBe(
      'Einreichplan.pdf'
    )
  })

  it('falls back to the file name when there is none', () => {
    expect(documentDisplayName({ filename: 'plan.pdf', displayName: null })).toBe('plan.pdf')
    expect(documentDisplayName({ filename: 'plan.pdf' })).toBe('plan.pdf')
  })

  it('treats a blank rename as no rename', () => {
    // A whitespace-only value would otherwise render as a nameless document —
    // the row exists, the label is invisible, and nothing says which file it is.
    expect(documentDisplayName({ filename: 'plan.pdf', displayName: '   ' })).toBe('plan.pdf')
    expect(documentDisplayName({ filename: 'plan.pdf', displayName: '' })).toBe('plan.pdf')
  })
})

describe('splitDocumentName', () => {
  it('separates the stem from the extension', () => {
    expect(splitDocumentName('Grundriss EG.ifc')).toEqual({
      stem: 'Grundriss EG',
      extension: '.ifc',
    })
  })

  it('keeps only the LAST dot as the extension', () => {
    expect(splitDocumentName('plan.v2.final.pdf')).toEqual({
      stem: 'plan.v2.final',
      extension: '.pdf',
    })
  })

  it('is all stem when there is no extension to protect', () => {
    expect(splitDocumentName('README')).toEqual({ stem: 'README', extension: '' })
    // A dotfile's dot starts the name; it is not a format.
    expect(splitDocumentName('.gitignore')).toEqual({ stem: '.gitignore', extension: '' })
    expect(splitDocumentName('trailing.')).toEqual({ stem: 'trailing.', extension: '' })
  })
})

describe('validateDocumentName', () => {
  it('accepts an ordinary name and trims it', () => {
    expect(validateDocumentName('  Einreichplan EG.pdf  ')).toEqual({
      ok: true,
      value: 'Einreichplan EG.pdf',
    })
  })

  it('refuses an empty or whitespace-only name', () => {
    expect(validateDocumentName('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateDocumentName('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses a name past the length bound', () => {
    expect(validateDocumentName('a'.repeat(MAX_DOCUMENT_NAME_LENGTH))).toEqual({
      ok: true,
      value: 'a'.repeat(MAX_DOCUMENT_NAME_LENGTH),
    })
    expect(validateDocumentName('a'.repeat(MAX_DOCUMENT_NAME_LENGTH + 1))).toEqual({
      ok: false,
      reason: 'tooLong',
    })
  })

  it('refuses path separators and control characters', () => {
    expect(validateDocumentName('plans/EG.pdf')).toEqual({ ok: false, reason: 'invalidCharacters' })
    expect(validateDocumentName('plans\\EG.pdf')).toEqual({ ok: false, reason: 'invalidCharacters' })
    // The newline a paste out of a PDF brings with it.
    expect(validateDocumentName('Einreichplan\nEG.pdf')).toEqual({
      ok: false,
      reason: 'invalidCharacters',
    })
  })

  it('accepts the umlauts and dashes an Austrian file name actually has', () => {
    expect(validateDocumentName('Grundriss OG1 – Gebäude Süd.pdf')).toEqual({
      ok: true,
      value: 'Grundriss OG1 – Gebäude Süd.pdf',
    })
  })
})

describe('composeDocumentName', () => {
  it('puts the original extension back on the edited stem', () => {
    expect(composeDocumentName('Einreichplan', 'plan.pdf')).toBe('Einreichplan.pdf')
  })

  it('does not double an extension the typist re-typed', () => {
    expect(composeDocumentName('Einreichplan.pdf', 'plan.pdf')).toBe('Einreichplan.pdf')
    // Same claim about the bytes, different case.
    expect(composeDocumentName('Einreichplan.PDF', 'plan.pdf')).toBe('Einreichplan.PDF')
  })

  it('adds nothing when the original had no extension', () => {
    expect(composeDocumentName('Notes', 'README')).toBe('Notes')
  })

  it('trims the stem before composing', () => {
    expect(composeDocumentName('  Einreichplan  ', 'plan.pdf')).toBe('Einreichplan.pdf')
  })

  it('keeps a model a model', () => {
    // The one that matters most: an `.ifc` renamed through the viewport must
    // still be recognizable as a model by `inferDocumentKind`, which reads the
    // extension.
    expect(composeDocumentName('Haus A – Bestand', 'Haus-A_v3.ifc')).toBe('Haus A – Bestand.ifc')
  })
})

/**
 * The validator's findings, said in the reader's language.
 *
 * Asserted in GERMAN throughout. The English dictionary reads almost exactly
 * like the validator's own hard-coded strings, so an English assertion would
 * pass whether or not the wiring exists — which is the bug this pins: the
 * English message used to be spliced straight into a German sentence.
 */

import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import type { FileUploadConfig } from '@/shared/context'
import { validateFileUpload, type ValidationContext } from '../validation'
import { summarizeValidation } from './validation-messages'

const t = createTranslator(de, 'files')

const context = (overrides: Partial<ValidationContext> = {}): ValidationContext => ({
  existingTotalSize: 0,
  existingFileCount: 0,
  existingFileNames: new Set<string>(),
  durableCorpus: true,
  ...overrides,
})

/** A File of a stated size without allocating the bytes. */
const file = (name: string, size: number): File =>
  Object.defineProperty(new File(['x'], name, { type: 'application/pdf' }), 'size', { value: size })

const config: FileUploadConfig = {
  acceptedTypes: '.pdf,.docx',
  acceptedMimeTypes: ['application/pdf'],
  maxTotalSizeMB: 100,
  maxFileSize: 50 * 1024 * 1024,
  maxIfcFileSize: 0,
  maxTotalSize: 100 * 1024 * 1024,
  maxFileCount: 10,
  fileExpirationCheckIntervalHours: 0,
}

describe('summarizeValidation', () => {
  it('names an oversized file entirely in the reader’s language', () => {
    const result = validateFileUpload([file('Plan.pdf', 210 * 1024 * 1024)], context(), config, 'de')

    const summary = summarizeValidation(result, t)
    expect(summary).toContain('das Limit liegt bei')
    // The validator's own English is what used to reach the reader.
    expect(summary).not.toMatch(/exceeds|limit\b/)
    expect(result.summary).toMatch(/exceeds/)
  })

  it('names an unsupported type, with the types that are accepted', () => {
    const result = validateFileUpload([file('modell.dwg', 1_000)], context(), config, 'de')

    const summary = summarizeValidation(result, t)
    expect(summary).toContain('kein unterstützter Dateityp')
    expect(summary).toContain('.pdf,.docx')
  })

  it('tells the two duplicate cases apart', () => {
    const twice = validateFileUpload(
      [file('Plan.pdf', 10), file('Plan.pdf', 10)],
      context(),
      config,
      'de'
    )
    expect(summarizeValidation(twice, t)).toContain('mehrfach in dieser Auswahl')

    const already = validateFileUpload(
      [file('Plan.pdf', 10)],
      context({ existingFileNames: new Set(['Plan.pdf']) }),
      config,
      'de'
    )
    expect(summarizeValidation(already, t)).toContain('bereits hinzugefügt')
  })

  it('counts rather than lists once more than one file is rejected', () => {
    const result = validateFileUpload(
      [file('a.dwg', 10), file('b.dwg', 10)],
      context(),
      config,
      'de'
    )
    expect(summarizeValidation(result, t)).toBe('2 Dateien haben Probleme')
  })

  it('says how much room is left when the shelf is already crowded', () => {
    const result = validateFileUpload(
      [file('Plan.pdf', 40 * 1024 * 1024)],
      context({ existingTotalSize: 90 * 1024 * 1024 }),
      config,
      'de'
    )
    const summary = summarizeValidation(result, t)
    expect(summary).toContain('frei sind nur')
    expect(summary).not.toMatch(/available|limit\./)
  })

  it('is null when nothing was rejected', () => {
    const result = validateFileUpload([file('Plan.pdf', 10)], context(), config, 'de')
    expect(summarizeValidation(result, t)).toBeNull()
  })
})

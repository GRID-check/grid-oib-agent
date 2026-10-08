import { describe, expect, test } from 'vitest'
import { insertTranscript } from './insert-transcript'

describe('insertTranscript', () => {
  test('fills an empty composer', () => {
    expect(insertTranscript('', 'Prüf das Stiegenhaus.', null)).toEqual({
      value: 'Prüf das Stiegenhaus.',
      caret: 21,
    })
  })

  test('appends with a space when there is no caret', () => {
    expect(insertTranscript('Hallo', 'the fire rating?', null)?.value).toBe('Hallo the fire rating?')
  })

  test('inserts at the caret, spaced from both neighbours', () => {
    const result = insertTranscript('Bitte prüfen.', 'das Stiegenhaus', { start: 5, end: 5 })
    expect(result?.value).toBe('Bitte das Stiegenhaus prüfen.')
    expect(result?.caret).toBe('Bitte das Stiegenhaus'.length)
  })

  test('abuts closing punctuation without a space', () => {
    expect(insertTranscript('Prüfe ().', 'OIB 2', { start: 7, end: 7 })?.value).toBe('Prüfe (OIB 2).')
  })

  test('never overwrites a selection: the transcript goes after it', () => {
    expect(insertTranscript('Alt Text', 'neu', { start: 0, end: 3 })?.value).toBe('Alt neu Text')
  })

  test('clamps a caret beyond the text to the end', () => {
    expect(insertTranscript('Kurz', 'mehr', { start: 99, end: 99 })?.value).toBe('Kurz mehr')
  })

  test('silence inserts nothing', () => {
    expect(insertTranscript('Unverändert', '   ', { start: 3, end: 3 })).toBeNull()
  })
})

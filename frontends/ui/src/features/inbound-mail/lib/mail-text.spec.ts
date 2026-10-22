/**
 * The held mail's text as the detail shows it: plain, the first lines first,
 * and every URL cut out as an inert run with its domain, never markup.
 */

import { describe, expect, it } from 'vitest'
import { linkDomain, PREVIEW_LINES, textPreview, textRuns, tidyText } from './mail-text'

describe('tidyText', () => {
  it('collapses blank runs and trailing spaces', () => {
    expect(tidyText('a  \r\n\r\n\r\n\nb\n')).toBe('a\n\nb')
  })
})

describe('textPreview', () => {
  it('shows the first lines and says whether more is behind the fold', () => {
    const many = Array.from({ length: PREVIEW_LINES + 3 }, (_, index) => `Zeile ${index}`).join('\n')
    expect(textPreview(many)).toEqual({ head: Array.from({ length: PREVIEW_LINES }, (_, index) => `Zeile ${index}`).join('\n'), more: true })
    expect(textPreview('kurz')).toEqual({ head: 'kurz', more: false })
  })

  it('cuts one long paragraph at a word, so a single line cannot fill the screen', () => {
    const preview = textPreview('Sehr geehrte Damen und Herren, '.repeat(60))
    expect(preview.more).toBe(true)
    expect(preview.head.length).toBeLessThanOrEqual(602)
    expect(preview.head.endsWith(' …')).toBe(true)
    expect(preview.head).not.toMatch(/\S…$/)
  })
})

describe('textRuns', () => {
  it('cuts http(s) URLs out with their domain', () => {
    expect(textRuns('Siehe https://www.cloud.example/s/9fK2 bitte.')).toEqual([
      { kind: 'text', value: 'Siehe ' },
      { kind: 'link', value: 'https://www.cloud.example/s/9fK2', domain: 'cloud.example' },
      { kind: 'text', value: ' bitte.' },
    ])
  })

  it('leaves a javascript: or mailto: text as text', () => {
    expect(textRuns('javascript:alert(1) mailto:a@b.at')).toEqual([{ kind: 'text', value: 'javascript:alert(1) mailto:a@b.at' }])
  })

  it('keeps markup as the text it is', () => {
    expect(textRuns('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', value: '<img src=x onerror=alert(1)>' }])
  })
})

describe('linkDomain', () => {
  it('is null for anything but http(s)', () => {
    expect(linkDomain('ftp://x.at')).toBeNull()
    expect(linkDomain('nonsense')).toBeNull()
    expect(linkDomain('https://ma37.wien.gv.at/x')).toBe('ma37.wien.gv.at')
  })
})

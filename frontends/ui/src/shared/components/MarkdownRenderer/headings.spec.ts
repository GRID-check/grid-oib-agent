import { createElement } from 'react'
import { describe, expect, test } from 'vitest'
import { render } from '@/test-utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import { markdownHeadings } from './headings'

const texts = (markdown: string): string[] => markdownHeadings(markdown).map((h) => h.text)
const ids = (markdown: string): string[] => markdownHeadings(markdown).map((h) => h.id)

describe('markdownHeadings', () => {
  test('lists # to #### headings in document order with their level and line', () => {
    const headings = markdownHeadings(
      [
        '# Brandschutz in Gebäudeklasse 4',
        '',
        'Einleitender Absatz.',
        '## Ausgangslage',
        '### Rechtsgrundlagen',
        '#### Detailfrage',
        '##### Zu tief',
      ].join('\n')
    )

    expect(headings.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, 'Brandschutz in Gebäudeklasse 4', 1],
      [2, 'Ausgangslage', 4],
      [3, 'Rechtsgrundlagen', 5],
      [4, 'Detailfrage', 6],
    ])
  })

  test('returns nothing for markdown without headings, and for no markdown at all', () => {
    expect(markdownHeadings('Ein Absatz ohne jede Überschrift.')).toEqual([])
    expect(markdownHeadings('')).toEqual([])
  })

  test('ignores headings inside fenced code, which the renderer draws as sample text', () => {
    const markdown = [
      '## Quellenformat',
      '```markdown',
      '## Sources',
      '```',
      '~~~',
      '### Auch nicht',
      '~~~',
      '## Danach',
    ].join('\n')

    expect(texts(markdown)).toEqual(['Quellenformat', 'Danach'])
  })

  test('a fence of the other character does not close an open block', () => {
    expect(texts(['~~~', '```', '## Im Codeblock', '```', '~~~', '## Danach'].join('\n'))).toEqual([
      'Danach',
    ])
  })

  test('a repeated heading gets its own id, and the first one keeps the id it had', () => {
    // Unsuffixed, so every link already published against the first
    // occurrence still lands where it landed.
    expect(ids(['## Bewertung', 'Text.', '## Bewertung', '## Bewertung'].join('\n'))).toEqual([
      'bewertung',
      'bewertung-2',
      'bewertung-3',
    ])
  })

  test('a heading whose text already spells a suffix does not steal it', () => {
    expect(ids(['## Bewertung 2', '## Bewertung', '## Bewertung'].join('\n'))).toEqual([
      'bewertung-2',
      'bewertung',
      'bewertung-3',
    ])
  })

  test('every level counts towards the suffix', () => {
    expect(ids(['# Bewertung', '#### Bewertung', '## Bewertung'].join('\n'))).toEqual([
      'bewertung',
      'bewertung-2',
      'bewertung-3',
    ])
  })

  test('a duplicate inside fenced code is sample text and claims no id', () => {
    expect(ids(['## Bewertung', '```', '## Bewertung', '```', '## Bewertung'].join('\n'))).toEqual([
      'bewertung',
      'bewertung-2',
    ])
  })

  test('keeps citation markers in the text, and in the id', () => {
    const [heading] = markdownHeadings('## Wärmedurchgangskoeffizient [1]')
    expect(heading.text).toBe('Wärmedurchgangskoeffizient [1]')
    expect(heading.id).toBe('waermedurchgangskoeffizient-1')
    // `[2][3]` is a claim carried by two sources, not a reference link.
    expect(texts('## Bewertung [2][3]')).toEqual(['Bewertung [2][3]'])
  })

  test('resolves inline markdown to what the reader sees', () => {
    expect(texts('## **Wichtige** _Punkte_ zur `OIB-Richtlinie` ~~alt~~')).toEqual([
      'Wichtige Punkte zur OIB-Richtlinie alt',
    ])
    expect(texts('## Kosten \\* Fläche')).toEqual(['Kosten * Fläche'])
  })

  test('a link contributes its label, never its destination', () => {
    const [heading] = markdownHeadings('## Siehe [OIB 2](https://www.oib.or.at/de/oib-2)')
    expect(heading.text).toBe('Siehe OIB 2')
    expect(heading.id).toBe('siehe-oib-2')
  })

  test('an underscore inside a word is not emphasis and stays in the text', () => {
    const [heading] = markdownHeadings('## Kennwert OIB_2 im Vergleich')
    expect(heading.text).toBe('Kennwert OIB_2 im Vergleich')
    expect(heading.id).toBe('kennwert-oib-2-im-vergleich')
  })

  test('drops the optional closing run of hashes', () => {
    expect(texts('## Zusammenfassung ##')).toEqual(['Zusammenfassung'])
  })

  test('a hash without a space, or indented as code, is not a heading', () => {
    expect(markdownHeadings('##Zusammenfassung')).toEqual([])
    expect(markdownHeadings('    ## Im Codeblock')).toEqual([])
    expect(markdownHeadings('   ## Noch eine Überschrift')).toHaveLength(1)
  })

  test('a heading with no text to anchor is left out', () => {
    expect(texts(['##', '## ***', '## Echt'].join('\n'))).toEqual(['Echt'])
  })

  test('spells German letters out the way the renderer does', () => {
    expect(ids('## Außenwände und Gebäudehülle')).toEqual(['aussenwaende-und-gebaeudehuelle'])
  })
})

/**
 * The contract the pre-pass stands on: every id it assigns is an id the
 * renderer actually put in the document, on its own heading. Asserted against
 * the REAL renderer, so a change to either side that moves an id fails here
 * rather than shipping in-page links that scroll nowhere.
 */
describe('the ids markdownHeadings assigns exist in the rendered document', () => {
  const REPORT = [
    '# Brandschutzanforderungen für Gebäudeklasse 4',
    '',
    'Einleitung mit einem Verweis [1].',
    '',
    '## Ausgangslage und Fragestellung',
    '### Rechtsgrundlagen der OIB-Richtlinie 2',
    '## **Wichtige** _Kennwerte_',
    '### Außenwände und Gebäudehülle',
    '### Kennwert OIB_2 im Vergleich',
    '## Siehe [OIB 2](https://www.oib.or.at/de/oib-2)',
    '## Bewertung [1]',
    '### Außenwände und Gebäudehülle',
    '## Bewertung [1]',
    '',
    '```markdown',
    '## Nicht im Bericht',
    '```',
    '',
    '## Zusammenfassung ##',
  ].join('\n')

  test('each heading resolves to its OWN rendered heading, in document order', () => {
    const headings = markdownHeadings(REPORT)
    expect(headings.length).toBeGreaterThan(6)

    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))
    const resolved = headings.map((h) => container.querySelector(`#${CSS.escape(h.id)}`))

    headings.forEach((heading, index) => {
      const element = resolved[index]
      expect(element, `no rendered heading for #${heading.id}`).not.toBeNull()
      expect(element?.tagName.toLowerCase()).toBe(`h${heading.level}`)
      expect(element?.textContent).toBe(heading.text)
    })
    // Two entries resolving to the SAME element is the duplicate-heading bug.
    expect(new Set(resolved).size).toBe(headings.length)
    const rendered = Array.from(container.querySelectorAll('h1, h2, h3, h4'))
    expect(resolved.map((el) => rendered.indexOf(el as Element))).toEqual(
      resolved.map((_, index) => index)
    )
  })

  test('the repeated section carries two ids, and the fenced example none', () => {
    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))
    const bewertung = markdownHeadings(REPORT).filter((h) => h.text === 'Bewertung [1]')

    expect(bewertung.map((h) => h.id)).toEqual(['bewertung-1', 'bewertung-1-2'])
    expect(container.querySelector('#nicht-im-bericht')).toBeNull()
  })
})

describe('heading extraction is linear in the length of the markdown', () => {
  /**
   * `HTML_TAG_RE` used to spell its attribute run as `(?:\s[^>]*?)?\s*\/?`,
   * where the lazy class and the trailing `\s*` could both match a space. An
   * unterminated tag then backtracked quadratically over markdown written from
   * retrieved documents. The payload sits INSIDE the heading (tag stripping
   * only runs over heading text) and carries a trailing character (the heading
   * pattern trims trailing whitespace first). At this size the defect takes
   * ~1,280ms and the fix ~0.1ms; 400ms is loose for CI and tight for the bug.
   */
  test('an unterminated inline tag in a heading does not blow up the scan', () => {
    const markdown = `## Kennwerte <a ${' '.repeat(40_000)}x\n`

    const started = performance.now()
    const headings = markdownHeadings(markdown)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(400)
    expect(headings).toHaveLength(1)
  })

  test('a heading still loses its inline tags', () => {
    expect(texts('## <b>Kennwerte</b> der <em>Hülle</em>\n')).toEqual(['Kennwerte der Hülle'])
    expect(ids('## <b>Kennwerte</b>')).toEqual(['kennwerte'])
  })

  test('an autolink in a heading is not eaten as a tag', () => {
    expect(texts('## Quelle <https://oib.at>\n')[0]).toContain('https://oib.at')
  })
})

describe('inline HTML in a heading is removed completely', () => {
  /**
   * Removing one tag can COMPLETE another: „<scr<b>ipt>" leaves „<script>"
   * after one pass (CodeQL js/incomplete-multi-character-sanitization). The
   * output is React text and a `[a-z0-9-]` slug, so this is defence in depth.
   */
  test('a tag hidden by another tag does not survive the strip', () => {
    expect(texts('## Kennwerte <scr<b>ipt>alert(1)</scr<b>ipt>\n')[0]).not.toContain('<')
  })

  test('a heading built to outlast the passes still yields no tag', () => {
    expect(texts(`## ${'<a'.repeat(200)}${'>'.repeat(200)}Kennwerte\n`)[0] ?? '').not.toContain(
      '<'
    )
  })

  test('ordinary prose keeps its angle bracket', () => {
    expect(texts('## Wenn a < b gilt\n')).toEqual(['Wenn a < b gilt'])
  })
})

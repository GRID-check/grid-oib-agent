import { createElement } from 'react'
import { describe, expect, test } from 'vitest'
import { render } from '@/test-utils'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import {
  extractReportOutline,
  headingDisplayText,
  reportOutlineEntry,
} from './report-outline'
import { headingAnchorId } from '@/shared/components/MarkdownRenderer/utils'

describe('extractReportOutline', () => {
  test('lists ## and ### headings in document order with their level', () => {
    const outline = extractReportOutline(
      [
        '# Brandschutz in Gebäudeklasse 4',
        '',
        'Einleitender Absatz.',
        '',
        '## Ausgangslage',
        'Text.',
        '### Rechtsgrundlagen',
        'Text.',
        '### Abgrenzung',
        '## Bewertung',
        '#### Detailfrage',
      ].join('\n')
    )

    expect(outline.map((entry) => [entry.level, entry.text])).toEqual([
      [2, 'Ausgangslage'],
      [3, 'Rechtsgrundlagen'],
      [3, 'Abgrenzung'],
      [2, 'Bewertung'],
    ])
  })

  test('returns nothing for a report without headings, and for no report at all', () => {
    expect(extractReportOutline('Ein Absatz ohne jede Überschrift.')).toEqual([])
    expect(extractReportOutline('')).toEqual([])
  })

  test('ignores headings inside fenced code, which the renderer draws as sample text', () => {
    const outline = extractReportOutline(
      [
        '## Quellenformat',
        '',
        '```markdown',
        '## Sources',
        '[1] Titel: https://example.at',
        '```',
        '',
        '~~~',
        '### Auch nicht',
        '~~~',
        '',
        '## Danach',
      ].join('\n')
    )

    expect(outline.map((entry) => entry.text)).toEqual(['Quellenformat', 'Danach'])
  })

  test('a fence of the other character does not close an open block', () => {
    const outline = extractReportOutline(
      ['~~~', '```', '## Im Codeblock', '```', '~~~', '## Danach'].join('\n')
    )

    expect(outline.map((entry) => entry.text)).toEqual(['Danach'])
  })

  test('duplicate heading text keeps the id the renderer assigns, with distinct keys', () => {
    const outline = extractReportOutline(['## Bewertung', 'Text.', '## Bewertung'].join('\n'))

    expect(outline).toHaveLength(2)
    expect(outline[0].id).toBe('bewertung')
    // The renderer derives the id from the text alone, so both headings really
    // do carry `#bewertung` and an anchor lands on the first.
    expect(outline[1].id).toBe('bewertung')
    expect(outline[0].key).not.toBe(outline[1].key)
  })

  test('keeps a citation marker in the heading, and in the id it produces', () => {
    const [entry] = extractReportOutline('## Wärmedurchgangskoeffizient [1]')

    expect(entry.text).toBe('Wärmedurchgangskoeffizient [1]')
    expect(entry.id).toBe('waermedurchgangskoeffizient-1')
  })

  test('resolves inline markdown to what the reader sees', () => {
    expect(
      extractReportOutline('## **Wichtige** _Punkte_ zur `OIB-Richtlinie` ~~alt~~')[0].text
    ).toBe('Wichtige Punkte zur OIB-Richtlinie alt')
  })

  test('a link in a heading contributes its label, never its destination', () => {
    const [entry] = extractReportOutline('## Siehe [OIB 2](https://www.oib.or.at/de/oib-2)')

    expect(entry.text).toBe('Siehe OIB 2')
    expect(entry.id).toBe('siehe-oib-2')
  })

  test('an underscore inside a word is not emphasis and stays in the text', () => {
    const [entry] = extractReportOutline('## Kennwert OIB_2 im Vergleich')

    expect(entry.text).toBe('Kennwert OIB_2 im Vergleich')
    expect(entry.id).toBe('kennwert-oib-2-im-vergleich')
  })

  test('drops the optional closing run of hashes', () => {
    expect(extractReportOutline('## Zusammenfassung ##')[0].text).toBe('Zusammenfassung')
  })

  test('a hash without a space, or indented as code, is not a heading', () => {
    expect(extractReportOutline('##Zusammenfassung')).toEqual([])
    expect(extractReportOutline('    ## Im Codeblock')).toEqual([])
    expect(extractReportOutline('   ## Noch eine Überschrift')).toHaveLength(1)
  })

  test('a heading with no text to anchor is left out', () => {
    expect(extractReportOutline(['##', '## ***', '## Echt'].join('\n')).map((e) => e.text)).toEqual(
      ['Echt']
    )
  })

  test('spells German letters out the way the renderer does', () => {
    expect(extractReportOutline('## Außenwände und Gebäudehülle')[0].id).toBe(
      'aussenwaende-und-gebaeudehuelle'
    )
  })
})

describe('headingDisplayText', () => {
  test('leaves adjacent citation markers alone', () => {
    // `[2][3]` is a claim carried by two sources, not a reference link.
    expect(headingDisplayText('Bewertung [2][3]')).toBe('Bewertung [2][3]')
  })

  test('resolves a backslash escape to the character it protects', () => {
    expect(headingDisplayText('Kosten \\* Fläche')).toBe('Kosten * Fläche')
  })
})

describe('reportOutlineEntry', () => {
  test('refuses text that cannot produce an id', () => {
    expect(reportOutlineEntry('***', 2, 0)).toBeNull()
  })

  test('spells the id the same way the renderer does', () => {
    expect(reportOutlineEntry('Quellen', 2, 7)).toEqual({
      level: 2,
      text: 'Quellen',
      id: headingAnchorId('Quellen'),
      key: '7-quellen',
    })
  })
})

/**
 * The contract this feature stands on: every id the outline links to is an id
 * the renderer actually put in the document. Asserted against the REAL
 * renderer, on the same markdown, so a change to either side that moves an id
 * fails here rather than shipping a list of links that scroll nowhere.
 */
describe('the ids the outline links to exist in the rendered report', () => {
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
    '',
    '```markdown',
    '## Nicht im Bericht',
    '```',
    '',
    '## Zusammenfassung ##',
  ].join('\n')

  test('each entry resolves to a heading carrying its text', () => {
    const outline = extractReportOutline(REPORT)
    expect(outline.length).toBeGreaterThan(6)

    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))

    for (const entry of outline) {
      const heading = container.querySelector(`#${CSS.escape(entry.id)}`)
      expect(heading, `no rendered heading for #${entry.id} ("${entry.text}")`).not.toBeNull()
      expect(heading?.tagName.toLowerCase()).toBe(`h${entry.level}`)
      expect(heading?.textContent).toBe(entry.text)
    }
  })

  test('the fenced example produces no heading and no entry', () => {
    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))

    expect(container.querySelector('#nicht-im-bericht')).toBeNull()
    expect(extractReportOutline(REPORT).map((entry) => entry.text)).not.toContain(
      'Nicht im Bericht'
    )
  })
})

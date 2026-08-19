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

  test('a repeated heading gets its own id, and the first one keeps the id it had', () => {
    const outline = extractReportOutline(
      ['## Bewertung', 'Text.', '## Bewertung', 'Text.', '## Bewertung'].join('\n')
    )

    expect(outline.map((entry) => entry.id)).toEqual([
      // Unsuffixed, so every link already published against the first
      // occurrence still lands where it landed.
      'bewertung',
      'bewertung-2',
      'bewertung-3',
    ])
    expect(new Set(outline.map((entry) => entry.key)).size).toBe(3)
  })

  test('a heading whose text already spells a suffix does not steal it', () => {
    // Without the collision check, the second „Bewertung" and „Bewertung 2"
    // would both be `#bewertung-2` — the bug moved one heading along, not gone.
    const outline = extractReportOutline(
      ['## Bewertung 2', '## Bewertung', '## Bewertung'].join('\n')
    )

    expect(outline.map((entry) => entry.id)).toEqual([
      'bewertung-2',
      'bewertung',
      'bewertung-3',
    ])
  })

  test('a heading of a level the outline does not list still takes its id', () => {
    // The `#` title and the `####` detail are rendered with ids too, so they
    // are counted; the outline just does not offer them.
    const outline = extractReportOutline(
      ['# Bewertung', '#### Bewertung', '## Bewertung'].join('\n')
    )

    expect(outline.map((entry) => [entry.text, entry.id])).toEqual([['Bewertung', 'bewertung-3']])
  })

  test('a duplicate inside fenced code is sample text and claims no id', () => {
    const outline = extractReportOutline(
      ['## Bewertung', '```markdown', '## Bewertung', '```', '## Bewertung'].join('\n')
    )

    expect(outline.map((entry) => entry.id)).toEqual(['bewertung', 'bewertung-2'])
  })

  test('keeps a citation marker in the heading, and in the id it produces', () => {
    const [entry] = extractReportOutline('## Wärmedurchgangskoeffizient [1]')

    expect(entry.text).toBe('Wärmedurchgangskoeffizient [1]')
    expect(entry.id).toBe('waermedurchgangskoeffizient-1')
  })

  test('an inline HTML tag reaches neither the label nor the id', () => {
    // Without `rehype-raw` the renderer drops the tags and shows "Kennwerte",
    // so an id built from `<b>Kennwerte</b>` would be an id no element carries.
    const [entry] = extractReportOutline('## <b>Kennwerte</b>')

    expect(entry.text).toBe('Kennwerte')
    expect(entry.id).toBe('kennwerte')
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
    // The same section title twice, which is the ordinary shape of a report
    // that assesses several variants — and the case that used to give two
    // headings one id.
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

  test('each entry resolves to its OWN heading, in document order', () => {
    // The half of the contract the duplicate case breaks. Every entry
    // resolving is not enough: two entries can both resolve to the SAME
    // element, which is what „## Bewertung" twice used to produce — the second
    // outline row scrolled the reader to the first section and nothing failed.
    const outline = extractReportOutline(REPORT)
    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))

    const resolved = outline.map((entry) => container.querySelector(`#${CSS.escape(entry.id)}`))
    expect(new Set(resolved).size).toBe(outline.length)

    const rendered = Array.from(container.querySelectorAll('h2, h3'))
    expect(resolved.map((heading) => rendered.indexOf(heading as Element))).toEqual(
      resolved.map((_, index) => index)
    )
  })

  test('the repeated section is offered twice, under two ids', () => {
    const bewertung = extractReportOutline(REPORT).filter((entry) => entry.text === 'Bewertung [1]')
    const { container } = render(createElement(MarkdownRenderer, { content: REPORT }))

    expect(bewertung.map((entry) => entry.id)).toEqual(['bewertung-1', 'bewertung-1-2'])
    for (const entry of bewertung) {
      expect(container.querySelector(`#${CSS.escape(entry.id)}`)).not.toBeNull()
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

describe('heading extraction is linear in the length of the markdown', () => {
  /**
   * `HTML_TAG_RE` in `MarkdownRenderer/headings.ts` used to spell its attribute
   * run as `(?:\s[^>]*?)?\s*\/?`, where the lazy class and the trailing `\s*`
   * could both match a space. An unterminated tag then backtracked
   * quadratically, and this scans a whole deep-research report — markdown
   * written from retrieved documents, which is not input we choose.
   *
   * Two things this fixture has to get right, both of which a first draft got
   * wrong while still passing against the defect. The payload must sit INSIDE
   * the heading, because tag stripping only runs over heading text — an
   * unterminated tag on its own line never reaches it. And it needs a trailing
   * character, because the heading pattern's own `[ \t]*$` eats trailing
   * whitespace before the tag pattern is handed the text.
   *
   * The budget is absolute rather than a ratio between two sizes: healthy
   * timings here are microseconds, and a ratio of two sub-millisecond
   * measurements is noise, not signal. At this size the defect takes ~1,280ms
   * and the fix takes ~0.1ms, so 400ms sits three times below the defect and
   * four orders of magnitude above healthy — loose enough for a loaded CI
   * runner, tight enough that quadratic growth cannot hide under it.
   */
  test('an unterminated inline tag in a heading does not blow up the scan', () => {
    const markdown = `## Kennwerte <a ${' '.repeat(40_000)}x\n`

    const started = performance.now()
    const outline = extractReportOutline(markdown)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(400)
    expect(outline).toHaveLength(1)
  })

  test('a heading still loses its inline tags', () => {
    const outline = extractReportOutline('## <b>Kennwerte</b> der <em>Hülle</em>\n')

    expect(outline[0].text).toBe('Kennwerte der Hülle')
  })

  test('an autolink in a heading is not eaten as a tag', () => {
    // The exclusion the single leading `[\s/]` buys: a tag's name is followed by
    // whitespace, a slash or `>`, and an autolink has a colon there. A bare
    // `[^>]*` attribute run is linear too and swallows the whole autolink.
    const outline = extractReportOutline('## Quelle <https://oib.at>\n')

    expect(outline[0].text).toContain('https://oib.at')
  })
})

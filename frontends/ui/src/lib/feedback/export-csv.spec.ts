/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries'
import { feedbackExportRecord, unstoredFeedbackExportRecord } from '@/test-utils/feedback-export-fixtures'
import { FEEDBACK_EXPORT_COLUMNS } from './export-columns'
import { csvValue, renderCsv } from './export-csv'

/** A minimal RFC 4180 reader: every cell is quoted, quotes are doubled. */
function parse(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i += 1
    } else cell += char
  }
  return rows
}

const render = (records = [feedbackExportRecord(), unstoredFeedbackExportRecord()]) =>
  renderCsv(FEEDBACK_EXPORT_COLUMNS, records, de)

describe('the feedback CSV', () => {
  it('starts with a BOM, so Excel opens the umlauts as umlauts', () => {
    expect(render().charCodeAt(0)).toBe(0xfeff)
  })

  it('is headed by the stable keys, in the workbook’s column order, and ends lines with CRLF', () => {
    const text = render()
    const [header] = text.slice(1).split('\r\n')

    expect(header).toBe(FEEDBACK_EXPORT_COLUMNS.map((column) => column.key).join(','))
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('has one record per vote, every one as wide as the header', () => {
    const rows = parse(render().slice(1))
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row).toHaveLength(FEEDBACK_EXPORT_COLUMNS.length)
  })

  it('writes values a script can read without a locale', () => {
    const [header, row] = parse(render().slice(1))
    const cell = (key: string) => row[header.indexOf(key)]

    expect(cell('voted_at')).toBe('2026-10-06T08:17:30.000Z')
    expect(cell('vote_date')).toBe('2026-10-06')
    expect(cell('iso_week')).toBe('2026-W41')
    expect(cell('helpful')).toBe('0')
    expect(cell('vote_changed')).toBe('1')
    expect(cell('topics')).toBe('brandschutz;nutzungssicherheit')
    expect(cell('topic_brandschutz')).toBe('1')
    expect(cell('topic_energie')).toBe('0')
    expect(cell('cost_usd')).toBe('0.183421')
    expect(cell('client_duration_s')).toBe('41.23')
    expect(cell('question')).toBe('Wie lang darf der Fluchtweg in GK 4 sein, und warum?')
  })

  it('leaves what the joins could not reach empty', () => {
    const [header, , unstored] = parse(render().slice(1))
    for (const key of ['answer', 'question', 'llm_calls', 'cost_usd', 'research_truncated', 'app_url']) {
      expect(unstored[header.indexOf(key)], key).toBe('')
    }
  })

  /** A complaint is user text; a spreadsheet must open it as text, not run it. */
  it('neutralises a cell that would open as a formula', () => {
    const text = render([feedbackExportRecord({ question: '=HYPERLINK("https://evil.example","Klick")', comment: '@SUM(A1)' })])
    expect(text).toContain(`"'=HYPERLINK(""https://evil.example"",""Klick"")"`)
    expect(text).toContain(`"'@SUM(A1)"`)
  })

  it('never writes a decimal in scientific notation', () => {
    expect(csvValue(0.0000012, 'usd')).toBe('0.000001')
    expect(csvValue(0, 'usd')).toBe('0')
    expect(csvValue(12.5, 'usd')).toBe('12.5')
    expect(csvValue(2 / 3, 'percent')).toBe('0.6667')
    expect(csvValue(48210, 'integer')).toBe('48210')
  })
})

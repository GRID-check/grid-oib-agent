/**
 * @vitest-environment node
 */

/**
 * The workbook, read back with the same library that wrote it: what a person
 * opening the file would find, sheet by sheet. A snapshot of the bytes would
 * pin the zip's timestamps; these pin what matters — typed cells, the frozen
 * and filterable header, links, the overview's caveats and the dictionary.
 */

import { Workbook, type CellHyperlinkValue, type Worksheet } from 'exceljs'
import { describe, expect, it, vi } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import {
  feedbackExport,
  feedbackExportRecord,
  unstoredFeedbackExportRecord,
} from '@/test-utils/feedback-export-fixtures'
import { FEEDBACK_EXPORT_COLUMNS, FEEDBACK_WEEKLY_COLUMNS } from './export-columns'
import type { FeedbackExport } from './export-service'

vi.mock('server-only', () => ({}))

const { renderFeedbackWorkbook, XLSX_MAX_CELL_CHARS } = await import('./export-workbook')

async function readBack(data: FeedbackExport = feedbackExport(), dictionary = de): Promise<Workbook> {
  const bytes = await renderFeedbackWorkbook(data, dictionary)
  const workbook = new Workbook()
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
  return workbook
}

const columnIndex = (key: string): number => FEEDBACK_EXPORT_COLUMNS.findIndex((column) => column.key === key) + 1

const sheet = (workbook: Workbook, name: string): Worksheet => {
  const found = workbook.getWorksheet(name)
  if (!found) throw new Error(`no sheet ${name}`)
  return found
}

describe('the answer-feedback workbook', () => {
  it('has the four sheets, in reading order, named in the reader’s language', async () => {
    expect((await readBack()).worksheets.map((ws) => ws.name)).toEqual([
      'Bewertungen',
      'Wochen',
      'Übersicht',
      'Spalten',
    ])
    expect((await readBack(feedbackExport(), en)).worksheets.map((ws) => ws.name)).toEqual([
      'Votes',
      'Weeks',
      'Overview',
      'Columns',
    ])
  })

  describe('the votes sheet', () => {
    it('labels every column in the reader’s language, freezes the header and filters it', async () => {
      const votes = sheet(await readBack(), 'Bewertungen')
      const header = votes.getRow(1).values as unknown[]

      expect(header.slice(1)).toEqual(FEEDBACK_EXPORT_COLUMNS.map((column) => column.label(de)))
      expect(header).toContain('Thema: Brandschutz')
      expect(votes.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
      expect(votes.autoFilter).toBeTruthy()
      expect(votes.rowCount).toBe(3)
    })

    it('types its cells: dates as dates, counts and money as numbers, yes/no as 1/0', async () => {
      const row = sheet(await readBack(), 'Bewertungen').getRow(2)

      expect(row.getCell(columnIndex('voted_at')).value).toEqual(new Date('2026-10-06T08:17:30.000Z'))
      expect(row.getCell(columnIndex('vote_date')).value).toEqual(new Date('2026-10-06T00:00:00.000Z'))
      expect(row.getCell(columnIndex('vote_date')).numFmt).toBe('yyyy-mm-dd')
      expect(row.getCell(columnIndex('cost_usd')).value).toBe(0.183421)
      expect(row.getCell(columnIndex('tokens_total')).value).toBe(48_210)
      expect(row.getCell(columnIndex('client_duration_s')).value).toBeCloseTo(41.23)
      expect(row.getCell(columnIndex('helpful')).value).toBe(0)
      expect(row.getCell(columnIndex('vote_changed')).value).toBe(1)
      expect(row.getCell(columnIndex('topic_brandschutz')).value).toBe(1)
      expect(row.getCell(columnIndex('topic_statik')).value).toBe(0)
      expect(row.getCell(columnIndex('reason_label')).value).toBe('Ungenau')
      expect(row.getCell(columnIndex('models')).value).toBe('anthropic/claude-sonnet-4.5; openai/gpt-5-mini')
    })

    it('links the answer in Piloti and its trace in Langfuse', async () => {
      const row = sheet(await readBack(), 'Bewertungen').getRow(2)
      const link = row.getCell(columnIndex('app_url')).value as CellHyperlinkValue

      expect(link.hyperlink).toBe(feedbackExportRecord().appUrl)
      expect(link.text).toBe('In Piloti öffnen')
      expect((row.getCell(columnIndex('langfuse_trace_url')).value as CellHyperlinkValue).hyperlink).toBe(
        feedbackExportRecord().langfuseTraceUrl
      )
    })

    it('leaves what the joins could not reach empty, rather than zero', async () => {
      const row = sheet(await readBack(), 'Bewertungen').getRow(3)

      for (const key of ['answer', 'question', 'cost_usd', 'llm_calls', 'app_url', 'lesson_status', 'reason']) {
        expect(row.getCell(columnIndex(key)).value, key).toBeNull()
      }
      expect(row.getCell(columnIndex('helpful')).value).toBe(1)
    })

    it('writes text that starts like a formula as text, not as a formula', async () => {
      const data = feedbackExport({
        records: [feedbackExportRecord({ question: '=HYPERLINK("https://evil.example","Klick")' })],
      })
      const cell = sheet(await readBack(data), 'Bewertungen').getRow(2).getCell(columnIndex('question'))

      expect(cell.value).toBe('=HYPERLINK("https://evil.example","Klick")')
      expect(cell.formula).toBeUndefined()
    })

    /** Excel refuses a longer cell and reports the whole file as damaged. */
    it(`cuts text at Excel's ${XLSX_MAX_CELL_CHARS} characters and keeps the full length beside it`, async () => {
      const long = 'x'.repeat(XLSX_MAX_CELL_CHARS + 500)
      const data = feedbackExport({ records: [feedbackExportRecord({ answer: long })] })
      const row = sheet(await readBack(data), 'Bewertungen').getRow(2)

      expect(String(row.getCell(columnIndex('answer')).value)).toHaveLength(XLSX_MAX_CELL_CHARS)
      expect(row.getCell(columnIndex('answer_chars')).value).toBe(long.length)
    })
  })

  describe('the weeks sheet', () => {
    it('carries the denominator and the rates, as numbers', async () => {
      const weeks = sheet(await readBack(), 'Wochen')
      const header = (weeks.getRow(1).values as unknown[]).slice(1)
      const row = weeks.getRow(2)

      expect(header).toEqual(FEEDBACK_WEEKLY_COLUMNS.map((column) => column.label(de)))
      expect(row.getCell(5).value).toBe(40) // answers
      expect(row.getCell(6).value).toBe(8) // rated answers
      expect(row.getCell(9).value).toBeCloseTo(6 / 9) // helpful rate
      expect(row.getCell(9).numFmt).toBe('0.0%')
      expect(row.getCell(10).value).toBeCloseTo(8 / 40) // coverage
    })
  })

  describe('the overview sheet', () => {
    const overviewText = async (data: FeedbackExport): Promise<string> => {
      const overview = sheet(await readBack(data), 'Übersicht')
      const lines: string[] = []
      overview.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map(String).join(' | ')))
      return lines.join('\n')
    }

    it('says what the file is: range, scope, filters, totals, the cap and the caveats', async () => {
      const text = await overviewText(feedbackExport())

      expect(text).toContain('Organisationen | alle')
      expect(text).toContain('Projekte | alle')
      expect(text).toContain('Bewertungsfilter | keine')
      expect(text).toContain('Filter im Blatt „Wochen“ | Alle Filter angewendet.')
      expect(text).toContain('Bewertungen | 2')
      expect(text).toContain('Bewertende Personen | 2')
      expect(text).toContain('Zeilenlimit | 5000')
      expect(text).toContain('Zeilenlimit erreicht (neueste Bewertungen behalten) | nein')
      expect(text).toContain('Bewerten ist freiwillig')
      expect(text).toContain('gelöschten Unterhaltung')
    })

    it('lists every filter by name, what the weekly sheet left out and why, and a cut', async () => {
      const text = await overviewText(
        feedbackExport({
          truncated: true,
          query: {
            scope: { from: '2026-10-03', to: '2026-10-09', organizationIds: ['org_2'], projectIds: ['p_1'] },
            ratings: {
              verdict: 'down',
              reasons: ['inaccurate', 'wrong_source'],
              topics: ['schallschutz'],
              modes: ['deep', 'report'],
              confidences: ['low'],
              hasComment: true,
              hasExpectedAnswer: false,
              query: 'Trittschall',
            },
          },
          named: {
            organizations: [{ id: 'org_2', name: 'Ziviltechniker Gruber' }],
            projects: [{ id: 'p_1', name: null }],
          },
          weeksIgnored: ['verdict', 'reasons', 'modes'],
        })
      )

      expect(text).toContain('Organisationen | Ziviltechniker Gruber')
      // A project whose name did not resolve is named by its id, never dropped.
      expect(text).toContain('Projekte | p_1')
      expect(text).toContain(
        'Bewertungsfilter | Urteil: nicht hilfreich · Grund: Ungenau oder Falsche Quelle · Thema: Schallschutz · ' +
          'Antwortmodus: Tiefenrecherche oder Bericht · Konfidenz: Niedrig · nur mit Kommentar · Suche: Trittschall'
      )
      expect(text).toContain('Nicht angewendet: Urteil, Grund, Antwortmodus.')
      expect(text).toContain('Zeilenlimit erreicht (neueste Bewertungen behalten) | ja')
    })
  })

  describe('the columns sheet', () => {
    it('explains every column of both tables, by its CSV key', async () => {
      const columns = sheet(await readBack(), 'Spalten')
      const keys: string[] = []
      columns.eachRow((row, number) => {
        const description = row.getCell(3).value
        if (number > 1 && description) keys.push(String(row.getCell(1).value))
      })

      expect(keys).toEqual([
        ...FEEDBACK_EXPORT_COLUMNS.map((column) => column.key),
        ...FEEDBACK_WEEKLY_COLUMNS.map((column) => column.key),
      ])
    })
  })

  it('renders an export with no votes', async () => {
    const votes = sheet(
      await readBack(feedbackExport({ records: [], weeks: [], totals: null })),
      'Bewertungen'
    )
    expect(votes.rowCount).toBe(1)
  })
})

/** Keeps the fixture honest: the unstored row really is the empty one. */
it('fixture sanity: the unstored vote has no answer', () => {
  expect(unstoredFeedbackExportRecord().answer).toBeNull()
})

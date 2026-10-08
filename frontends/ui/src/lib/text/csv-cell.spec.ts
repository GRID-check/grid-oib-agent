import { describe, expect, it } from 'vitest'
import { csvCell } from './csv-cell'

describe('csvCell', () => {
  it('quotes every cell and doubles embedded quotes (RFC 4180)', () => {
    expect(csvCell('Höchstens 0,35 W/(m²·K), "laut" OIB')).toBe('"Höchstens 0,35 W/(m²·K), ""laut"" OIB"')
  })

  it('renders null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('""')
    expect(csvCell(undefined)).toBe('""')
  })

  it.each(['=HYPERLINK("https://evil.example")', '+1+1', '-2+3', '@SUM(A1:A2)', '\t=1', '\r=1'])(
    'neutralises a formula lead in %j with an apostrophe',
    (text) => {
      const cell = csvCell(text)
      expect(cell.startsWith(`"'`)).toBe(true)
      expect(cell).toBe(`"'${text.replace(/"/g, '""')}"`)
    },
  )

  it('leaves ordinary text, and a formula character later in the text, alone', () => {
    expect(csvCell('GK 4 = 40 m')).toBe('"GK 4 = 40 m"')
    expect(csvCell(12)).toBe('"12"')
  })
})

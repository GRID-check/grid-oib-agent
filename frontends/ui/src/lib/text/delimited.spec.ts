import { describe, it, expect } from 'vitest'
import { parseDelimited, sniffDelimiter } from './delimited'

describe('sniffDelimiter', () => {
  it('picks the semicolon a German Excel export uses', () => {
    // The case this exists for: comma-first reading renders the whole export as
    // one column, which looks like a one-column file rather than a misparse.
    expect(sniffDelimiter('Bauteil;U-Wert;Norm\nAußenwand;0,20;OIB-6\n')).toBe(';')
  })

  it('is not fooled by commas inside a prose column', () => {
    const csv = 'id;note\n1;"a, b, c, d"\n2;"e, f, g, h"\n'
    expect(sniffDelimiter(csv)).toBe(';')
  })

  it('falls back to a comma when nothing divides the text', () => {
    expect(sniffDelimiter('just one column\nand another line\n')).toBe(',')
  })
})

describe('parseDelimited', () => {
  it('reads quoted fields containing the delimiter, newlines and doubled quotes', () => {
    const csv = 'a,b\n"x,y","line1\nline2"\n"he said ""hi""",z\n'
    expect(parseDelimited(csv, { delimiter: ',' }).rows).toEqual([
      ['a', 'b'],
      ['x,y', 'line1\nline2'],
      ['he said "hi"', 'z'],
    ])
  })

  it('strips a BOM instead of welding it to the first header cell', () => {
    const { rows } = parseDelimited('﻿Bauteil,U-Wert\nWand,0.20\n')
    expect(rows[0]).toEqual(['Bauteil', 'U-Wert'])
  })

  it('absorbs CRLF and a trailing newline without inventing an empty row', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('keeps ragged rows rather than refusing the file', () => {
    expect(parseDelimited('a,b,c\n1,2\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
    ])
  })

  it('reports truncation at the row cap, because a silent cut reads as the end of the file', () => {
    const csv = Array.from({ length: 20 }, (_, i) => `${i},x`).join('\n')
    const { rows, truncated } = parseDelimited(csv, { delimiter: ',', maxRows: 5 })
    expect(rows).toHaveLength(5)
    expect(truncated).toBe(true)
  })

  it('does not report truncation for a file that fits', () => {
    expect(parseDelimited('a,b\n1,2\n', { maxRows: 5 }).truncated).toBe(false)
  })

  it('keeps an empty trailing field, which is a real empty cell', () => {
    expect(parseDelimited('a,b,c\n1,,3\n', { delimiter: ',' }).rows[1]).toEqual(['1', '', '3'])
  })
})

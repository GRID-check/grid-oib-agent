/**
 * The alignment, the numbering and the folding — the three things a diff can get
 * wrong while still looking like a diff.
 *
 * The case this file exists for is the one the old side-by-side view refused to
 * fake: a line INSERTED near the top. Every line after it shares no index with
 * its counterpart, and any renderer that pairs rows by position marks the whole
 * remainder as changed. Here it must be one added row and nothing else.
 */

import { describe, expect, it } from 'vitest'
import { DIFF_CONTEXT_LINES, diffVersionText, type DiffRow } from './version-diff'

const texts = (rows: readonly DiffRow[], kind: 'added' | 'removed' | 'context'): string[] =>
  rows.flatMap((row) => (row.kind === kind ? [row.text] : []))

describe('diffVersionText', () => {
  it('reports identical texts as identical, with no rows', () => {
    const diff = diffVersionText('Gebäudeklasse 4\nOIB 2\n', 'Gebäudeklasse 4\nOIB 2\n')

    expect(diff).toEqual({ rows: [], added: 0, removed: 0, identical: true, truncated: false })
  })

  it('marks one inserted line and leaves the rest of the document alone', () => {
    const before = 'eins\nzwei\ndrei\nvier\n'
    const after = 'eins\nEINGEFÜGT\nzwei\ndrei\nvier\n'

    const diff = diffVersionText(before, after)

    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
    expect(texts(diff.rows, 'added')).toEqual(['EINGEFÜGT'])
    expect(texts(diff.rows, 'context')).toEqual(['eins', 'zwei', 'drei', 'vier'])
  })

  it('numbers each side independently, so line numbers stay true after an insert', () => {
    const diff = diffVersionText('eins\nzwei\n', 'eins\nneu\nzwei\n')
    const rows = diff.rows.filter((row) => row.kind !== 'gap')

    expect(rows).toEqual([
      { kind: 'context', text: 'eins', fromLine: 1, toLine: 1 },
      { kind: 'added', text: 'neu', fromLine: null, toLine: 2 },
      { kind: 'context', text: 'zwei', fromLine: 2, toLine: 3 },
    ])
  })

  it('reports a replaced line as one removal and one addition', () => {
    const diff = diffVersionText('Gebäudeklasse 4\n', 'Gebäudeklasse 5\n')

    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(texts(diff.rows, 'removed')).toEqual(['Gebäudeklasse 4'])
    expect(texts(diff.rows, 'added')).toEqual(['Gebäudeklasse 5'])
  })

  it('never invents a trailing blank line from a chunk’s own newline', () => {
    const diff = diffVersionText('eins\n', 'eins\nzwei\n')

    expect(diff.rows.filter((row) => row.kind !== 'gap')).toHaveLength(2)
    expect(texts(diff.rows, 'added')).toEqual(['zwei'])
  })

  it('treats CRLF as the same text — a file that went through Windows is not a rewrite', () => {
    const diff = diffVersionText('eins\r\nzwei\r\n', 'eins\nzwei\n')

    expect(diff.identical).toBe(true)
  })

  it('folds long unchanged runs into one counted gap', () => {
    const filler = Array.from({ length: 40 }, (_, index) => `Zeile ${index + 1}`)
    const before = [...filler, 'Schluss'].join('\n')
    const after = [...filler, 'Schluss, überarbeitet'].join('\n')

    const diff = diffVersionText(before, after)
    const gaps = diff.rows.filter((row) => row.kind === 'gap')

    expect(gaps).toHaveLength(1)
    // 40 unchanged lines, three of which are kept as leading context.
    expect(gaps[0]).toEqual({ kind: 'gap', skipped: 40 - DIFF_CONTEXT_LINES })
    expect(texts(diff.rows, 'context')).toEqual(['Zeile 38', 'Zeile 39', 'Zeile 40'])
  })

  it('keeps context on both sides of a change in the middle', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `Zeile ${index + 1}`)
    const after = [...lines]
    after[14] = 'Zeile 15, überarbeitet'

    const diff = diffVersionText(lines.join('\n'), after.join('\n'))

    expect(texts(diff.rows, 'context')).toEqual([
      'Zeile 12',
      'Zeile 13',
      'Zeile 14',
      'Zeile 16',
      'Zeile 17',
      'Zeile 18',
    ])
    expect(diff.rows.filter((row) => row.kind === 'gap')).toHaveLength(2)
  })

  it('handles an empty older version as a pure addition', () => {
    const diff = diffVersionText('', 'erste Fassung\n')

    expect(diff.removed).toBe(0)
    expect(texts(diff.rows, 'added')).toEqual(['erste Fassung'])
  })

  it('handles an emptied newer version as a pure removal', () => {
    const diff = diffVersionText('war da\n', '')

    expect(diff.added).toBe(0)
    expect(texts(diff.rows, 'removed')).toEqual(['war da'])
  })

  it('caps a very large diff and says so', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `alt ${index}`).join('\n')
    const after = Array.from({ length: 3000 }, (_, index) => `neu ${index}`).join('\n')

    const diff = diffVersionText(before, after)

    expect(diff.truncated).toBe(true)
    expect(diff.rows).toHaveLength(2000)
  })
})

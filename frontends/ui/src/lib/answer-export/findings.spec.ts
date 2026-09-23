import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries'
import { findingsBlocks } from './findings'

const t = (key: string): string =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown>)[part],
      de.answerExport
    ) as string

describe('findingsBlocks', () => {
  it('renders one table with the four columns and one row per finding', () => {
    const blocks = findingsBlocks(
      {
        items: [
          {
            requirement: 'Feuerwiderstand',
            value: 'REI 60',
            status: 'erfuellt',
            grounding: 'belegt',
            reference: { document: 'OIB-RL 2', section: 'Tabelle 1b', page: 12 },
            citations: [1],
          },
          {
            requirement: 'Fluchtweg',
            status: 'offen',
            grounding: 'abgeleitet',
            citations: [],
            comment: 'Fluchtniveau unbekannt.',
          },
        ],
      },
      t
    )
    expect(blocks[0]).toEqual({ kind: 'heading', level: 2, text: 'Befundmatrix' })
    const table = blocks[1]
    expect(table?.kind).toBe('table')
    if (table?.kind !== 'table') throw new Error('expected a table')
    expect(table.head).toEqual(['Anforderung', 'Wert', 'Fundstelle', 'Status'])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]?.[2]?.[0]?.text).toBe('OIB-RL 2 · Tabelle 1b · S. 12 [1]')
    expect(table.rows[1]?.[3]?.[0]?.text).toBe('offen (abgeleitet) — Fluchtniveau unbekannt.')
  })

  it('exports nothing for a payload outside the contract', () => {
    expect(findingsBlocks({ items: [] }, t)).toEqual([])
    expect(findingsBlocks(undefined, t)).toEqual([])
  })
})

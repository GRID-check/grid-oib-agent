import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRevisionSeries, parseRevisionName, revisionLabel } from './revision-series'

/**
 * The cases are shared with the agent's Python parser
 * (`tests/knowledge_layer_tests/test_revision_series.py`): one file, so the folder
 * brief and `list_files` cannot read the same file name differently.
 */
interface Cases {
  parse: { name: string; key: string | null; index: [string, string] | null; date: string | null }[]
  series: {
    files: { id: string; name: string; createdAt: string }[]
    expect: { key: string; current: string; older: string[] }[]
  }[]
}

const cases = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/fixtures/revision_series_cases.json'), 'utf8')
) as Cases

describe('parseRevisionName, on the shared cases', () => {
  it.each(cases.parse)('$name', ({ name, key, index, date }) => {
    const revision = parseRevisionName(name)
    if (key === null) {
      expect(revision).toBeNull()
      return
    }
    expect(revision).not.toBeNull()
    expect(revision?.key).toBe(key)
    expect(revision?.index ? [revision.index.kind, revision.index.value] : null).toEqual(index)
    expect(revision?.date ?? null).toBe(date)
  })
})

describe('findRevisionSeries, on the shared cases', () => {
  it.each(cases.series.map((entry, i) => ({ ...entry, i })))('case $i', ({ files, expect: expected }) => {
    const series = findRevisionSeries(files.map((file) => ({ ...file, filename: file.name })))
    expect(
      series.map((entry) => ({
        key: entry.key.replace(/\.[a-z0-9]+$/, ''),
        current: entry.current.item.id,
        older: entry.older.map((member) => member.item.id),
      }))
    ).toEqual(expected)
  })
})

describe('revisionLabel', () => {
  it('reads as an office writes it', () => {
    expect(revisionLabel(parseRevisionName('EG_Grundriss_Index_C_2026-08-14.pdf')!)).toBe('Index C · 14.08.2026')
    expect(revisionLabel(parseRevisionName('Lageplan_v3.pdf')!)).toBe('v3')
    expect(revisionLabel(parseRevisionName('Ansicht Nord Stand 02.09.2026.pdf')!)).toBe('02.09.2026')
  })
})

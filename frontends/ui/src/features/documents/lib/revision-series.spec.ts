import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPlanSeries, parsePlanName, planRevisionLabel } from './plan-series'

/**
 * The cases are shared with the agent's Python parser
 * (`tests/knowledge_layer_tests/test_plan_series.py`): one file, so the folder
 * brief and `list_files` cannot read the same plan name differently.
 */
interface Cases {
  parse: { name: string; key: string | null; index: [string, string] | null; date: string | null }[]
  series: {
    files: { id: string; name: string; createdAt: string }[]
    expect: { key: string; current: string; older: string[] }[]
  }[]
}

const cases = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/fixtures/plan_series_cases.json'), 'utf8')
) as Cases

describe('parsePlanName, on the shared cases', () => {
  it.each(cases.parse)('$name', ({ name, key, index, date }) => {
    const plan = parsePlanName(name)
    if (key === null) {
      expect(plan).toBeNull()
      return
    }
    expect(plan).not.toBeNull()
    expect(plan?.key).toBe(key)
    expect(plan?.index ? [plan.index.kind, plan.index.value] : null).toEqual(index)
    expect(plan?.date ?? null).toBe(date)
  })
})

describe('findPlanSeries, on the shared cases', () => {
  it.each(cases.series.map((entry, i) => ({ ...entry, i })))('case $i', ({ files, expect: expected }) => {
    const series = findPlanSeries(files.map((file) => ({ ...file, filename: file.name })))
    expect(
      series.map((entry) => ({
        key: entry.key.replace(/\.[a-z0-9]+$/, ''),
        current: entry.current.item.id,
        older: entry.older.map((member) => member.item.id),
      }))
    ).toEqual(expected)
  })
})

describe('planRevisionLabel', () => {
  it('reads as an office writes it', () => {
    expect(planRevisionLabel(parsePlanName('EG_Grundriss_Index_C_2026-08-14.pdf')!)).toBe('Index C · 14.08.2026')
    expect(planRevisionLabel(parsePlanName('Lageplan_v3.pdf')!)).toBe('v3')
    expect(planRevisionLabel(parsePlanName('Ansicht Nord Stand 02.09.2026.pdf')!)).toBe('02.09.2026')
  })
})

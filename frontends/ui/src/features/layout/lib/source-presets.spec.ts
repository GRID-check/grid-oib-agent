/**
 * @vitest-environment node
 */
import { describe, test, expect } from 'vitest'
import { classifySourceSignal, computePresetSourceIds } from './source-presets'

/** The sources the reference backend config actually exposes to the UI. */
const REFERENCE_SOURCES = [
  { id: 'web_search', name: 'Web Search' },
  { id: 'ris', name: 'RIS – Österreichisches Recht' },
]

describe('classifySourceSignal', () => {
  test('classifies the RIS source as law', () => {
    expect(classifySourceSignal({ id: 'ris', name: 'RIS – Österreichisches Recht' })).toBe('law')
  })

  test('classifies web search as auto (unclassified)', () => {
    expect(classifySourceSignal({ id: 'web_search', name: 'Web Search' })).toBe('auto')
  })

  test('does not misread the "ris" substring inside other words', () => {
    expect(classifySourceSignal({ id: 'enterprise_search', name: 'Enterprise Search' })).toBe(
      'auto'
    )
  })

  test('classifies knowledge/document sources as project', () => {
    expect(classifySourceSignal({ id: 'knowledge_base', name: 'Knowledge Base' })).toBe('project')
  })

  test('classifies archive sources as office', () => {
    expect(classifySourceSignal({ id: 'buero_archiv', name: 'Büroarchiv' })).toBe('office')
  })

  test('falls back to the name when the id is opaque', () => {
    expect(classifySourceSignal({ id: 'src_42', name: 'OIB Richtlinien' })).toBe('law')
  })
})

describe('computePresetSourceIds', () => {
  test('law preset selects only law-classified sources', () => {
    expect(computePresetSourceIds('law', REFERENCE_SOURCES)).toEqual(['ris'])
  })

  test('project preset yields an empty subset when no matching source exists', () => {
    // Honest mapping: project documents live in the (non-toggleable) knowledge
    // layer, so the preset just switches external sources off.
    expect(computePresetSourceIds('project', REFERENCE_SOURCES)).toEqual([])
  })

  test('office preset picks up an archive source when the registry grows one', () => {
    const sources = [...REFERENCE_SOURCES, { id: 'office_archive', name: 'Office Archive' }]
    expect(computePresetSourceIds('office', sources)).toEqual(['office_archive'])
  })

  test('handles a null source list', () => {
    expect(computePresetSourceIds('law', null)).toEqual([])
  })
})

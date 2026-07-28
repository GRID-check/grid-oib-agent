/**
 * Cross-language contract: the frontend must parse what the backend emits.
 *
 * Three formats cross the Python→TypeScript boundary, so no single test can
 * exercise both ends:
 *
 *  1. the KB tool output + its `## Trace-Lanes` JSON
 *     (`sources/knowledge_layer/src/register.py::_format_results`)
 *  2. the verified report's sources section with its `[KB]`/`[RIS]`/`[Web]`
 *     origin tokens (`citation_verification.verify_citations`)
 *  3. the wire source payload (`citation_verification.source_entry_to_wire`)
 *
 * Both sides assert against the SAME checked-in fixtures, produced by one real
 * pipeline run. The Python counterpart —
 * `tests/aiq_agent/common/test_citation_pipeline_contract.py`
 * (`TestSharedWireFixturesAreCurrent`) — proves the fixtures are still what the
 * backend emits; this spec proves the frontend still understands them. Change a
 * format and exactly one of the two fails, which is the only way this drift
 * becomes visible before a user sees an unlabelled or mis-tinted source.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { extractTraceLanesFromPayload, parseTraceLanesBlock } from './trace-lanes'
import { citationFromWire, normalizeOrigin } from './wire-citation'
import { splitReportSources } from '@/features/layout/lib/report-citations'
import type { WireCitationSource } from '../types'

// frontends/ui/src/features/chat/lib → repo root is six levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '../../../../../../tests/fixtures/citation_pipeline')
const fixture = (name: string): string => readFileSync(resolve(FIXTURE_DIR, name), 'utf-8')

const KB_TOOL_OUTPUT = fixture('kb_tool_output.txt')
const VERIFIED_REPORT = fixture('verified_report.md')
const WIRE_SOURCES = JSON.parse(fixture('wire_sources.json')) as WireCitationSource[]

describe('KB tool output → Herleitung fan-out', () => {
  test('the backend Trace-Lanes block is readable and keeps every hit in its stratum', () => {
    const lanes = parseTraceLanesBlock(KB_TOOL_OUTPUT)
    expect(lanes?.map((lane) => [lane.key, lane.label, lane.hitCount])).toEqual([
      ['baurecht_oib', 'OIB-Richtlinie', 1],
      ['projekt', 'Projektwissen', 1],
      ['buero', 'Büroarchiv', 1],
    ])
    expect(lanes?.map((lane) => lane.signal)).toEqual(['law', 'project', 'office'])
  })

  test('the coarse kind comes from the backend, not from a lane→kind table over here', () => {
    // `kind_for_lane` runs once, on the producing side, and travels with the
    // lane — the same taxonomy `source_entry_to_wire` puts on a citation. The
    // fan-out and the "Belegt durch" chips cannot disagree if neither derives it.
    expect(parseTraceLanesBlock(KB_TOOL_OUTPUT)?.map((lane) => lane.kind)).toEqual([
      'baurecht',
      'projekt',
      'buero',
    ])
  })

  test('a source carries the filename for preview resolution and the title for display', () => {
    const oib = parseTraceLanesBlock(KB_TOOL_OUTPUT)![0]
    expect(oib.sources).toEqual([
      {
        name: 'oib-rl_2_ausgabe_mai_2023.pdf',
        title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
        detail: 'p.12',
      },
    ])
  })

  test('the block is what a real KB payload resolves to, not a fallback parse', () => {
    expect(extractTraceLanesFromPayload(KB_TOOL_OUTPUT)).toEqual(
      parseTraceLanesBlock(KB_TOOL_OUTPUT)
    )
  })
})

describe('verified report → ReportTab sources section', () => {
  const split = splitReportSources(VERIFIED_REPORT)

  test('the German heading and both surviving entries are extracted', () => {
    expect(split.heading).toBe('Quellen')
    expect(split.entries.map((entry) => entry.number)).toEqual([1, 2])
  })

  test('the backend origin token is consumed, not shown to the reader', () => {
    expect(split.entries.map((entry) => entry.sourceKind)).toEqual(['kb', 'kb'])
    expect(split.entries.map((entry) => entry.markdown)).toEqual([
      'oib-rl_2_ausgabe_mai_2023.pdf, p.12',
      'einreichplan_og.pdf, p.4',
    ])
  })

  test('the removed fabricated source left no orphan marker for the reader to click', () => {
    expect(split.body).not.toContain('[3]')
    expect(split.body).toContain('Fluchtwege im Obergeschoss [2]')
  })
})

describe('wire payload → citation chips', () => {
  test('every backend field the chip renders survives the mapping', () => {
    expect(WIRE_SOURCES.map((wire) => citationFromWire(wire))).toMatchObject([
      {
        number: 1,
        origin: 'kb',
        kind: 'baurecht',
        lane: 'baurecht_oib',
        laneLabel: 'OIB-Richtlinie',
        fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
        page: 12,
      },
      {
        number: 2,
        origin: 'kb',
        kind: 'projekt',
        lane: 'projekt',
        fileName: 'einreichplan_og.pdf',
        page: 4,
      },
    ])
  })

  test('no backend origin is silently dropped as unrecognized', () => {
    for (const wire of WIRE_SOURCES) {
      expect(normalizeOrigin(wire.origin)).toBe(wire.origin)
    }
  })

  test('the chip number matches the [N] the report body now uses', () => {
    const numbers = splitReportSources(VERIFIED_REPORT).entries.map((entry) => entry.number)
    expect(WIRE_SOURCES.map((wire) => wire.number)).toEqual(numbers)
  })

  test('a chip and the fan-out card for the same document agree on the coarse kind', () => {
    const kindByName = new Map(
      (parseTraceLanesBlock(KB_TOOL_OUTPUT) ?? []).flatMap((lane) =>
        lane.sources.map((source) => [source.name, lane.kind] as const)
      )
    )
    for (const wire of WIRE_SOURCES) {
      expect(kindByName.get(wire.file_name!)).toBe(wire.kind)
    }
  })

  test('a chip resolves to the same lane the fan-out put its document in', () => {
    const laneByName = new Map(
      (parseTraceLanesBlock(KB_TOOL_OUTPUT) ?? []).flatMap((lane) =>
        lane.sources.map((source) => [source.name, lane.key] as const)
      )
    )
    for (const wire of WIRE_SOURCES) {
      expect(laneByName.get(wire.file_name!)).toBe(wire.lane)
    }
  })
})

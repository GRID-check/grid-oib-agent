/**
 * @vitest-environment node
 */
/**
 * Cross-language contract: the frontend must parse what the backend emits.
 *
 * Two formats cross the Python→TypeScript boundary, so no single test can
 * exercise both ends:
 *
 *  1. the verified report's sources section with its `[KB]`/`[RIS]`/`[Web]`
 *     origin tokens (`citation_verification.verify_citations`)
 *  2. the wire source payload (`citation_verification.source_entry_to_wire`)
 *
 * The Herleitung's lanes are not parsed from tool output: they arrive as
 * typed `sources` steps (chat wire v2), held by `shared/wire/v2`.
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
import { citationFromWire, normalizeOrigin } from './wire-citation'
import { buildCitationModel } from './citations'
import { splitReportSources } from '@/features/layout/lib/report-citations'
import type { WireCitationSource } from '../types'

// frontends/ui/src/features/chat/lib → repo root is six levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '../../../../../../tests/fixtures/citation_pipeline')
const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURE_DIR, name), 'utf-8').replace(/\r\n/g, '\n')

const VERIFIED_REPORT = fixture('verified_report.md')
const WIRE_SOURCES = JSON.parse(fixture('wire_sources.json')) as WireCitationSource[]

describe('verified report → its sources section (splitReportSources)', () => {
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

  test('a fabricated source leaves no orphan marker for the reader to click', () => {
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

  test('a plan\u2019s region reaches the viewer\u2019s locus, box and label intact', () => {
    const [oib, plan] = WIRE_SOURCES.map((wire) => citationFromWire(wire))
    expect(oib!.regions).toBeUndefined()
    expect(plan!.regions).toEqual([{ box: [0.08, 0.12, 0.62, 0.71], label: 'Grundriss 1. OG' }])
    const planDoc = buildCitationModel({ citations: [plan!] })[0]!
    expect(planDoc.loci[0]!.regions).toEqual(plan!.regions)
  })

  test('no backend origin is silently dropped as unrecognized', () => {
    for (const wire of WIRE_SOURCES) {
      expect(normalizeOrigin(wire.origin)).toBe(wire.origin)
    }
  })

  test('the chip number matches the [N] the report body uses', () => {
    const numbers = splitReportSources(VERIFIED_REPORT).entries.map((entry) => entry.number)
    expect(WIRE_SOURCES.map((wire) => wire.number)).toEqual(numbers)
  })
})

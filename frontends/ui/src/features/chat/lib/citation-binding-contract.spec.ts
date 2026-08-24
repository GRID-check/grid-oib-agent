/**
 * @vitest-environment node
 */
/**
 * Cross-language contract: bindingness, from the norm registry to the pill.
 *
 * `binding_classification_for_entry` classifies a source, `source_entry_to_wire`
 * puts a coarse `binding_status` on EVERY citation, `citationFromWire` maps it,
 * and `CitationPeek` badges it. The rule that matters most has no positive
 * evidence anywhere on screen: `unbekannt` must render NOTHING, because a
 * missing pill has to read as "we do not know" and a fabricated one would be a
 * false legal claim.
 *
 * Both ends of that rule were pinned, and the CROSSING was not.
 * `test_citation_verification.py` proves the backend emits `binding_status`,
 * including `unbekannt`, and `wire-citation.spec.ts` proves the frontend drops
 * `unbekannt` to undefined — but each side spelled the field out for itself, so
 * renaming the wire key on the Python side (with its own tests renamed along
 * with it, as a refactor would) left all 3,909 backend tests and this suite
 * green while every binding pill in the product went dark.
 *
 * A process boundary cannot be crossed inside one test, so both sides assert
 * against the SAME checked-in fixture — the device
 * `citation-wire-contract.spec.ts` already uses for the three other formats,
 * extended here to the field it did not carry. The Python counterpart,
 * `tests/aiq_agent/common/test_citation_pipeline_contract.py`
 * (`test_wire_sources_fixture_matches_the_serializer`), proves the fixture is
 * still a faithful sample of what `source_entry_to_wire` emits; this file
 * proves the frontend still reads it that way. Rename or re-value the field and
 * exactly one of the two fails.
 *
 * The fixture's two sources are deliberately the two cases: an OIB-Richtlinie a
 * Land declares binding, and a project upload that matches nothing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { citationFromWire } from './wire-citation'
import type { WireCitationSource } from '../types'

// frontends/ui/src/features/chat/lib → repo root is six levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '../../../../../../tests/fixtures/citation_pipeline')
const WIRE_SOURCES = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, 'wire_sources.json'), 'utf-8')
) as WireCitationSource[]

describe('the binding status the backend actually emits', () => {
  test('the fixture still carries the field, on every source', () => {
    // A fixture that quietly lost the key would make everything below pass over
    // an absent value, which is exactly the state this file exists to detect.
    expect(WIRE_SOURCES.length).toBe(2)
    for (const source of WIRE_SOURCES) {
      expect(typeof source.binding_status, JSON.stringify(source.file_name)).toBe('string')
    }
  })

  test('a Richtlinie the backend classified arrives as its classification', () => {
    const [oib] = WIRE_SOURCES
    expect(oib.file_name).toBe('oib-rl_2_ausgabe_mai_2023.pdf')
    expect(oib.binding_status).toBe('verbindlich_erklaert')
    expect(citationFromWire(oib).bindingStatus).toBe('verbindlich_erklaert')
  })

  test("the backend's own `unbekannt` becomes no pill at all", () => {
    // The whole rule, on the real value the real serializer produced for a
    // source that matched no catalogued norm: absence must read as "not known",
    // never as "not binding", so nothing is rendered rather than a hedge.
    const [, projekt] = WIRE_SOURCES
    expect(projekt.file_name).toBe('einreichplan_og.pdf')
    expect(projekt.binding_status).toBe('unbekannt')
    expect(citationFromWire(projekt).bindingStatus).toBeUndefined()
  })

  test('nothing else on the source is disturbed by dropping the status', () => {
    // The status is dropped, not the source: an unclassified citation is still
    // a citation, with its locator, its lane and its click-through intact.
    const citation = citationFromWire(WIRE_SOURCES[1])
    expect(citation.bindingStatus).toBeUndefined()
    expect([citation.fileName, citation.page, citation.lane]).toEqual([
      'einreichplan_og.pdf',
      4,
      'projekt',
    ])
  })
})

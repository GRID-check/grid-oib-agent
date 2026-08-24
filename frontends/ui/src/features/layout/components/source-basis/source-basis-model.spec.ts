/**
 * The Datenbasis model — where the composer's count is allowed to be decided,
 * and the only place it is.
 *
 * Two of these tests are regressions for bugs the old naked-integer trigger
 * shipped: the knowledge layer being invisible to the count while riding every
 * turn, and the Büroarchiv preset rendering "0".
 */

import { describe, expect, test } from 'vitest'

import {
  buildSourceBasis,
  hasNoExternalSources,
  summariseBasis,
  KNOWLEDGE_OFFICE_ID,
  KNOWLEDGE_PROJECT_ID,
  type BuildSourceBasisInput,
} from './source-basis-model'

const LABELS = {
  projectName: 'Projektwissen',
  projectDescription: 'Ihre Projektunterlagen.',
  officeName: 'Büroarchiv',
  officeDescription: 'Unterlagen Ihres Büros.',
  signInRequired: 'Melden Sie sich an, um diese Quelle zu nutzen.',
}

const RIS = { id: 'ris', name: 'RIS – Österreichisches Recht', description: 'Rechtsinformationssystem' }
const WEB = { id: 'web_search', name: 'Web Search', description: 'Offenes Web' }
const ARCHIVE = { id: 'office_archive', name: 'Büroarchiv Connector', description: 'Archiv' }

const build = (over: Partial<BuildSourceBasisInput> = {}) =>
  buildSourceBasis({
    sources: [WEB, RIS],
    enabledIds: ['web_search', 'ris'],
    knowledgeLayerAvailable: true,
    hasValidToken: true,
    labels: LABELS,
    ...over,
  })

describe('buildSourceBasis', () => {
  test('folds the knowledge layer in as always-on entries', () => {
    const basis = build()

    // The invisible participant, finally represented: `knowledge_layer` is
    // stripped from `availableDataSources` by the API client yet appended to
    // every turn's wire payload, so the picker that never drew it was lying by
    // omission — and the two things it omitted are exactly the ones architects
    // care about.
    expect(basis.always.map((e) => e.id)).toEqual([KNOWLEDGE_PROJECT_ID, KNOWLEDGE_OFFICE_ID])
    expect(basis.always.every((e) => e.state === 'always')).toBe(true)
    expect(basis.always.map((e) => e.signal)).toEqual(['project', 'office'])
  })

  test('omits the always-on section when the knowledge layer is absent', () => {
    expect(build({ knowledgeLayerAvailable: false }).always).toEqual([])
  })

  test('sorts external sources authority-descending, web search last', () => {
    const basis = build({ sources: [WEB, RIS, ARCHIVE], enabledIds: [] })
    expect(basis.external.map((e) => e.id)).toEqual(['ris', 'office_archive', 'web_search'])
  })

  test('an auth-gated source without a token is unavailable, not merely off', () => {
    const basis = build({
      sources: [{ ...RIS, requires_auth: true }],
      enabledIds: ['ris'],
      hasValidToken: false,
    })

    // Different fact, different state: "off" is a choice the reader made, and
    // "unavailable" is a door shut to them. The old row drew both the same way.
    expect(basis.external[0].state).toBe('unavailable')
    expect(basis.external[0].unavailableReason).toBe(LABELS.signInRequired)
  })

  test('never lists the knowledge layer among the toggleable sources', () => {
    const basis = build({ sources: [{ id: 'knowledge_layer', name: 'Knowledge' }, RIS] })
    expect(basis.external.map((e) => e.id)).toEqual(['ris'])
  })
})

describe('summariseBasis', () => {
  test('everything on reads as "all", and counts the knowledge layer', () => {
    const summary = summariseBasis(build(), null)

    expect(summary.kind).toBe('all')
    // THE COUNT. Two toggles plus the two knowledge-layer strata the wire
    // always carries: the old trigger said "2" while three ids went out.
    expect(summary.consultedCount).toBe(4)
  })

  test('the Büroarchiv preset says "Büroarchiv" — never zero', () => {
    // The worst moment in the old control. `computePresetSourceIds('office', …)`
    // legitimately returns [] (the office archive is retrieved through the
    // knowledge layer, not a toggleable source), so the composer answered a
    // deliberate choice with "Datengrundlage 0".
    const summary = summariseBasis(build({ enabledIds: [] }), 'office')

    expect(summary.kind).toBe('preset')
    expect(summary.preset).toBe('office')
    expect(summary.consultedCount).toBeGreaterThan(0)
  })

  test('an active preset outranks "everything is on"', () => {
    const summary = summariseBasis(build(), 'law')
    expect(summary.kind).toBe('preset')
    expect(summary.preset).toBe('law')
  })

  test('no external source on reads as internal-only, not as zero', () => {
    const summary = summariseBasis(build({ enabledIds: [] }), null)
    expect(summary.kind).toBe('internalOnly')
    expect(summary.consultedCount).toBe(2)
  })

  test('a hand-picked mix names its strata, authority-descending', () => {
    const summary = summariseBasis(
      build({ sources: [WEB, RIS, ARCHIVE], enabledIds: ['ris'] }),
      null
    )

    expect(summary.kind).toBe('subset')
    expect(summary.strata).toEqual(['law'])
    expect(summary.overflow).toBe(0)
  })

  test('caps the named strata at two and reports the rest as overflow', () => {
    const summary = summariseBasis(
      build({ sources: [WEB, RIS, ARCHIVE], enabledIds: ['ris', 'office_archive', 'web_search'] }),
      null,
      2
    )

    // All three selectable sources are on, so this is "all" — force the subset
    // shape by leaving one off.
    const partial = summariseBasis(
      build({
        sources: [WEB, RIS, ARCHIVE, { id: 'projekt_x', name: 'Projektablage' }],
        enabledIds: ['ris', 'office_archive', 'web_search'],
      }),
      null,
      2
    )

    expect(summary.kind).toBe('all')
    expect(partial.kind).toBe('subset')
    expect(partial.strata).toEqual(['law', 'office'])
    expect(partial.overflow).toBe(1)
  })

  test('an unavailable source does not keep "all" from being all', () => {
    const summary = summariseBasis(
      build({
        sources: [RIS, { ...WEB, requires_auth: true }],
        enabledIds: ['ris'],
        hasValidToken: false,
      }),
      null
    )

    expect(summary.kind).toBe('all')
  })
})

describe('hasNoExternalSources', () => {
  test('is true only once every switchable source is off', () => {
    expect(hasNoExternalSources(build())).toBe(false)
    expect(hasNoExternalSources(build({ enabledIds: [] }))).toBe(true)
    // Nothing to switch off is not the same as having switched everything off.
    expect(hasNoExternalSources(build({ sources: [], enabledIds: [] }))).toBe(false)
  })
})

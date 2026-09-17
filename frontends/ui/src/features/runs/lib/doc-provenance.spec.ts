/**
 * @vitest-environment node
 */

/**
 * The family and the badge a run-ledger document wears — the shelf decides
 * the family, the name may only ever ADD a badge, and never promotes an
 * unattributed upload to law.
 */

import { describe, expect, it } from 'vitest'
import { docProvenance } from './doc-provenance'

describe('docProvenance', () => {
  it('paints the base shelf as Baurecht and badges a named OIB document in the OIB accent', () => {
    expect(docProvenance({ name: 'OIB-Richtlinie 2', shelf: 'base' })).toEqual({
      kind: 'baurecht',
      tint: 'oib',
      authority: 'OIB',
    })
  })

  it('badges a Bauordnung, a Gesetz or a § on the base shelf as RIS', () => {
    expect(docProvenance({ name: 'Bauordnung für Wien § 108', shelf: 'base' })).toMatchObject({
      tint: 'law',
      authority: 'RIS',
    })
    expect(docProvenance({ name: 'Wiener Bautechnikverordnung 2020', shelf: 'base' })).toMatchObject({
      authority: 'RIS',
    })
  })

  it('leaves a base-shelf document without a legal name unbadged, in the law family', () => {
    expect(docProvenance({ name: 'Leitfaden Barrierefreiheit', shelf: 'base' })).toEqual({
      kind: 'baurecht',
      tint: 'law',
      authority: null,
    })
  })

  it('paints the Archiv as office knowledge and the project and session shelves as project knowledge', () => {
    expect(docProvenance({ name: 'Checkliste Brandschutz', shelf: 'archiv' })).toMatchObject({
      kind: 'buero',
      tint: 'office',
      authority: null,
    })
    expect(docProvenance({ name: 'Grundriss EG', shelf: 'project' })).toMatchObject({
      kind: 'projekt',
      tint: 'project',
    })
    expect(docProvenance({ name: 'Grundriss EG', shelf: 'session' })).toMatchObject({
      kind: 'projekt',
    })
  })

  it('does not promote a project file that mentions a § to law', () => {
    expect(docProvenance({ name: 'Aktenvermerk § 108', shelf: 'project' })).toMatchObject({
      kind: 'projekt',
      authority: null,
    })
  })

  it('reads a document with no shelf as unattributed (web), unless its name says OIB or ÖNORM', () => {
    expect(docProvenance({ name: 'ris.bka.gv.at — Bauordnung' })).toMatchObject({
      kind: 'web',
      tint: 'auto',
      authority: null,
    })
    expect(docProvenance({ name: 'ÖNORM B 1300' })).toEqual({
      kind: 'baurecht',
      tint: 'law',
      authority: 'ÖNORM',
    })
  })

  it('consults the title as well as the name', () => {
    expect(docProvenance({ name: 'oib-rl_2_ausgabe_mai_2023.pdf', title: 'OIB-Richtlinie 2' })).toMatchObject({
      authority: 'OIB',
    })
  })
})

/**
 * The Datenbasis model — where the composer's answer to "where may Piloti
 * look?" is decided, and the only place it is.
 *
 * The load-bearing test in here is the round-trip: what the reader sees on the
 * rows and what goes onto the wire have to be the same statement. They used to
 * be two controls (a source list and a preset row) that could disagree.
 */

import { describe, expect, test } from 'vitest'

import {
  buildSourceCategories,
  selectionFromCategories,
  summariseCategories,
  wireForSelection,
  type BuildSourceCategoriesInput,
  type SourceCategoryId,
} from './source-basis-model'

const LABELS = {
  law: { name: 'Baurecht & Richtlinien', description: 'Baurecht Österreich, OIB-Richtlinien' },
  project: { name: 'Projektunterlagen', description: 'Pläne, Gutachten und Protokolle' },
  office: { name: 'Büroarchiv', description: 'Unterlagen Ihres Büros' },
  web: { name: 'Web-Suche', description: 'Das offene Web' },
  lawLockedReason: 'Läuft derzeit immer mit.',
  signInRequired: 'Melden Sie sich an, um diese Quelle zu nutzen.',
}

const RIS = {
  id: 'ris',
  name: 'RIS – Österreichisches Recht',
  description: 'Rechtsinformationssystem',
  requires_auth: false,
}
const WEB = { id: 'web_search', name: 'Web Search', description: 'Offenes Web', requires_auth: false }

const build = (over: Partial<BuildSourceCategoriesInput> = {}) =>
  buildSourceCategories({
    sources: [WEB, RIS],
    enabledIds: ['web_search', 'ris'],
    activePreset: null,
    knowledgeLayerAvailable: true,
    hasValidToken: true,
    labels: LABELS,
    ...over,
  })

const stateOf = (categories: ReturnType<typeof build>, id: SourceCategoryId) =>
  categories.find((category) => category.id === id)?.state

describe('buildSourceCategories', () => {
  test('offers the four bodies of knowledge, authority-descending', () => {
    expect(build().map((category) => category.id)).toEqual(['law', 'project', 'office', 'web'])
  })

  test('law is on and locked, and says why on the row', () => {
    // Not a design principle — a statement about today's wire. Every
    // `source_preset` includes the `base` shelf, so a law switch would keep
    // searching the OIB corpus after being turned off. A switch that does not
    // do what it says is worse than a row that admits it cannot.
    const law = build().find((category) => category.id === 'law')
    expect(law?.state).toBe('locked')
    expect(law?.lockedReason).toBe(LABELS.lawLockedReason)
  })

  describe('the shelf-backed rows read the preset that is actually on the wire', () => {
    test('no preset means the signed scope is intact — both are in (ADR-0024)', () => {
      const categories = build({ activePreset: null })
      expect(stateOf(categories, 'project')).toBe('on')
      expect(stateOf(categories, 'office')).toBe('on')
    })

    test('the project preset narrows to the project', () => {
      const categories = build({ activePreset: 'project' })
      expect(stateOf(categories, 'project')).toBe('on')
      expect(stateOf(categories, 'office')).toBe('off')
    })

    test('the office preset narrows to the archive', () => {
      const categories = build({ activePreset: 'office' })
      expect(stateOf(categories, 'project')).toBe('off')
      expect(stateOf(categories, 'office')).toBe('on')
    })

    test('the law preset leaves both off — it is the "law only" turn', () => {
      const categories = build({ activePreset: 'law' })
      expect(stateOf(categories, 'project')).toBe('off')
      expect(stateOf(categories, 'office')).toBe('off')
    })
  })

  test('drops the shelf-backed rows when there is no knowledge layer', () => {
    // No knowledge layer, no project shelf to open. A switch for a choice that
    // does not exist is worse than no switch.
    const ids = build({ knowledgeLayerAvailable: false }).map((category) => category.id)
    expect(ids).toEqual(['law', 'web'])
  })

  test('drops the web row when no web source is configured', () => {
    expect(build({ sources: [RIS] }).map((category) => category.id)).toEqual([
      'law',
      'project',
      'office',
    ])
  })

  test('the web row follows its data source, not a preset', () => {
    expect(stateOf(build({ enabledIds: ['ris'] }), 'web')).toBe('off')
    expect(stateOf(build({ enabledIds: ['ris', 'web_search'] }), 'web')).toBe('on')
  })

  test('a source needing sign-in is unavailable, not merely off', () => {
    // Two different facts: one is a choice the reader can unmake, the other is
    // a door shut to them.
    const categories = build({
      sources: [{ ...WEB, requires_auth: true }, RIS],
      hasValidToken: false,
    })
    const web = categories.find((category) => category.id === 'web')
    expect(web?.state).toBe('unavailable')
    expect(web?.unavailableReason).toBe(LABELS.signInRequired)
  })
})

describe('wireForSelection', () => {
  test.each([
    { project: true, office: true, expected: null },
    { project: true, office: false, expected: 'project' },
    { project: false, office: true, expected: 'office' },
    { project: false, office: false, expected: 'law' },
  ])(
    'project=$project office=$office rides as preset $expected',
    ({ project, office, expected }) => {
      const { preset } = wireForSelection({ project, office, web: true }, [WEB, RIS])
      expect(preset).toBe(expected)
    }
  )

  test('law sources stay enabled whatever else is switched off', () => {
    // The same statement the locked row makes on screen. If these disagreed,
    // the reader would be told one thing and the agent sent another.
    const { enabledIds } = wireForSelection(
      { project: false, office: false, web: false },
      [WEB, RIS]
    )
    expect(enabledIds).toEqual(['ris'])
  })

  test('the web switch reaches its data source', () => {
    const on = wireForSelection({ project: true, office: true, web: true }, [WEB, RIS])
    expect(on.enabledIds).toEqual(['web_search', 'ris'])
    const off = wireForSelection({ project: true, office: true, web: false }, [WEB, RIS])
    expect(off.enabledIds).toEqual(['ris'])
  })

  test('an unrecognised source rides the web switch rather than staying silently on', () => {
    // `classifySourceSignal` falls through to `auto`, which is the web
    // category's signal. That is the right home for it: news search and
    // prediction markets all reach outside the reader's own documents, which is
    // what the web row promises to govern.
    const odd = { id: 'prediction_market', name: 'Prediction Markets', description: '', requires_auth: false }
    const off = wireForSelection({ project: false, office: false, web: false }, [odd, RIS])
    expect(off.enabledIds).not.toContain('prediction_market')
    const on = wireForSelection({ project: false, office: false, web: true }, [odd, RIS])
    expect(on.enabledIds).toContain('prediction_market')
  })
})

describe('the round trip', () => {
  test.each([
    { project: true, office: true, web: true },
    { project: true, office: false, web: true },
    { project: false, office: true, web: false },
    { project: false, office: false, web: false },
  ])('survives project=$project office=$office web=$web', (selection) => {
    // Build → wire → build again lands on the same rows. This is the property
    // that makes the switches trustworthy: what is drawn is what is sent.
    const { preset, enabledIds } = wireForSelection(selection, [WEB, RIS])
    const rebuilt = build({ activePreset: preset, enabledIds })
    expect(selectionFromCategories(rebuilt)).toEqual(selection)
  })
})

describe('summariseCategories', () => {
  test('everything on reads as "all", with no provenance claim to make', () => {
    expect(summariseCategories(build()).kind).toBe('all')
  })

  test('a narrower mix names its categories, authority-descending', () => {
    const summary = summariseCategories(build({ activePreset: 'project', enabledIds: ['ris'] }))
    expect(summary.kind).toBe('subset')
    expect(summary.categories).toEqual(['law', 'project'])
    expect(summary.overflow).toBe(0)
  })

  test('caps the named categories and counts the rest', () => {
    const summary = summariseCategories(build({ activePreset: null, enabledIds: ['ris'] }))
    // law + project + office are on, web is off — two named, one over.
    expect(summary.categories).toEqual(['law', 'project'])
    expect(summary.overflow).toBe(1)
    expect(summary.consultedCount).toBe(3)
  })

  test('a source the reader cannot use does not count against "all"', () => {
    // Otherwise a signed-out reader could never see "Alle Quellen", however
    // many switches they turned on.
    const categories = build({
      sources: [{ ...WEB, requires_auth: true }, RIS],
      hasValidToken: false,
      enabledIds: ['ris'],
    })
    expect(summariseCategories(categories).kind).toBe('all')
  })
})

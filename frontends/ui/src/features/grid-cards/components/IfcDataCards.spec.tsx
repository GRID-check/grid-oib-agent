/**
 * The three model-backed cards.
 *
 * The design property under test is that the agent supplies an IDENTIFIER and
 * the component supplies the NUMBERS. So the assertions check what each card
 * asks the model for, that it renders what came back rather than anything from
 * the card payload, and that it degrades honestly when the named model is not
 * in the project.
 *
 * Rendered in English — the default test locale.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import {
  IfcComplianceCard,
  IfcDiffCard,
  IfcElementCard,
  IfcScheduleCard,
} from './IfcDataCards'

const MODELS = {
  models: [
    {
      id: 'model-v2',
      documentId: 'doc-v2',
      projectId: 'p1',
      filename: 'haus-a_v2.ifc',
      status: 'ready',
      schemaVersion: 'IFC4',
      elementCount: 120,
      errorMessage: null,
      summary: null,
      updatedAt: '2026-02-11T09:00:00.000Z',
    },
    {
      id: 'model-v1',
      documentId: 'doc-v1',
      projectId: 'p1',
      filename: 'haus-a.ifc',
      status: 'ready',
      schemaVersion: 'IFC4',
      elementCount: 100,
      errorMessage: null,
      summary: null,
      updatedAt: '2026-01-08T09:00:00.000Z',
    },
  ],
}

const SCHEDULE = {
  schedule: {
    storeys: [
      {
        storeyName: 'Erdgeschoss',
        elevation: 0,
        rooms: [
          {
            globalId: 'g-wohnen',
            name: 'Wohnzimmer',
            storeyName: 'Erdgeschoss',
            category: 'INTERNAL',
            netFloorArea: 32,
            grossFloorArea: 34.5,
            netVolume: 80,
            height: 2.5,
          },
        ],
        netFloorArea: 32,
        grossFloorArea: 34.5,
        netVolume: 80,
        roomsWithoutArea: 2,
      },
    ],
    totals: {
      rooms: 3,
      roomsWithoutArea: 2,
      netFloorArea: 32,
      grossFloorArea: 34.5,
      netVolume: 80,
    },
    units: { area: 'm²', volume: 'm³', length: 'm' },
  },
}

const ELEMENT = {
  element: {
    globalId: '1kTvXnbbzCWw8lcMd1dR4o',
    expressId: 42,
    ifcType: 'IfcWallStandardCase',
    name: 'AW 38',
    description: null,
    predefinedType: null,
    objectType: null,
    tag: 'W-01',
    typeName: 'AW 38 Stahlbeton',
    storeyName: 'Erdgeschoss',
    materials: ['Stahlbeton'],
    classifications: [],
    properties: { Pset_WallCommon: { FireRating: 'REI 90', LoadBearing: true } },
    quantities: {},
  },
}

const COMPARISON = {
  comparison: {
    added: [{ globalId: 'g-new', ifcType: 'IfcDoor', name: 'T-14', storeyName: 'Erdgeschoss' }],
    removed: [],
    changed: [],
    // The badges read `counts`, not the array lengths: `compare.ts` slices
    // each list at 500 and keeps the real figures here, so a revision that
    // added 1 300 elements used to be reported as "Neu 500".
    counts: { added: 1, removed: 0, changed: 0 },
    unchangedCount: 99,
    totals: { base: 100, revision: 100 },
    truncated: false,
  },
}

/**
 * Route each URL the cards call to its fixture; anything else 404s.
 *
 * `/query` is matched FIRST because `/api/bim/models/<id>/query` also contains
 * the model-list path — checking in declaration order would hand every query
 * the model list and quietly render an empty card.
 */
function stubFetch(routes: {
  models: unknown
  query?: unknown
  /** The project brief the rule catalogue reads its facts from. */
  profile?: unknown
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/query')) {
      return routes.query === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, json: async () => routes.query }
    }
    if (url.includes('/bim/models')) return { ok: true, json: async () => routes.models }
    if (url.includes('/profile')) {
      return routes.profile === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, json: async () => routes.profile }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The body each `/query` POST sent, in call order. */
function queriedBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/query'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
}

/** The op each `/query` POST asked for, in call order. */
function queriedOps(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/query'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).op as string)
}

describe('IfcScheduleCard', () => {
  beforeEach(() => {
    stubFetch({ models: MODELS, query: SCHEDULE })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads the rooms from the model, not from the card', async () => {
    render(
      <IfcScheduleCard
        title="Raumbuch Erdgeschoss"
        modelFile="haus-a_v2.ifc"
        storey="Erdgeschoss"
        note={null}
        projectId="p1"
      />
    )
    const room = (await screen.findByText('Wohnzimmer')).closest('tr')
    expect(within(room!).getByText('32')).toBeInTheDocument()
    expect(within(room!).getByText('80')).toBeInTheDocument()
  })

  it('carries the rooms its total could not see', async () => {
    render(
      <IfcScheduleCard
        title="Raumbuch"
        modelFile="haus-a_v2.ifc"
        storey={null}
        note={null}
        projectId="p1"
      />
    )
    // The card is the surface an architect copies a figure off. A total that
    // silently excludes two rooms has to say so on the same card.
    expect(
      await screen.findByText('Rooms with no published area: 2 — not included in these totals.')
    ).toBeInTheDocument()
  })

  it('says the model is missing rather than rendering an empty table', async () => {
    render(
      <IfcScheduleCard
        title="Raumbuch"
        modelFile="nicht-vorhanden.ifc"
        storey={null}
        note={null}
        projectId="p1"
      />
    )
    expect(
      await screen.findByText('The referenced model is not available in this project.')
    ).toBeInTheDocument()
  })

  it('says a name matched several models, rather than that none of them exist', async () => {
    // `haus-a` is a substring of BOTH fixtures, which is the case the resolver
    // refuses. Refusing it correctly and then reporting it as "not available in
    // this project" sends an architect to re-upload a building the project
    // holds twice.
    render(
      <IfcScheduleCard
        title="Raumbuch"
        modelFile="haus-a"
        storey={null}
        note={null}
        projectId="p1"
      />
    )
    expect(
      await screen.findByText(
        'Several models in this project match that name, so this card cannot say which building it is about.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/not available in this project/)).not.toBeInTheDocument()
  })
})

describe('IfcElementCard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks the model for the element and renders its own properties', async () => {
    const fetchMock = stubFetch({ models: MODELS, query: ELEMENT })
    render(
      <IfcElementCard
        title="Außenwand AW 38"
        globalId="1kTvXnbbzCWw8lcMd1dR4o"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    expect(await screen.findByText('REI 90')).toBeInTheDocument()
    expect(screen.getByText('Stahlbeton')).toBeInTheDocument()
    await waitFor(() => expect(queriedOps(fetchMock)).toEqual(['element']))
  })

  it('opens the model on that element, highlighted', async () => {
    stubFetch({ models: MODELS, query: ELEMENT })
    render(
      <IfcElementCard
        title="Außenwand"
        globalId="1kTvXnbbzCWw8lcMd1dR4o"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    const open = await screen.findByRole('link', { name: /Open model/ })
    const href = open.getAttribute('href') ?? ''
    expect(href).toContain('element=1kTvXnbbzCWw8lcMd1dR4o')
    expect(href).toContain('hl=info%3A1kTvXnbbzCWw8lcMd1dR4o')
    // The storey comes from the fetched element, so the link isolates the right
    // floor even though the agent never said which one it is.
    expect(href).toContain('storey=Erdgeschoss')
  })

  it('says an element is not in the model instead of showing a blank card', async () => {
    stubFetch({ models: MODELS, query: { element: null } })
    render(
      <IfcElementCard
        title="Außenwand"
        globalId="does-not-exist"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    expect(await screen.findByText('This element is not in the model.')).toBeInTheDocument()
  })
})

describe('IfcDiffCard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('compares the two named revisions and counts what moved', async () => {
    const fetchMock = stubFetch({ models: MODELS, query: COMPARISON })
    render(
      <IfcDiffCard
        title="Änderungen zur Voreinreichung"
        baseModelFile="haus-a.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    expect(await screen.findByText('Added 1')).toBeInTheDocument()
    expect(screen.getByText('Unchanged 99')).toBeInTheDocument()
    await waitFor(() => expect(queriedOps(fetchMock)).toEqual(['compare']))
    const body = JSON.parse(
      String(
        (fetchMock.mock.calls.find(([url]) => String(url).includes('/query'))?.[1] as RequestInit)
          .body
      )
    ) as { baseModelId: string }
    // Resolved from the file name the agent wrote — the card never sees an id.
    expect(body.baseModelId).toBe('model-v1')
  })

  it('names what was added, not only how many', async () => {
    // The card used to render `changed` alone: "Added 1" with no way to find
    // out what. A delta you cannot open is a number, not an answer.
    stubFetch({ models: MODELS, query: COMPARISON })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="haus-a.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )

    const added = await screen.findByRole('link', { name: /Door · T-14/ })
    expect(added.getAttribute('href')).toContain('element=g-new')
    // Into the revision that HAS it.
    expect(added.getAttribute('href')).toContain('model=haus-a_v2.ifc')
  })

  it('links a removed element into the revision that still has it', async () => {
    // A removed element has no GlobalId in the new revision, so a link into it
    // would open the model with nothing selected.
    stubFetch({
      models: MODELS,
      query: {
        comparison: {
          added: [],
          removed: [
            { globalId: 'g-gone', ifcType: 'IfcWall', name: 'Innenwand OG', storeyName: 'OG' },
          ],
          changed: [],
          counts: { added: 0, removed: 1, changed: 0 },
          unchangedCount: 99,
          totals: { base: 100, revision: 99 },
          truncated: false,
        },
      },
    })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="haus-a.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )

    const removed = await screen.findByRole('link', { name: /Wall · Innenwand OG/ })
    expect(removed.getAttribute('href')).toContain('model=haus-a.ifc')
    expect(removed.getAttribute('href')).toContain('element=g-gone')
  })

  it('says how many rows it folded rather than dropping them silently', async () => {
    stubFetch({
      models: MODELS,
      query: {
        comparison: {
          added: Array.from({ length: 9 }, (_, i) => ({
            globalId: `g-${i}`,
            ifcType: 'IfcDoor',
            name: `T-${i}`,
            storeyName: null,
          })),
          removed: [],
          changed: [],
          counts: { added: 9, removed: 0, changed: 0 },
          unchangedCount: 99,
          totals: { base: 100, revision: 109 },
          truncated: false,
        },
      },
    })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="haus-a.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )

    expect(await screen.findByText('… 3 more elements')).toBeInTheDocument()
  })

  it('carries no heading for a side of the delta that is empty', async () => {
    stubFetch({ models: MODELS, query: COMPARISON })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="haus-a.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )

    await screen.findByText('Added 1')
    // The badge says "Removed 0"; a second, empty "Removed" heading under it
    // would read as a list that failed to load.
    expect(screen.queryByText('Removed', { exact: true })).not.toBeInTheDocument()
  })

  it('runs no comparison when the base revision is not in the project', async () => {
    const fetchMock = stubFetch({ models: MODELS, query: COMPARISON })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="gibt-es-nicht.ifc"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    await waitFor(() => expect(screen.getByText(/not available in this project/)).toBeInTheDocument())
    expect(queriedOps(fetchMock)).toEqual([])
  })

  it('refuses an ambiguous BASE revision instead of diffing against an arbitrary one', async () => {
    // The base used to take the first substring hit. A diff names two
    // buildings, so that produced a full revision history — additions,
    // deletions, the lot — computed against whichever model happened to sort
    // first, under a title claiming it was the Voreinreichung.
    const fetchMock = stubFetch({ models: MODELS, query: COMPARISON })
    render(
      <IfcDiffCard
        title="Änderungen"
        baseModelFile="haus-a"
        modelFile="haus-a_v2.ifc"
        note={null}
        projectId="p1"
      />
    )
    await waitFor(() =>
      expect(screen.getByText(/Several models in this project match that name/)).toBeInTheDocument()
    )
    expect(queriedOps(fetchMock)).toEqual([])
  })
})


const COMPLIANCE = {
  compliance: [
    {
      ruleId: 'oib2-feuerwiderstand-tragend',
      richtlinie: 'OIB 2',
      clause: '3',
      titleDe: 'Tragende Bauteile — Feuerwiderstand',
      thresholdDe: 'Feuerwiderstand nach Gebäudeklasse',
      applicable: true,
      passed: 0,
      failed: 0,
      undecidable: 34,
      failures: [],
      unknowns: [],
      truncated: false,
      missing: [{ path: 'Pset_WallCommon.FireRating', elements: 34 }],
    },
    {
      ruleId: 'oib3-raumhoehe',
      richtlinie: 'OIB 3',
      clause: '2',
      titleDe: 'Aufenthaltsräume — lichte Raumhöhe',
      thresholdDe: 'lichte Raumhöhe ≥ 2,50 m',
      applicable: true,
      passed: 9,
      failed: 0,
      undecidable: 0,
      failures: [],
      unknowns: [],
      truncated: false,
      missing: [],
    },
  ],
}

describe('IfcComplianceCard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('runs the catalogue itself rather than trusting the card', async () => {
    const fetchMock = stubFetch({ models: MODELS, query: COMPLIANCE })
    render(
      <IfcComplianceCard
        title="Offene Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )
    expect(await screen.findByText('Tragende Bauteile — Feuerwiderstand')).toBeInTheDocument()
    expect(screen.getByText(/0 met · 0 not met · 34 not decidable/)).toBeInTheDocument()
    await waitFor(() => expect(queriedOps(fetchMock)).toEqual(['compliance']))
  })

  it('narrows to the requirements the answer is about', async () => {
    stubFetch({ models: MODELS, query: COMPLIANCE })
    render(
      <IfcComplianceCard
        title="Brandschutz"
        modelFile="haus-a_v2.ifc"
        ruleIds={['oib2-feuerwiderstand-tragend']}
        note={null}
        projectId="p1"
      />
    )
    expect(await screen.findByText('Tragende Bauteile — Feuerwiderstand')).toBeInTheDocument()
    expect(screen.queryByText('Aufenthaltsräume — lichte Raumhöhe')).not.toBeInTheDocument()
  })

  it('reports a rule id that does not resolve instead of quietly dropping it', async () => {
    // Silently narrowing would turn a hallucinated id into a shorter,
    // cleaner-looking Prüfbuch — the one direction this card must not fail in.
    stubFetch({ models: MODELS, query: COMPLIANCE })
    render(
      <IfcComplianceCard
        title="Brandschutz"
        modelFile="haus-a_v2.ifc"
        ruleIds={['oib2-feuerwiderstand-tragend', 'oib9-erfunden']}
        note={null}
        projectId="p1"
      />
    )
    expect(
      await screen.findByText('One of the requested rule ids is not in the catalogue.')
    ).toBeInTheDocument()
  })

  it('always carries the orientation disclaimer', async () => {
    stubFetch({ models: MODELS, query: COMPLIANCE })
    render(
      <IfcComplianceCard
        title="Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )
    // The card leaves the page in a screenshot; the caveat has to travel with it.
    expect(await screen.findByText(/no legal advice and no Nachweis/)).toBeInTheDocument()
  })

  it('runs the catalogue with the project’s Gebäudeklasse, like the model page does', async () => {
    // Without the fact the fire-resistance rules stand down HERE and produce a
    // verdict on the model page — the same building answering two ways
    // depending on which surface you read it from.
    const fetchMock = stubFetch({
      models: MODELS,
      query: COMPLIANCE,
      profile: { facts: { gebaeudeklasse: { value: 4 }, hauptnutzung: { value: 'wohnen' } } },
    })
    render(
      <IfcComplianceCard
        title="Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )

    await screen.findByText('Tragende Bauteile — Feuerwiderstand')
    await waitFor(() =>
      expect(queriedBodies(fetchMock)).toContainEqual({
        op: 'compliance',
        gebaeudeklasse: 4,
        hauptnutzung: 'wohnen',
      })
    )
  })

  it('offers the open items as a BCF download, carrying the same facts', async () => {
    // Rendered by the card rather than left to the answer text: a model asked
    // to reproduce a URL will eventually reproduce a wrong one.
    stubFetch({
      models: MODELS,
      query: COMPLIANCE,
      profile: { facts: { gebaeudeklasse: { value: 4 } } },
    })
    render(
      <IfcComplianceCard
        title="Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )

    const download = await screen.findByRole('link', { name: /Open items as BCF/ })
    expect(download).toHaveAttribute(
      'href',
      '/api/projects/p1/bim/checks/export?modelId=model-v2&gebaeudeklasse=4'
    )
    expect(download).toHaveAttribute('download')
  })

  it('offers no download when the requirements it shows have nothing open', async () => {
    stubFetch({
      models: MODELS,
      query: {
        compliance: [
          {
            ruleId: 'oib3-raumhoehe',
            richtlinie: 'OIB 3',
            clause: '2',
            titleDe: 'Aufenthaltsräume — lichte Raumhöhe',
            thresholdDe: 'lichte Raumhöhe ≥ 2,50 m',
            applicable: true,
            passed: 9,
            failed: 0,
            undecidable: 0,
            failures: [],
            unknowns: [],
            truncated: false,
            missing: [],
          },
        ],
      },
    })
    render(
      <IfcComplianceCard
        title="Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )

    await screen.findByText('Aufenthaltsräume — lichte Raumhöhe')
    expect(screen.queryByRole('link', { name: /as BCF/ })).not.toBeInTheDocument()
  })

  it('opens the model on the Prüfbuch tab', async () => {
    stubFetch({ models: MODELS, query: COMPLIANCE })
    render(
      <IfcComplianceCard
        title="Anforderungen"
        modelFile="haus-a_v2.ifc"
        ruleIds={[]}
        note={null}
        projectId="p1"
      />
    )
    const open = await screen.findByRole('link', { name: /Open model/ })
    expect(open.getAttribute('href')).toContain('tab=compliance')
  })
})

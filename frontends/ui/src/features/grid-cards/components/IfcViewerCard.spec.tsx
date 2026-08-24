/**
 * The viewer card — the only model-backed card that had no spec.
 *
 * The viewport itself is mocked: it needs a WebGPU adapter, which no test
 * runner has. What is pinned here is everything around it, which is where the
 * card can be wrong in a way nobody notices — the three situations it used to
 * collapse into "das Modell ist nicht verfügbar", and the two counts it
 * reports about an answer somebody else wrote.
 *
 * Rendered in English — the default test locale.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IfcViewerCard } from './IfcViewerCard'

/** The viewport needs a GPU; the card's own logic does not. */
vi.mock('@/features/bim/components/ifc-model-viewer', () => ({
  IfcModelViewer: () => <div data-testid="ifc-viewport" />,
}))

const MODELS = {
  models: [
    {
      id: 'model-1',
      documentId: 'doc-1',
      projectId: 'p1',
      filename: 'haus-a.ifc',
      status: 'ready',
      schemaVersion: 'IFC4',
      elementCount: 3,
      errorMessage: null,
      summary: null,
      updatedAt: '2026-02-11T09:00:00.000Z',
    },
  ],
}

const ELEMENTS = {
  elements: [
    { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand', storeyName: 'EG' },
    { globalId: 'g-w2', expressId: 22, ifcType: 'IfcWall', name: 'Innenwand', storeyName: 'EG' },
  ],
  total: 2,
}

/**
 * Route each URL to its fixture.
 *
 * `never` leaves a request pending forever, which is how the "still loading"
 * state is held still long enough to assert on.
 */
function stubFetch(routes: {
  models?: unknown | 'fail' | 'never'
  query?: unknown
  source?: unknown
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/query')) {
        return routes.query === undefined
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, json: async () => routes.query }
      }
      if (url.includes('/source')) {
        return routes.source === undefined
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, json: async () => routes.source }
      }
      if (url.includes('/bim/models')) {
        if (routes.models === 'never') return new Promise(() => {})
        if (routes.models === 'fail' || routes.models === undefined) {
          return { ok: false, status: 500, json: async () => ({}) }
        }
        return { ok: true, json: async () => routes.models }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
  )
}

beforeEach(() => {
  Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if ('gpu' in navigator) Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'gpu')
})

/**
 * A fresh project id per render.
 *
 * `useProjectBimModels` collapses simultaneous requests through a module-level
 * in-flight map keyed by project — so a test that leaves its request pending
 * (the "still loading" case) would hand that same never-settling promise to
 * every later test in the file.
 */
let nextProject = 0
const card = (props: Partial<React.ComponentProps<typeof IfcViewerCard>> = {}) =>
  render(
    <IfcViewerCard
      title="Aussenwände"
      modelFile="haus-a.ifc"
      storey={null}
      note={null}
      highlights={[]}
      projectId={`p${(nextProject += 1)}`}
      {...props}
    />
  )

describe('IfcViewerCard — which of three situations it is in', () => {
  it('does not claim the model is missing while the list is still loading', async () => {
    // "Das referenzierte Modell ist in diesem Projekt nicht verfügbar" is the
    // sentence that tells an architect their upload vanished. It was rendered
    // for the first few hundred milliseconds of every card.
    stubFetch({ models: 'never' })
    card()
    expect(screen.queryByText(/not available in this project/i)).not.toBeInTheDocument()
  })

  it('says the list could not be read, rather than that the model is gone', async () => {
    stubFetch({ models: 'fail' })
    card()
    await waitFor(() =>
      expect(screen.getByText(/models for this project are temporarily unavailable/i)).toBeInTheDocument()
    )
    expect(screen.queryByText(/not available in this project/i)).not.toBeInTheDocument()
  })

  it('says the model is missing when the project genuinely does not have it', async () => {
    stubFetch({ models: { models: [] } })
    card()
    await waitFor(() =>
      expect(screen.getByText(/not available in this project/i)).toBeInTheDocument()
    )
  })

  it('says a name matched several models, rather than that none of them exist', async () => {
    // Two ready models both contain `haus-a`, so the resolver refuses — the
    // same refusal `ifc_query` makes server side. What it must NOT say is that
    // the model is missing: it is in the project twice.
    stubFetch({
      models: {
        models: [
          MODELS.models[0],
          { ...MODELS.models[0], id: 'model-2', documentId: 'doc-2', filename: 'haus-a-alt.ifc' },
        ],
      },
    })
    card({ modelFile: 'haus-a' })
    await waitFor(() =>
      expect(screen.getByText(/Several models in this project match that name/)).toBeInTheDocument()
    )
    expect(screen.queryByText(/not available in this project/i)).not.toBeInTheDocument()
  })

  it('says a model is still being read, rather than that it is not here', async () => {
    // A card can render seconds after the upload. "Nicht verfügbar" for a model
    // thirty seconds from finishing is needlessly alarming; for one whose
    // extraction FAILED it is false, and it hides the only thing the reader
    // could act on.
    stubFetch({
      models: { models: [{ ...MODELS.models[0], status: 'extracting' }] },
    })
    card()
    await waitFor(() =>
      expect(screen.getByText(/still reading this model/i)).toBeInTheDocument()
    )
    expect(screen.queryByText(/not available in this project/i)).not.toBeInTheDocument()
  })

  it('says a model could not be read, which is the one the reader can fix', async () => {
    stubFetch({ models: { models: [{ ...MODELS.models[0], status: 'failed' }] } })
    card()
    await waitFor(() =>
      expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    )
    expect(screen.queryByText(/not available in this project/i)).not.toBeInTheDocument()
  })

  it('draws the building once the model resolves', async () => {
    stubFetch({ models: MODELS, query: ELEMENTS, source: { url: 'https://example.test/m.ifc' } })
    card()
    expect(await screen.findByTestId('ifc-viewport')).toBeInTheDocument()
  })
})

describe('IfcViewerCard — what it says about the answer it illustrates', () => {
  it('reports highlighted ids the model does not contain', async () => {
    stubFetch({ models: MODELS, query: ELEMENTS, source: { url: 'https://example.test/m.ifc' } })
    card({ highlights: [{ globalIds: ['g-w1', 'g-nope'], label: 'Aussenwände', status: 'fail' }] })
    await waitFor(() =>
      expect(
        screen.getByText('One of the highlighted elements is not in this model.')
      ).toBeInTheDocument()
    )
  })

  it('says nothing about missing ids while the element rows are in flight', async () => {
    // An id resolves only against the rows, so counting before they land
    // accuses the answer of naming elements a model that has them.
    stubFetch({ models: MODELS, source: { url: 'https://example.test/m.ifc' } })
    card({ highlights: [{ globalIds: ['g-w1'], label: 'Aussenwände', status: 'fail' }] })
    expect(screen.queryByText(/not in this model/)).not.toBeInTheDocument()
  })

  it('does not sit on a progress bar that can never finish', async () => {
    // A presigned URL that never arrives — a withdrawn feature flag, an expired
    // session — leaves `sourceUrl` null, which the viewport renders as an
    // indeterminate "Loading model…" forever. The stage and the file preview
    // both refuse to do that.
    stubFetch({ models: MODELS, query: ELEMENTS })
    card()
    await waitFor(() =>
      expect(screen.getByText(/3D preview could not be loaded/i)).toBeInTheDocument()
    )
    expect(screen.queryByText('Loading model…')).not.toBeInTheDocument()
  })

  it('says the highlighted set could not be resolved, rather than colouring nothing', async () => {
    // Highlights resolve to express ids against the element rows. Without them
    // every group resolves to nothing and the legend reads "(0)" beside an
    // answer that named 420 elements — the contradiction the model stage
    // documents at length and guards against.
    stubFetch({ models: MODELS, source: { url: 'https://example.test/m.ifc' } })
    card({ highlights: [{ globalIds: ['g-w1'], label: 'Aussenwände', status: 'fail' }] })
    await waitFor(() =>
      expect(screen.getByText(/element list could not be loaded/i)).toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.queryByText('(0)')).not.toBeInTheDocument()
  })

  it('opens the model at the same view it is showing', async () => {
    stubFetch({ models: MODELS, query: ELEMENTS, source: { url: 'https://example.test/m.ifc' } })
    card({
      storey: 'EG',
      highlights: [{ globalIds: ['g-w1'], label: 'Aussenwände', status: 'fail' }],
    })
    const link = await screen.findByRole('link', { name: /open model/i })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('model=haus-a.ifc')
    expect(href).toContain('storey=EG')
    // Ghosting is what makes a highlighted wall findable inside a building
    // rather than buried in it.
    expect(href).toContain('xray=1')
  })
})

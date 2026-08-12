/**
 * The stage, tested for the decisions the redesign is actually made of.
 *
 * Not "does it render" — whether the reduced surface is the surface: that the
 * building is the default state, that metadata appears only on selection, that
 * the analytical panels stay shut until asked for, and that every control
 * still writes its state into the URL so a view remains a thing you can send.
 *
 * The canvas is mocked. It needs a WebGPU adapter, which no test runner has;
 * what can be pinned here is everything around it, which is where this change
 * lives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import { buildModelQuery, type BimModelView } from '../lib/model-link'
import { ModelStage } from './model-stage'

const routerReplace = vi.fn()
let searchParams = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: (...args: unknown[]) => routerReplace(...args),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/app/projects/p1/files',
  useSearchParams: () => searchParams,
}))

vi.mock('./ifc-viewer-canvas', () => ({
  IfcViewerCanvas: (props: {
    onStatus?: (status: unknown) => void
    onBounds?: (bounds: { minMetres: number; maxMetres: number } | null) => void
  }) => {
    const { onStatus, onBounds } = props
    // A building with a basement: the cut slider is ranged over the model's
    // own extent, and a model whose extent starts below zero is the case the
    // link encoding used to be unable to carry.
    useEffect(() => {
      onBounds?.({ minMetres: -3, maxMetres: 9 })
    }, [onBounds])
    // Reported from an EFFECT, not from render. The status sets state in the
    // stage, which re-renders the canvas — so reporting during render is an
    // infinite loop rather than a test.
    useEffect(() => {
      // Every control in the dock is disabled until the model has loaded, so
      // a canvas that never settles would make this whole spec assert on a
      // disabled dock.
      onStatus?.(canvasStatus)
    }, [onStatus])
    // A real `<canvas tabIndex={0}>`, because it is the landing spot for
    // every viewer control that removes itself on activation — the stand-in
    // has to be focusable for those assertions to mean anything.
    return <canvas data-testid="ifc-canvas" tabIndex={0} />
  },
}))

/** The analytical drawer pulls six more hooks; it is exercised by its own specs. */
vi.mock('./model-advanced-sheet', () => ({
  ModelAdvancedSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="advanced-sheet" /> : null,
}))

const sourceReload = vi.fn()
const modelsReload = vi.fn()
let modelsError: string | null = null
/** What the stand-in canvas reports; `ready` unless a test says otherwise. */
let canvasStatus: { phase: string; percent: number | null; meshCount: number; message?: string } = {
  phase: 'ready',
  percent: 100,
  meshCount: 12,
}

const state = {
  models: [] as BimModelHeaderView[],
  elements: [] as unknown[],
  /** The rows arrive on their own request, later than the geometry. */
  elementsLoading: false,
  detail: null as unknown,
  sourceUrl: 'https://example.test/haus-a.ifc' as string | null,
  sourceError: null as string | null,
}

vi.mock('../hooks/use-bim-model', () => ({
  useProjectBimModels: () => ({
    data: state.models,
    isLoading: false,
    error: modelsError,
    reload: modelsReload,
  }),
  useBimElements: () => ({
    data: state.elementsLoading ? null : state.elements,
    isLoading: state.elementsLoading,
    error: null,
  }),
  useBimElementDetail: () => ({ data: state.detail, isLoading: false, error: null }),
  useBimModelSource: () => ({
    data: state.sourceUrl,
    isLoading: false,
    error: state.sourceError,
    reload: sourceReload,
  }),
}))

function model(overrides: Partial<BimModelHeaderView> = {}): BimModelHeaderView {
  return {
    id: 'm-1',
    documentId: 'doc-1',
    projectId: 'p1',
    filename: 'Haus-A.ifc',
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 120,
    errorMessage: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    summary: {
      storeys: [
        { globalId: null, expressId: 1, name: 'Erdgeschoss', elevation: 0, elementCount: 80 },
        { globalId: null, expressId: 2, name: 'Obergeschoss', elevation: 3.2, elementCount: 40 },
      ],
    } as BimModelHeaderView['summary'],
    ...overrides,
  }
}

/** The query the stage wrote on its last `router.replace`. */
function lastQuery(): URLSearchParams {
  const href = routerReplace.mock.calls.at(-1)?.[0] as string | undefined
  return new URLSearchParams(href?.split('?')[1] ?? '')
}

function setWebGpu(available: boolean): void {
  if (available) Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  else if ('gpu' in navigator) Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'gpu')
}

beforeEach(() => {
  vi.clearAllMocks()
  searchParams = new URLSearchParams('model=Haus-A.ifc')
  state.models = [model()]
  state.elements = []
  state.elementsLoading = false
  state.detail = null
  state.sourceUrl = 'https://example.test/haus-a.ifc'
  state.sourceError = null
  modelsError = null
  canvasStatus = { phase: 'ready', percent: 100, meshCount: 12 }
  setWebGpu(true)
})

afterEach(() => setWebGpu(false))

describe('ModelStage — what is on screen', () => {
  it('opens on the building, with no metadata anywhere', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(await screen.findByTestId('ifc-canvas')).toBeInTheDocument()
    // The whole complaint about the page this replaces: it led with data.
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('advanced-sheet')).not.toBeInTheDocument()
  })

  it('carries a handful of controls, not a toolbar of nine', () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    // "See through" is named for its disabled reason here — nothing is
    // selected in this fixture. Its own test above covers that.
    for (const name of ['Fit the whole model', 'View', 'Section']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    // The six view directions used to be six buttons in the bar, which is what
    // pushed the controls anyone uses off the end of the row.
    expect(screen.queryByRole('button', { name: 'Plan' })).not.toBeInTheDocument()
  })

  it('gives the camera button and the restore button different names', () => {
    // Both were called "Show everything" — one fits the camera, the other
    // brings hidden components back. Icon-only, in the same pill, and a
    // screen reader heard "Show everything" and "Show everything again".
    state.elements = [
      { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Wand', storeyName: 'Erdgeschoss' },
    ]
    searchParams = new URLSearchParams('model=Haus-A.ifc&element=g-w1')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Fit the whole model' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Show everything/ })).not.toBeInTheDocument()
  })

  it('lists the project’s models and the building’s levels, top floor first', () => {
    state.models = [model(), model({ id: 'm-2', filename: 'Nebengebäude.ifc' })]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    const models = screen.getByRole('region', { name: 'Models' })
    expect(within(models).getByRole('button', { name: 'Haus-A' })).toBeInTheDocument()
    expect(within(models).getByRole('button', { name: 'Nebengebäude' })).toBeInTheDocument()

    const levels = screen.getByRole('region', { name: 'Levels' })
    const rows = within(levels).getAllByRole('button')
    expect(rows.map((row) => row.getAttribute('title'))).toEqual([
      'All levels',
      'Obergeschoss',
      'Erdgeschoss',
    ])
  })

  it('drops the model list entirely when there is only one', () => {
    // A "Modelle" heading over a single row is a section that exists to be
    // looked past, and it doubles the rail's height. The model's name is
    // already the dialog's title, so nothing is lost.
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByRole('region', { name: 'Models' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Levels' })).toBeInTheDocument()
  })

  it('will not switch to a model that is still being read', () => {
    state.models = [model(), model({ id: 'm-2', filename: 'B.ifc', status: 'extracting' })]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    // The row still SAYS it is being read — the status is part of its spoken
    // name, which is why the query is a prefix rather than an exact match.
    expect(screen.getByRole('button', { name: /^B\b/ })).toBeDisabled()
  })
})

describe('ModelStage — every control is a link', () => {
  it('puts the level filter in the URL', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Obergeschoss' }))
    expect(lastQuery().get('storey')).toBe('Obergeschoss')
  })

  it('puts see-through in the URL', async () => {
    // With something selected there IS a subset to keep solid, so the control
    // can act — see the test below for the case where it cannot.
    searchParams = new URLSearchParams('model=Haus-A.ifc&element=g-w1')
    state.elements = [
      { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Wand', storeyName: 'Erdgeschoss' },
    ]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'See through' }))
    expect(lastQuery().get('xray')).toBe('1')
  })

  it('does not offer see-through when there is nothing to keep solid', async () => {
    // It ghosts everything that is NOT highlighted or selected, so with
    // neither it correctly ghosts nothing. Pressing it wrote `xray=1`, filled
    // the button and set `aria-pressed` — and the building did not change.
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    // And the name says why. A disabled button gets no tooltip — Radix's
    // trigger never fires on one — so an inert eye with the bare name
    // "See through" left the reader nothing to act on.
    const xray = screen.getByRole('button', { name: /^See through — select a component/ })
    expect(xray).toBeDisabled()
  })

  it('puts the cut in the URL, at a metre above the level in view', async () => {
    searchParams = new URLSearchParams('model=Haus-A.ifc&storey=Obergeschoss')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Section' }))
    // +3.20 m floor, cut a metre above it — where an Austrian Grundriss is cut,
    // not at the slab, where the plane would show an empty view.
    expect(lastQuery().get('cut')).toBe('4.2')
  })

  /**
   * The cut slider, against a router that behaves like the real one.
   *
   * Every other test in this file leaves `searchParams` frozen and asserts on
   * the URL the stage ASKED for. That is the right shape for a discrete
   * control — one click, one link — and it is exactly why a defect that only a
   * continuous control can have went unseen for a release: the slider was
   * written to the URL on every step of the drag and read its value back from
   * it, so on a real router (`replace` re-runs the server tree; the value
   * returns a round trip later) React reset the thumb to a stale number faster
   * than it could be dragged. The reported symptom was a slider that would not
   * move off the height the Schnitt button had set.
   *
   * So this block gives the mock the one property that matters: `replace` is
   * ASYNCHRONOUS. Nothing here can pass by accident.
   */
  describe('dragging the cut, against an asynchronous router', () => {
    /** Apply the pending URL, the way a router eventually would. */
    let applyNavigation: () => void

    beforeEach(() => {
      searchParams = new URLSearchParams('model=Haus-A.ifc&cut=4&cutup=0')
      applyNavigation = () => {
        const href = routerReplace.mock.calls.at(-1)?.[0] as string | undefined
        if (href) searchParams = new URLSearchParams(href.split('?')[1] ?? '')
      }
    })

    const slider = () => screen.getByRole('slider', { name: 'Cut at' })
    const cutValue = () => (slider() as HTMLInputElement).value

    it('follows the drag while the router has not caught up', async () => {
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      // Three steps of one drag, with no navigation applied in between —
      // which is the whole of the round trip the old code waited for.
      fireEvent.change(slider(), { target: { value: '3.5' } })
      fireEvent.change(slider(), { target: { value: '2.4' } })
      fireEvent.change(slider(), { target: { value: '1.2' } })

      expect(cutValue()).toBe('1.2')
      expect(screen.getByText('1.20 m')).toBeInTheDocument()
    })

    it('does not write the link on every step of the drag', async () => {
      // One `router.replace` per pixel is a server round trip per pixel, and
      // a history entry per pixel for anything that pushes.
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      routerReplace.mockClear()
      fireEvent.change(slider(), { target: { value: '3.5' } })
      fireEvent.change(slider(), { target: { value: '2.4' } })

      expect(routerReplace).not.toHaveBeenCalled()
    })

    it('writes the link once, when the reader lets go', async () => {
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      routerReplace.mockClear()
      fireEvent.change(slider(), { target: { value: '2.4' } })
      fireEvent.pointerUp(slider())

      expect(routerReplace).toHaveBeenCalledTimes(1)
      expect(lastQuery().get('cut')).toBe('2.4')
    })

    it('does not snap back while the link catches up', async () => {
      // The handover is the moment the local value is dropped. Dropping it on
      // commit rather than on agreement would show the previous height for a
      // whole round trip: the plane visibly jumps back, then forward again.
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      fireEvent.change(slider(), { target: { value: '2.4' } })
      fireEvent.pointerUp(slider())
      expect(cutValue()).toBe('2.4')

      applyNavigation()
      await waitFor(() => expect(cutValue()).toBe('2.4'))
    })

    it('reaches a cut below the origin, where a basement is', async () => {
      // The slider is ranged over the model's own extent, which starts below
      // zero here. The link has to be able to carry that: the old encoding
      // ran the height through `Math.abs`, so this cut came back as +1.4 and
      // the plane jumped to the other side of the ground floor.
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      fireEvent.change(slider(), { target: { value: '-1.4' } })
      fireEvent.pointerUp(slider())

      expect(cutValue()).toBe('-1.4')
      expect(lastQuery().get('cut')).toBe('-1.4')

      applyNavigation()
      await waitFor(() => expect(cutValue()).toBe('-1.4'))
    })

    it('keeps the height when the direction is flipped mid-cut', async () => {
      render(<ModelStage projectId="p1" onClose={vi.fn()} />)
      fireEvent.change(slider(), { target: { value: '2.4' } })
      await userEvent.click(screen.getByRole('button', { name: 'Looking down' }))

      expect(lastQuery().get('cut')).toBe('2.4')
      expect(lastQuery().get('cutup')).toBe('1')
    })
  })

  it('switches model without carrying the previous building’s selection', async () => {
    searchParams = new URLSearchParams('model=Haus-A.ifc&element=g-w1&storey=Erdgeschoss')
    state.models = [model(), model({ id: 'm-2', filename: 'B.ifc' })]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^B\b/ }))

    const query = lastQuery()
    expect(query.get('model')).toBe('B.ifc')
    // A GlobalId from one building means nothing in another.
    expect(query.has('element')).toBe(false)
    expect(query.has('storey')).toBe(false)
  })
})

describe('ModelStage — selection', () => {
  beforeEach(() => {
    searchParams = new URLSearchParams('model=Haus-A.ifc&element=g-w1')
    state.detail = {
      globalId: 'g-w1',
      expressId: 21,
      ifcType: 'IfcWallStandardCase',
      name: 'AW 38',
      description: null,
      predefinedType: null,
      objectType: null,
      tag: null,
      typeName: null,
      storeyName: 'Erdgeschoss',
      materials: ['Stahlbeton'],
      classifications: [],
      properties: {},
      quantities: {},
    }
  })

  it('shows the card only once something is selected, and leads with the noun', () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    // "Wall", not "IfcWallStandardCase" — the schema is what the old page led
    // with and it is why the page read as a console.
    expect(within(panel).getByText('Wall · Erdgeschoss')).toBeInTheDocument()
  })

  it('keeps the GlobalId, but folded away', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    const details = panel.querySelector('details')

    // Shut by default IS the redesign, in one attribute: a 22-character
    // GlobalId at the top of the card is how the old page read as a console.
    expect(details).not.toHaveAttribute('open')
    expect(within(panel).getByText('g-w1')).toBeInTheDocument()

    await userEvent.click(within(panel).getByText('Technical details'))
    expect(details).toHaveAttribute('open')
  })

  it('turns the selection into a question that names the element', () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const ask = screen.getByRole('link', { name: /Ask Piloti about this/ })
    expect(ask.getAttribute('href')).toContain('/app/projects/p1/chat?ask=')
    // `+` is a space in a query string; decodeURIComponent does not undo it.
    const question = decodeURIComponent(ask.getAttribute('href') ?? '').replace(/\+/g, ' ')
    expect(question).toContain('GlobalId g-w1')
  })

  it('drops the element from the URL when the card is closed', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    expect(lastQuery().has('element')).toBe(false)
  })

  it('puts focus back on the building when the card closes', async () => {
    // The close button unmounts the panel it lives in. Radix catches the
    // removal and re-focuses the dialog CONTAINER, which is not a crash but
    // is a lost place: the top of a full-screen surface with fifteen
    // controls, and nothing said about where the reader was.
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(screen.getByTestId('ifc-canvas'))
  })

  it('puts focus back on the building when the selection is hidden', async () => {
    // Hide deletes the card AND the button that was pressed, and its
    // disappearance is the only feedback that anything happened.
    // Hide is bound to the RENDERER id, so the element row has to be present
    // — the card alone comes from the detail request.
    state.elements = [
      { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'AW 38', storeyName: 'Erdgeschoss' },
    ]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Hide' }))
    expect(document.activeElement).toBe(screen.getByTestId('ifc-canvas'))
  })
})

describe('ModelStage — the advanced surfaces', () => {
  it('stays shut until it is asked for', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByTestId('advanced-sheet')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Details & checks' }))
    expect(screen.getByTestId('advanced-sheet')).toBeInTheDocument()
  })

  it('opens straight into the panel a link named', () => {
    // `?tab=compliance` is how a chat compliance card links into the Prüfbuch.
    // Landing on the model with the drawer shut would lose the point of it.
    searchParams = new URLSearchParams('model=Haus-A.ifc&tab=compliance')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.getByTestId('advanced-sheet')).toBeInTheDocument()
  })
})

describe('ModelStage — nothing to show', () => {
  it('says the project has no model rather than rendering an empty canvas', () => {
    state.models = []
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(screen.getByText('No IFC model yet')).toBeInTheDocument()
  })

  it('distinguishes "still being read" from "there is no model"', () => {
    state.models = [model({ status: 'extracting' })]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.getByText(/still being read/)).toBeInTheDocument()
  })

  it('explains a browser without WebGPU instead of showing a blank frame', () => {
    setWebGpu(false)
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(screen.getByText('3D view not available in this browser')).toBeInTheDocument()
  })
})

describe('ModelStage — getting out', () => {
  it('closes from its own control', async () => {
    const onClose = vi.fn()
    render(<ModelStage projectId="p1" onClose={onClose} />)
    await userEvent.click(screen.getByTestId('stage-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * Every failure offers a way back.
 *
 * Nielsen's ninth: a system must help a user recognise, diagnose and recover.
 * This surface managed the first two and none of the third — the notices took
 * no action, the hooks' `reload` had no caller, and the button's string had
 * sat unused in both dictionaries since it was written. Closing and reopening
 * the whole stage was the only escape, and nothing on screen suggested it.
 */
describe('ModelStage — recovering from a failure', () => {
  it('offers a retry when the model list could not be loaded', async () => {
    state.models = []
    modelsError = 'load-failed'
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(modelsReload).toHaveBeenCalled()
  })

  it('says the view is unavailable when the URL could not be minted', async () => {
    // Not a progress bar. This used to fall through to the indeterminate
    // "Loading model…" veil, which never finishes — a 403 from a withdrawn
    // feature flag looked exactly like a slow network, forever.
    state.sourceUrl = null
    state.sourceError = 'load-failed'
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    // Twice on purpose: once in the notice, once in the live region that
    // announces it. `getAllByText` rather than `getByText` says so.
    expect(screen.getAllByText('The 3D view could not be loaded')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(sourceReload).toHaveBeenCalled()
  })

  it('re-signs the URL when the renderer itself failed', async () => {
    // A device loss — a driver reset, a laptop waking from sleep — is the
    // common way to land here and is entirely recoverable: a new URL resets
    // the stored status and remounts the canvas. Nothing triggered it.
    canvasStatus = { phase: 'error', percent: null, meshCount: 0, message: 'device lost' }
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(sourceReload).toHaveBeenCalled()
  })
})

/**
 * What the viewport says out loud.
 *
 * Nielsen's first heuristic, and there was not one live region in this whole
 * feature — a forty-second load, its arrival, a renderer that died and two
 * transient confirmations were all carried by pixels alone. The confirmations
 * were the worst of it: a swapped icon and a changed accessible name, neither
 * of which any assistive technology announces.
 */
describe('ModelStage — the status a screen reader hears', () => {
  // Two regions, deliberately: the stage's own status, and the measurement
  // readout. A dimension the reader just took must not queue behind "Modell
  // geladen", and a copy confirmation must not overwrite it.
  const announcement = () => screen.getAllByRole('status')[0].textContent
  const measurementSaid = () => screen.getAllByRole('status')[1].textContent

  it('keeps the measurement channel silent until there is a measurement', () => {
    // A live region that is inserted already holding text is not announced.
    // Both regions are therefore mounted from the start and empty.
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(measurementSaid()).toBe('')
  })

  it('says when the building has arrived', () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(announcement()).toBe('The model is on screen')
  })

  it('says a load is still running rather than staying silent', () => {
    canvasStatus = { phase: 'parsing', percent: null, meshCount: 3 }
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(announcement()).toBe('Putting the building together…')
  })

  it('reports a failure over any progress', () => {
    canvasStatus = { phase: 'error', percent: null, meshCount: 0, message: 'device lost' }
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(announcement()).toBe('The 3D view could not be loaded')
  })
})

/**
 * The drawer's open state is the link, and the link is the state.
 *
 * It used to be local state seeded from the URL once and never written back,
 * so three things disagreed: closing left `tab=` behind and "Ansicht
 * verlinken" handed the recipient a drawer the sender had shut; selecting
 * Überblick deleted the parameter and the link lost the drawer entirely; and
 * arriving at `?tab=compliance` while the stage was already mounted left it
 * closed.
 */
describe('ModelStage — the drawer travels in the link', () => {
  it('writes the tab when the drawer is opened', async () => {
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Details & checks' }))
    expect(lastQuery().get('tab')).toBe('overview')
  })

  it('clears the tab when the drawer is closed', async () => {
    searchParams = new URLSearchParams('model=Haus-A.ifc&tab=quantities')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Details & checks' }))
    expect(lastQuery().has('tab')).toBe(false)
  })

  it('keeps the drawer shut for a model that is still being read', async () => {
    // A compliance card links in as `?tab=compliance`. With the model still
    // extracting the sheet cannot render, and the toolbar button used to be
    // pressed AND disabled with no panel anywhere — and the first Escape
    // appeared to do nothing, because it took the close-the-drawer branch for
    // a drawer that was not there.
    searchParams = new URLSearchParams('model=Haus-A.ifc&tab=compliance')
    state.models = [model({ status: 'extracting' })]
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    expect(screen.queryByTestId('advanced-sheet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Details & checks' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })
})

/**
 * A link that could not be honoured says so.
 *
 * The stage falls back to the newest ready model when `?model=` names
 * something the project does not have — right thing to do, wrong thing to do
 * silently. The answer said "3 Wände im Erdgeschoss von Haus-A", the viewer
 * opened Haus-B, the storey filter matched nothing, the legend read "(0)", and
 * with one model in the project the rail is hidden so the filename appears
 * nowhere on screen.
 */
describe('ModelStage — when the link and the project disagree', () => {
  it('names the model it opened instead', () => {
    searchParams = new URLSearchParams('model=Haus-Z.ifc')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    // On screen, and spoken. Following an agent's link into the wrong
    // building is the single failure this notice exists to prevent, and it
    // used to be prevented only for people who can see it.
    expect(
      screen.getAllByText(/This link names “Haus-Z.ifc”.*Showing “Haus-A.ifc” instead/)
    ).toHaveLength(2)
  })

  it('says nothing when the link named the model that opened', () => {
    searchParams = new URLSearchParams('model=Haus-A.ifc')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByText(/This link names/)).not.toBeInTheDocument()
  })

  it('still opens after a rename the link could not know about', () => {
    // The documented recovery, which only ever worked in a test: a real link
    // carries `Haus-A.ifc`, and `'haus-a (final).ifc'.includes('haus-a.ifc')`
    // is false, so the substring match never fired and the fallback did.
    state.models = [model({ filename: 'Haus-A (final).ifc' })]
    searchParams = new URLSearchParams('model=Haus-A.ifc')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.queryByText(/This link names/)).not.toBeInTheDocument()
  })
})

/**
 * A link that arrives carrying highlights.
 *
 * The colours come from somewhere the reader cannot see — an answer, a card, a
 * compliance verdict — so everything the stage says ABOUT them is the only
 * thing that makes them readable: the words the group was given, the count
 * that survived the link's id cap, and the honesty about which of the two
 * kinds of "missing" is in play.
 */
describe('ModelStage — the highlights a link carries', () => {
  /**
   * The query as the sender's browser would actually produce it.
   *
   * Hand-writing the string here would test a link nobody sends: the label is
   * percent-encoded twice on the wire — once by the encoder, once by
   * `URLSearchParams.toString` — and a fixture that encodes it only once
   * passes while the real link fails.
   */
  const linkParams = (view: BimModelView): URLSearchParams =>
    new URLSearchParams(buildModelQuery(view))

  const WALLS = [
    { globalId: 'g-1', expressId: 1, ifcType: 'IfcWall', name: 'Aussenwand Nord', storeyName: 'Erdgeschoss' },
    { globalId: 'g-2', expressId: 2, ifcType: 'IfcWall', name: 'Aussenwand Süd', storeyName: 'Erdgeschoss' },
  ]

  it('labels the legend with the answer’s own words', () => {
    // Before the label travelled, both of these arrived as "Error" — two
    // identical legend rows, and the distinction the answer drew erased.
    state.elements = WALLS
    searchParams = linkParams({
      model: 'Haus-A.ifc',
      highlights: [
        { status: 'fail', label: 'Fluchtweg > 40 m', globalIds: ['g-1'] },
        { status: 'fail', label: 'Türbreite < 80 cm', globalIds: ['g-2'] },
      ],
    })
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    expect(screen.getByText('Fluchtweg > 40 m')).toBeInTheDocument()
    expect(screen.getByText('Türbreite < 80 cm')).toBeInTheDocument()
    expect(screen.queryByText('Error')).not.toBeInTheDocument()
  })

  it('falls back to the severity for a link written without a label', () => {
    state.elements = WALLS
    searchParams = new URLSearchParams('model=Haus-A.ifc&hl=fail:g-1')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)
    expect(screen.getByText('Error')).toBeInTheDocument()
  })

  it('says how many the link could not carry', () => {
    // The card matched 420 walls and the URL holds 60. Without this the
    // legend reads "(2)" beside an answer that said 420 and nothing on screen
    // accounts for the other 418.
    state.elements = WALLS
    searchParams = linkParams({
      model: 'Haus-A.ifc',
      highlights: [{ status: 'fail', label: 'Aussenwände', globalIds: ['g-1', 'g-2'], total: 420 }],
    })
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    // Twice: the pill on screen, and the live region that speaks it. A
    // reader who cannot see a small notice over a full-screen 3D view was the
    // one person this warning was never reaching.
    expect(screen.getAllByText(/A link can carry 2 of the 420 highlighted elements/)).toHaveLength(2)
  })

  it('does not call a highlight missing while the rows are still in flight', () => {
    // Geometry and the element rows are separate requests, and an id resolves
    // only against the rows. Counting them early made every highlight link
    // flash "2 of the highlighted elements are not in this model" and then
    // withdraw it — telling the reader the answer they were sent is wrong
    // about a model that contains every one of those elements.
    state.elements = WALLS
    state.elementsLoading = true
    searchParams = new URLSearchParams('model=Haus-A.ifc&hl=fail:g-1,g-2')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    expect(screen.queryByText(/are not in this model/)).not.toBeInTheDocument()
    // And no legend row claiming zero, which is the same false statement in
    // the other corner of the screen.
    expect(screen.queryByText('(0)')).not.toBeInTheDocument()
  })

  it('does say so once the rows have landed and the ids are genuinely absent', () => {
    state.elements = WALLS
    searchParams = new URLSearchParams('model=Haus-A.ifc&hl=fail:g-1,g-nonexistent')
    render(<ModelStage projectId="p1" onClose={vi.fn()} />)

    expect(
      screen.getAllByText(/1 of the highlighted elements are not in this model/)
    ).toHaveLength(2)
  })
})

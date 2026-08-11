/**
 * The viewport wrapper, tested for the two things that decide whether the
 * feature works for a given user: whether it degrades honestly on a browser
 * with no WebGPU, and whether the heavy WASM viewport is kept out of the
 * bundle until one can actually run.
 *
 * The canvas itself is not exercised here — a WebGPU device cannot be created
 * in happy-dom, so a test that mounted it would only prove the mock works. What
 * it CAN prove is that the mock is never reached when it must not be.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { render, screen } from '@testing-library/react'
import { IfcModelViewer } from './ifc-model-viewer'
import type { IfcViewerStatus } from './ifc-viewer-canvas'
import type { BimViewerElement } from '../lib/model-index'

/**
 * `next/dynamic` renders nothing until the chunk resolves, so the viewport is
 * replaced by a marker. Its PRESENCE is the assertion: it appears only on the
 * paths where the real canvas would have mounted.
 */
/** What the stand-in canvas reports back, for the tests that need a status. */
const canvas: { status: IfcViewerStatus | null } = { status: null }

vi.mock('./ifc-viewer-canvas', () => ({
  IfcViewerCanvas: (props: { sourceUrl: string; onStatus?: (status: IfcViewerStatus) => void }) => {
    const { onStatus } = props
    useEffect(() => {
      if (canvas.status) onStatus?.(canvas.status)
    }, [onStatus])
    return <div data-testid="ifc-canvas" data-source={props.sourceUrl} />
  },
}))

const ELEMENTS: BimViewerElement[] = [
  { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand', storeyName: 'Erdgeschoss' },
]

/** Install or remove `navigator.gpu`, which happy-dom does not provide. */
function setWebGpu(available: boolean): void {
  if (available) {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  } else if ('gpu' in navigator) {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'gpu')
  }
}

afterEach(() => {
  setWebGpu(false)
  canvas.status = null
})

describe('IfcModelViewer without WebGPU', () => {
  it('explains what is missing and what still works, instead of a blank canvas', () => {
    setWebGpu(false)
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)

    expect(screen.getByText('3D view not available in this browser')).toBeInTheDocument()
    // The message names the alternative rather than apologising: the whole
    // model is still readable beside it.
    expect(screen.getByText(/structure, elements, properties and quantities/)).toBeInTheDocument()
  })

  it('never mounts the viewport, so the WASM chunk is never fetched', () => {
    setWebGpu(false)
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
  })
})

describe('IfcModelViewer with WebGPU', () => {
  it('shows the same fallback while the source URL is still being minted', () => {
    setWebGpu(true)
    render(<IfcModelViewer sourceUrl={null} elements={ELEMENTS} />)
    // A canvas with nothing to load would render an empty grey box; saying so
    // is better than showing one.
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(screen.getByText('3D view not available in this browser')).toBeInTheDocument()
  })

  it('mounts the viewport once there is something to draw', async () => {
    setWebGpu(true)
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    // `next/dynamic` renders nothing until the chunk resolves — awaiting it is
    // also the assertion that the viewport is genuinely code-split rather than
    // statically imported.
    expect(await screen.findByTestId('ifc-canvas')).toHaveAttribute(
      'data-source',
      'https://example.test/model.ifc'
    )
  })

  it('renders a legend entry per highlight group, with its resolved count', () => {
    setWebGpu(true)
    render(
      <IfcModelViewer
        sourceUrl="https://example.test/model.ifc"
        elements={ELEMENTS}
        highlights={[
          { globalIds: ['g-w1', 'g-missing'], label: 'Fluchtweg > 40 m', status: 'fail' },
        ]}
      />
    )
    expect(screen.getByText('Fluchtweg > 40 m')).toBeInTheDocument()
    // One of the two ids is not in this model — the legend shows what was
    // actually coloured, not what was asked for.
    expect(screen.getByText('(1)')).toBeInTheDocument()
  })

  it('replaces a failed viewport with an explanation, not an empty canvas', async () => {
    setWebGpu(true)
    canvas.status = {
      phase: 'error',
      percent: null,
      meshCount: 0,
      // The real message from a browser that HAS `navigator.gpu` and still
      // cannot draw — headless, a blocked driver, a remote desktop. Presence of
      // the API is not the same question as an available adapter, which is why
      // `supportsWebGpu` cannot catch this one.
      message: 'Failed to get GPU adapter',
    }
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)

    expect(await screen.findByText('The 3D view could not be loaded')).toBeInTheDocument()
    // What is missing is the picture, and the copy has to say so — an empty
    // grey box reads as a broken feature.
    expect(screen.getByText(/Only the picture is missing/)).toBeInTheDocument()
    // The raw reason travels with it, so a support report does not need a console.
    expect(screen.getByText(/Failed to get GPU adapter/)).toBeInTheDocument()
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
  })

  it('hides the page chrome in the card variant', () => {
    setWebGpu(true)
    const { rerender } = render(
      <IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} variant="page" />
    )
    expect(screen.getByRole('button', { name: /Fit to view/ })).toBeInTheDocument()

    rerender(
      <IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} variant="card" />
    )
    expect(screen.queryByRole('button', { name: /Fit to view/ })).not.toBeInTheDocument()
  })
})

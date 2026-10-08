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
    // The message says what is unaffected rather than apologising — and it
    // says it WITHOUT delivering a verdict on the model. "The model itself is
    // fine" is a clean bill of health issued by an error toast, on a product
    // that never certifies anything and on a file that may carry a hundred
    // Modellprüfung findings. The German says only that the browser is the
    // reason.
    expect(
      screen.getByText(/a browser limitation, not a problem with the model/)
    ).toBeInTheDocument()
  })

  it('never mounts the viewport, so the WASM chunk is never fetched', () => {
    setWebGpu(false)
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
  })
})

describe('IfcModelViewer with WebGPU', () => {
  it('says it is loading while the source URL is being minted, not that the browser cannot', () => {
    // These are two different situations and only one of them is about the
    // browser. Folding them together would tell a browser that HAS WebGPU that
    // it does not — briefly while the presigned URL is minted, and permanently
    // when that request fails.
    setWebGpu(true)
    render(<IfcModelViewer sourceUrl={null} elements={ELEMENTS} />)
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(
      screen.queryByText('3D view not available in this browser')
    ).not.toBeInTheDocument()
    expect(screen.getByText('Loading model…')).toBeInTheDocument()
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

  it('gives a new source its own chance, rather than staying broken', async () => {
    // The error fallback returns BEFORE the canvas renders, so a stored `error`
    // keeps the canvas unmounted — and only the canvas can report a new status.
    // The next model, or a re-signed URL after the first expired, must not stay
    // unavailable until the whole parent unmounts.
    setWebGpu(true)
    canvas.status = { phase: 'error', percent: null, meshCount: 0, message: 'Failed to get GPU adapter' }
    const { rerender } = render(
      <IfcModelViewer sourceUrl="https://example.test/a.ifc" elements={ELEMENTS} />
    )
    expect(await screen.findByText('The 3D view could not be loaded')).toBeInTheDocument()

    canvas.status = null
    rerender(<IfcModelViewer sourceUrl="https://example.test/b.ifc" elements={ELEMENTS} />)

    expect(await screen.findByTestId('ifc-canvas')).toHaveAttribute('data-source', 'https://example.test/b.ifc')
  })

  it('keeps two groups that share a label apart', () => {
    // The URL form groups by STATUS (`?hl=fail:A&hl=fail:B`) and the workspace
    // labels each group from its status, so two `fail` groups arrive with the
    // identical translated label. Two groups with the same label must still be
    // two rows: keyed on that label, React would treat them as one row, and the
    // second group's count would vanish from the legend while its elements stayed
    // coloured — a legend that undercounts what the viewport is showing.
    setWebGpu(true)
    // React does not throw on a duplicate key, it warns and then reconciles
    // wrongly on the NEXT update — which no single render can observe. The
    // warning is therefore the assertion: it is React telling us the identity
    // of these rows is undefined from here on.
    const warnings: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      warnings.push(args)
    })

    try {
      const { rerender } = render(
        <IfcModelViewer
          sourceUrl="https://example.test/model.ifc"
          elements={[
            ...ELEMENTS,
            { globalId: 'g-w2', expressId: 22, ifcType: 'IfcWall', name: 'Innenwand', storeyName: 'Erdgeschoss' },
            { globalId: 'g-w3', expressId: 23, ifcType: 'IfcWall', name: 'Trennwand', storeyName: 'Erdgeschoss' },
          ]}
          highlights={[
            { globalIds: ['g-w1'], label: 'nicht erfüllt', status: 'fail' },
            { globalIds: ['g-w2', 'g-w3'], label: 'nicht erfüllt', status: 'fail' },
          ]}
        />
      )

      // The warning is a canary, not the assertion. It depends on React
      // emitting this exact substring through `console.error`, so a reword or
      // a production-mode build turns it into a line that can never fail.
      expect(warnings.flat().join(' ')).not.toContain('same key')

      // These are the assertion: both rows, each with its own count.
      expect(screen.getAllByText('nicht erfüllt')).toHaveLength(2)
      expect(screen.getByText('(1)')).toBeInTheDocument()
      expect(screen.getByText('(2)')).toBeInTheDocument()

      // And the counts FOLLOW the groups through an update: keyed by label, React
      // would treat these as one row and reuse the first one's subtree, so a
      // reordered pair would render with the old counts.
      rerender(
        <IfcModelViewer
          sourceUrl="https://example.test/model.ifc"
          elements={[
            ...ELEMENTS,
            { globalId: 'g-w2', expressId: 22, ifcType: 'IfcWall', name: 'Innenwand', storeyName: 'Erdgeschoss' },
            { globalId: 'g-w3', expressId: 23, ifcType: 'IfcWall', name: 'Trennwand', storeyName: 'Erdgeschoss' },
          ]}
          highlights={[
            { globalIds: ['g-w2', 'g-w3'], label: 'nicht erfüllt', status: 'fail' },
            { globalIds: ['g-w1'], label: 'nicht erfüllt', status: 'fail' },
          ]}
        />
      )
      const counts = screen.getAllByText(/^\(\d\)$/).map((node) => node.textContent)
      expect(counts).toEqual(['(2)', '(1)'])
    } finally {
      spy.mockRestore()
    }
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

  it('draws no controls at all — this is the viewport, not the stage', async () => {
    // The controls belong to `ModelStage`, not here: a `variant` prop on the
    // viewport is how one component ends up rendering a toolbar, a legend, a
    // status chip and a hint line each behind its own condition, and a file
    // preview must not sprout a section slider.
    setWebGpu(true)
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    await screen.findByTestId('ifc-canvas')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('shows a real percentage while the file downloads', async () => {
    setWebGpu(true)
    canvas.status = { phase: 'downloading', percent: 42, meshCount: 0 }
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
  })

  it('claims no position while the geometry is being built', async () => {
    // Parsing has no known end, and a mesh count would fill the gap with a
    // number that measures the exporter's tessellation settings and tells an
    // architect nothing about how long they are waiting.
    setWebGpu(true)
    canvas.status = { phase: 'parsing', percent: null, meshCount: 12847 }
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    const bar = await screen.findByRole('progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(/12847|12.847/)).not.toBeInTheDocument()
  })

  it('clears the veil once the building is on screen', async () => {
    setWebGpu(true)
    canvas.status = { phase: 'ready', percent: 100, meshCount: 19 }
    render(<IfcModelViewer sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} />)
    await screen.findByTestId('ifc-canvas')
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})

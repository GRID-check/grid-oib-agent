/**
 * The model as a file preview.
 *
 * What matters here is not the picture — happy-dom cannot create a WebGPU
 * device, so the canvas is a marker — but that each of the four things that can
 * be true of an `.ifc` in the Dateien pane produces a DIFFERENT answer. "Still
 * being read", "could not be read", "there is no model" and "the list did not
 * load" are four distinct facts, and collapsing any of them into "no preview"
 * would tell a user their upload vanished.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IfcFilePreview } from './ifc-file-preview'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import type { BimViewerElement } from '../lib/model-index'

vi.mock('./ifc-viewer-canvas', () => ({
  IfcViewerCanvas: (props: { sourceUrl: string }) => (
    <div data-testid="ifc-canvas" data-source={props.sourceUrl} />
  ),
}))

interface ModelsState {
  data: BimModelHeaderView[] | null
  isLoading: boolean
  error: string | null
}

/** What the mocked hooks return for the test currently running. */
const state: {
  models: ModelsState
  elements: BimViewerElement[]
  source: string | null
} = {
  models: { data: [], isLoading: false, error: null },
  elements: [],
  source: 'https://example.test/model.ifc',
}

vi.mock('../hooks/use-bim-model', () => ({
  useProjectBimModels: () => ({ ...state.models, reload: () => {} }),
  useBimElements: () => ({ data: state.elements, isLoading: false, error: null }),
  useBimModelSource: (modelId: string | null, enabled: boolean) =>
    modelId && enabled ? state.source : null,
}))

function model(overrides: Partial<BimModelHeaderView> = {}): BimModelHeaderView {
  return {
    id: 'model-1',
    documentId: 'doc-1',
    projectId: 'proj-1',
    filename: 'Haus-A.ifc',
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 1200,
    errorMessage: null,
    summary: null,
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  }
}

/** Install or remove `navigator.gpu`, which happy-dom does not provide. */
function setWebGpu(available: boolean): void {
  if (available) {
    Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true })
  } else if ('gpu' in navigator) {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'gpu')
  }
}

function renderPreview(): void {
  render(<IfcFilePreview documentId="doc-1" filename="Haus-A.ifc" projectId="proj-1" />)
}

afterEach(() => {
  setWebGpu(false)
  state.models = { data: [], isLoading: false, error: null }
  state.elements = []
  state.source = 'https://example.test/model.ifc'
})

describe('IfcFilePreview', () => {
  it('shows the building itself when the model is ready', async () => {
    setWebGpu(true)
    state.models = { data: [model()], isLoading: false, error: null }
    renderPreview()

    // `next/dynamic` resolves the viewport chunk a tick later, so this is
    // awaited — the same reason the viewer's own spec awaits it.
    const canvas = await screen.findByTestId('ifc-canvas')
    expect(canvas.dataset.source).toBe('https://example.test/model.ifc')
  })

  it('finds the model by DOCUMENT, so another project model in the list is not shown instead', () => {
    setWebGpu(true)
    state.models = {
      data: [model({ id: 'other', documentId: 'doc-2', filename: 'Haus-B.ifc' })],
      isLoading: false,
      error: null,
    }
    renderPreview()

    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(screen.getByText('No model has been read from this file.')).toBeInTheDocument()
  })

  it('says the model is still being read rather than that there is none', () => {
    setWebGpu(true)
    state.models = { data: [model({ status: 'extracting' })], isLoading: false, error: null }
    renderPreview()

    expect(screen.getByText(/still reading this model/)).toBeInTheDocument()
    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
  })

  it('distinguishes an extraction that FAILED from a file with no model', () => {
    setWebGpu(true)
    state.models = { data: [model({ status: 'failed' })], isLoading: false, error: null }
    renderPreview()

    expect(screen.getByText(/could not be read/)).toBeInTheDocument()
    expect(screen.queryByText('No model has been read from this file.')).not.toBeInTheDocument()
  })

  it('does not report a failed model list as "no model"', () => {
    setWebGpu(true)
    state.models = { data: null, isLoading: false, error: 'load-failed' }
    renderPreview()

    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument()
    expect(screen.queryByText('No model has been read from this file.')).not.toBeInTheDocument()
  })

  it('never mounts the viewport without WebGPU, and names the workspace instead of the pane it is not in', () => {
    setWebGpu(false)
    state.models = { data: [model()], isLoading: false, error: null }
    renderPreview()

    expect(screen.queryByTestId('ifc-canvas')).not.toBeInTheDocument()
    expect(screen.getByText(/needs WebGPU/)).toBeInTheDocument()
    // The viewer's own fallback points at "the left" — the model page's element
    // tables — which do not exist in a file preview.
    expect(screen.queryByText(/still available on the left/)).not.toBeInTheDocument()
  })

  it('links to the workspace by FILE NAME, so the link opens this model and carries no uuid', () => {
    setWebGpu(true)
    state.models = { data: [model()], isLoading: false, error: null }
    renderPreview()

    const link = screen.getByRole('link', { name: /Open in model workspace/ })
    expect(link.getAttribute('href')).toBe('/app/projects/proj-1/files?model=Haus-A.ifc')
  })

  it('offers no way in when nothing was ever read from the file', () => {
    setWebGpu(true)
    state.models = { data: [], isLoading: false, error: null }
    renderPreview()

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

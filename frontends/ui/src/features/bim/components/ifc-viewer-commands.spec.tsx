/**
 * Fit and re-selecting the active view.
 *
 * Both were broken and both were invisible to the existing specs, for the same
 * reason: `ifc-model-viewer.spec.tsx` mocks the canvas as a plain function, so
 * it never exercised the boundary that broke.
 *
 * 1. Fit went through `useImperativeHandle`. The canvas is behind
 *    `next/dynamic`, whose `LoadableComponent` is a plain function component,
 *    so on React 18 the JSX runtime strips `ref` before it arrives. The
 *    parent's `canvasRef.current` was React's internal lazy-retry object —
 *    truthy, so `?.fit()` did not short-circuit and every click threw.
 * 2. The view effect keyed on the view NAME. Orbiting away and pressing the
 *    same view again changed no prop, so the button was pressed and inert.
 *
 * Both are now ordinary numeric props, so this spec asserts on what the canvas
 * actually receives — which is the thing a ref could not deliver.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const received: Array<{ view: string; viewNonce: number; fitNonce: number }> = []

vi.mock('./ifc-viewer-canvas', () => ({
  IfcViewerCanvas: (props: {
    view: string
    viewNonce: number
    fitNonce: number
    onStatus?: (s: { phase: string; percent: null; meshCount: number }) => void
  }) => {
    received.push({ view: props.view, viewNonce: props.viewNonce, fitNonce: props.fitNonce })
    return (
      <button type="button" onClick={() => props.onStatus?.({ phase: 'ready', percent: null, meshCount: 3 })}>
        mark-ready
      </button>
    )
  },
}))

vi.mock('../lib/model-index', async () => {
  const actual = await vi.importActual<typeof import('../lib/model-index')>('../lib/model-index')
  return { ...actual, supportsWebGpu: () => true }
})

import { IfcModelViewer } from './ifc-model-viewer'

async function ready() {
  received.length = 0
  render(<IfcModelViewer sourceUrl="https://example.test/m.ifc" elements={[]} variant="page" />)
  // The toolbar is disabled until the model reports ready.
  await userEvent.click(await screen.findByRole('button', { name: 'mark-ready' }))
}

describe('viewport commands', () => {
  it('asks the canvas to fit without going through a ref', async () => {
    await ready()
    const before = received.at(-1)!.fitNonce

    await userEvent.click(screen.getByRole('button', { name: /Fit to view/ }))

    expect(received.at(-1)!.fitNonce).toBe(before + 1)
  })

  it('re-snaps when the reader presses the view they are already on', async () => {
    await ready()
    await userEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const first = received.at(-1)!
    expect(first.view).toBe('top')

    await userEvent.click(screen.getByRole('button', { name: 'Plan' }))
    const second = received.at(-1)!

    // The name cannot carry this — only the counter can.
    expect(second.view).toBe('top')
    expect(second.viewNonce).toBe(first.viewNonce + 1)
  })

  it('does not fit merely because a view changed', async () => {
    await ready()
    const before = received.at(-1)!.fitNonce

    await userEvent.click(screen.getByRole('button', { name: 'North' }))

    expect(received.at(-1)!.fitNonce).toBe(before)
  })
})

/**
 * Driving the render — the theme half, which is the half that was wrong.
 *
 * Mermaid's `themeVariables` are set at INIT, and the render is client-side, so
 * a diagram drawn under one theme stays drawn under it forever unless something
 * makes the change reach an already-mounted drawing. Nothing did. And because
 * the bytes on screen were also the bytes that got filed, fixing that alone
 * would have meant a dark-theme drawing landing in a PDF that prints on white.
 */
import { act, renderHook, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from '@/features/layout/store'

const renderer = vi.fn()
vi.mock('./render-diagram', () => ({
  diagramRendererFor: () => renderer,
}))

import { useRenderedDiagram } from './use-rendered-diagram'

const SOURCE = 'graph TD\n  A --> B'

/** The renderer answers with the theme it was asked for, so calls are legible. */
beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.className = ''
  renderer.mockImplementation(({ theme }: { theme: string }) => Promise.resolve(`<svg data-theme="${theme}"/>`))
})

afterEach(() => {
  document.documentElement.className = ''
  useLayoutStore.setState({ theme: 'system' })
})

describe('in the theme the reader is actually in', () => {
  it('draws on paper, and files the very same string', async () => {
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.svg).toBe('<svg data-theme="light"/>'))
    // Not a copy: the same string, so nothing can make the file disagree with
    // the picture in the theme most readers are in.
    expect(result.current.fileSvg).toBe(result.current.svg)
    expect(renderer).toHaveBeenCalledTimes(1)
  })

  it('draws on charcoal when the page is dark', async () => {
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.svg).toBe('<svg data-theme="dark"/>'))
  })

  it('files the paper copy even when the screen is dark', async () => {
    // A file that only reads correctly inside the dark app is a broken file:
    // the SVG previews on a paper surface and the PDF is a white page.
    document.documentElement.classList.add('dark')
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.fileSvg).toBe('<svg data-theme="light"/>'))
    expect(result.current.svg).toBe('<svg data-theme="dark"/>')
  })
})

describe('when the reader flips the theme', () => {
  /**
   * The theme is delivered by three subscriptions that all read the same
   * snapshot — the `.dark` class (see `use-diagram-theme.ts`). This drives the
   * STORE one, because happy-dom's `MutationObserver` is a stub that delivers
   * no attribute records at all (it has no `takeRecords`), so the observer
   * route cannot be exercised in this environment. It is exercised for real by
   * `visual/capture.mjs`, which shoots both themes off one page load by
   * toggling exactly this class — the dark screenshot IS that test.
   */
  const flipToDark = (): void => {
    act(() => {
      document.documentElement.classList.add('dark')
      useLayoutStore.setState({ theme: 'dark' })
    })
  }

  it('redraws the mounted diagram instead of leaving a stale one', async () => {
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.svg).toBe('<svg data-theme="light"/>'))
    flipToDark()
    await waitFor(() => expect(result.current.svg).toBe('<svg data-theme="dark"/>'))
  })

  it('gives mermaid a fresh id each time, so two markers cannot collide', async () => {
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.svg).not.toBeNull())
    flipToDark()
    await waitFor(() => expect(renderer.mock.calls.length).toBeGreaterThan(1))
    const ids = renderer.mock.calls.map((call) => (call[0] as { id: string }).id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('when mermaid refuses the source', () => {
  it('reports a failure and holds no half-drawn bytes for the filing button', async () => {
    renderer.mockRejectedValue(new Error('Parse error on line 2'))
    const { result } = renderHook(() => useRenderedDiagram(SOURCE))
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.svg).toBeNull()
    expect(result.current.fileSvg).toBeNull()
  })

  it('drops the paper copy of a drawing that is no longer drawn', async () => {
    // The dangerous shape: a diagram drew, the source changed, the new source
    // is broken — and the filing button still holds the OLD paper bytes. The
    // reader would file a picture the answer has stopped showing.
    const { result, rerender } = renderHook(({ source }) => useRenderedDiagram(source), {
      initialProps: { source: SOURCE },
    })
    await waitFor(() => expect(result.current.fileSvg).not.toBeNull())
    renderer.mockRejectedValue(new Error('Parse error on line 2'))
    rerender({ source: 'graph TD\n  A -->' })
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.fileSvg).toBeNull()
  })
})

describe('while the answer is still arriving', () => {
  it('does not draw at all', async () => {
    renderHook(() => useRenderedDiagram(SOURCE, false))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(renderer).not.toHaveBeenCalled()
  })
})

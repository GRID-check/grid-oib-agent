import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useVisualViewport, VISUAL_VIEWPORT_HEIGHT_VAR } from './use-visual-viewport'

// A minimal VisualViewport: the hook reads height, scale and offsetTop and
// listens for resize/scroll. jsdom has none, which is also the "browser without
// the API" case.
class FakeVisualViewport extends EventTarget {
  height = 800
  scale = 1
  offsetTop = 0
}

const LAYOUT_HEIGHT = 800

const published = (): string =>
  document.documentElement.style.getPropertyValue(VISUAL_VIEWPORT_HEIGHT_VAR)

describe('useVisualViewport', () => {
  let viewport: FakeVisualViewport
  let scrollTo: ReturnType<typeof vi.fn>
  // Pending animation frames, flushed by hand: the write is coalesced to one
  // per frame, and the specs decide when a frame happens.
  let frames: FrameRequestCallback[]

  const flushFrame = (): void => {
    const pending = frames
    frames = []
    pending.forEach((cb) => cb(0))
  }

  beforeEach(() => {
    viewport = new FakeVisualViewport()
    vi.stubGlobal('visualViewport', viewport)
    scrollTo = vi.fn()
    vi.stubGlobal('scrollTo', scrollTo)
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: LAYOUT_HEIGHT,
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.style.removeProperty(VISUAL_VIEWPORT_HEIGHT_VAR)
  })

  const openKeyboard = (visibleHeight: number, offsetTop = 0): void => {
    viewport.height = visibleHeight
    viewport.offsetTop = offsetTop
    viewport.dispatchEvent(new Event('resize'))
    flushFrame()
  }

  test('publishes nothing while the visual viewport is the whole screen (desktop, Android)', () => {
    renderHook(() => useVisualViewport())
    expect(published()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  test('the iOS keyboard: publishes the visible height and cancels the document pan', () => {
    renderHook(() => useVisualViewport())
    openKeyboard(460, 300)
    expect(published()).toBe('460px')
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  test('closing the keyboard removes the variable, so the shell is 100dvh again', () => {
    renderHook(() => useVisualViewport())
    openKeyboard(460)
    openKeyboard(LAYOUT_HEIGHT)
    expect(published()).toBe('')
  })

  test('a burst of resize events during the keyboard animation is one write per frame', () => {
    renderHook(() => useVisualViewport())
    for (const height of [700, 600, 500]) {
      viewport.height = height
      viewport.dispatchEvent(new Event('resize'))
    }
    expect(frames).toHaveLength(1)
    flushFrame()
    expect(published()).toBe('500px')
  })

  test('pinch zoom shrinks the visual viewport too, and is not a keyboard', () => {
    renderHook(() => useVisualViewport())
    viewport.scale = 2
    openKeyboard(400)
    expect(published()).toBe('')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  test('sub-pixel disagreement between the two viewports is ignored', () => {
    renderHook(() => useVisualViewport())
    openKeyboard(LAYOUT_HEIGHT - 0.5)
    expect(published()).toBe('')
  })

  test('unmount stops listening and leaves no variable behind', () => {
    const { unmount } = renderHook(() => useVisualViewport())
    openKeyboard(460)
    unmount()
    expect(published()).toBe('')
    openKeyboard(300)
    expect(published()).toBe('')
  })

  test('does nothing where visualViewport is missing', () => {
    vi.stubGlobal('visualViewport', undefined)
    expect(() => renderHook(() => useVisualViewport())).not.toThrow()
    expect(published()).toBe('')
  })
})

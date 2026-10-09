/**
 * The frame a drawing arrives in follows the drawing's LAID-OUT height, not
 * the height it has on the frame it mounts. happy-dom has no layout, so the
 * drawn content's height and the observer that reports it are stubbed: the
 * content mounts at one height and settles at another a frame later, which is
 * what a view does when it measures its nodes and lays them out.
 */
import { render, screen, waitFor } from '@/test-utils'
import { AnimatePresence } from 'motion/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DRAWING_SKELETON_HEIGHT, DrawingCaption, DrawingReveal } from './drawing-skeleton'

/** `useMotionToken` reads the media query itself, so the query is the switch. */
function preferReducedMotion(reduce: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  )
}

/** The drawn content's height, as layout would report it. */
let contentHeight = 0
const observers = new Set<() => void>()

class ReportingResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  private readonly report = () => this.callback([], this as unknown as ResizeObserver)
  observe(): void {
    observers.add(this.report)
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this.report)
  }
}

const originalResizeObserver = globalThis.ResizeObserver
const originalRect = HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  preferReducedMotion(false)
  contentHeight = 0
  observers.clear()
  globalThis.ResizeObserver = ReportingResizeObserver as unknown as typeof globalThis.ResizeObserver
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = originalRect.call(this)
    return this.classList.contains('flow-root')
      ? ({ ...rect.toJSON(), height: contentHeight } as DOMRect)
      : rect
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.ResizeObserver = originalResizeObserver
  HTMLElement.prototype.getBoundingClientRect = originalRect
})

/**
 * Every height the frame was given, in order. Recorded at the write, because
 * an instant tween writes two heights in one task and the element only shows
 * the last (and happy-dom reports no CSSOM write to a MutationObserver).
 */
function recordHeights(frame: HTMLElement): string[] {
  const seen: string[] = [frame.style.height]
  const style = frame.style
  const proto = Object.getPrototypeOf(style) as object
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'height')
  Object.defineProperty(style, 'height', {
    configurable: true,
    get: () => descriptor?.get?.call(style) as string,
    set: (value: string) => {
      descriptor?.set?.call(style, value)
      if (seen.at(-1) !== style.height) seen.push(style.height)
    },
  })
  return seen
}

/** Mount undrawn, then draw content that lays out a frame after it mounts. */
async function drawWithLateLayout() {
  const { container, rerender } = render(<DrawingReveal drawn={false} />)
  const frame = container.querySelector('div.relative') as HTMLElement
  expect(frame.style.height).toBe(`${DRAWING_SKELETON_HEIGHT}px`)
  const heights = recordHeights(frame)

  // Mounts at its pre-layout height (below the skeleton's, as a mindmap
  // does), then lays out on the next frame.
  contentHeight = 101
  rerender(
    <DrawingReveal drawn>
      <p>Zeichnung</p>
    </DrawingReveal>
  )
  requestAnimationFrame(() => {
    contentHeight = 222
    observers.forEach((report) => report())
  })
  await waitFor(() => expect(frame.style.height).toBe('auto'), { timeout: 2000 })
  return {
    frame,
    heights: heights.filter((height) => height !== 'auto').map((height) => parseFloat(height)),
  }
}

describe('DrawingReveal', () => {
  test('grows from the skeleton to the laid-out height, never toward the height the drawing mounted at', async () => {
    const { frame, heights } = await drawWithLateLayout()
    // Only ever growing: aiming at the pre-layout 101px first made the frame
    // dip under the skeleton and come back up.
    heights.slice(1).forEach((height, at) => expect(height).toBeGreaterThanOrEqual(heights[at]!))
    expect(heights.length).toBeGreaterThan(2)
    expect(heights.at(-1)).toBe(222)
    // Let go to `auto` and the clip once it stands.
    expect(frame.className).not.toContain('overflow-hidden')
  })

  test('under reduced motion stands at the laid-out height at once, with no step between', async () => {
    preferReducedMotion(true)
    const { heights } = await drawWithLateLayout()
    expect(heights).toEqual([DRAWING_SKELETON_HEIGHT, 222])
  })

  test('a drawing that mounts drawn stands at once, unclipped', () => {
    contentHeight = 222
    render(
      <DrawingReveal drawn>
        <p>Zeichnung</p>
      </DrawingReveal>
    )
    const frame = screen.getByText('Zeichnung').closest('div.relative') as HTMLElement
    expect(frame.style.height).not.toBe(`${DRAWING_SKELETON_HEIGHT}px`)
    expect(frame.className).not.toContain('overflow-hidden')
    expect(observers.size).toBe(0)
  })

  test('the skeleton stands in the same frame while the drawing is not drawn', () => {
    render(<DrawingReveal drawn={false} />)
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })
})

describe('DrawingCaption', () => {
  test('one that arrives after the figure grows from nothing instead of landing whole', () => {
    const { rerender } = render(<AnimatePresence initial={false}>{null}</AnimatePresence>)
    rerender(
      <AnimatePresence initial={false}>
        <DrawingCaption key="caption">Im Projekt ablegen</DrawingCaption>
      </AnimatePresence>
    )
    const caption = screen.getByText('Im Projekt ablegen')
    expect(caption.tagName).toBe('FIGCAPTION')
    expect(caption.style.height).toBe('0px')
  })

  test('one already there when the figure mounts stands at once', () => {
    render(
      <AnimatePresence initial={false}>
        <DrawingCaption key="caption">Im Projekt ablegen</DrawingCaption>
      </AnimatePresence>
    )
    expect(screen.getByText('Im Projekt ablegen').style.height).not.toBe('0px')
  })
})

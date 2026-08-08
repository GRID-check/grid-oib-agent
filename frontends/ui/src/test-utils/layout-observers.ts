/**
 * Layout observers for a DOM with no layout.
 *
 * happy-dom implements `ResizeObserver` and `IntersectionObserver` as inert
 * classes: they exist, `observe()` accepts a node, and the callback is never
 * called, because there is no layout engine to produce a size or an
 * intersection. A component that waits to be told how wide it is therefore
 * waits forever, and a component that renders only what is on screen renders
 * nothing — in both cases the test sees an empty container and the failure
 * looks like the component's, not the environment's.
 *
 * These stubs report ONCE, synchronously, on `observe()`, with the numbers the
 * test asks for. Each is widened at a single documented boundary because a stub
 * cannot satisfy the whole DOM interface it stands in for.
 */

export interface LayoutObserverOptions {
  /** Width every observed element reports. */
  frameWidth?: number
  /** Whether observed elements report as on screen. */
  intersecting?: boolean
}

const DEFAULT_FRAME_WIDTH = 1024

/**
 * Install both observers for the current test and return the restore function.
 * Call it from `beforeEach` and restore in `afterEach`.
 */
export const installLayoutObservers = ({
  frameWidth = DEFAULT_FRAME_WIDTH,
  intersecting = true,
}: LayoutObserverOptions = {}): (() => void) => {
  const originalResize = globalThis.ResizeObserver
  const originalIntersection = globalThis.IntersectionObserver

  class ImmediateResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback(
        [{ contentRect: { width: frameWidth } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  class ImmediateIntersectionObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(): void {
      this.callback(
        [{ isIntersecting: intersecting } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }
    unobserve(): void {}
    disconnect(): void {}
  }

  globalThis.ResizeObserver = ImmediateResizeObserver as unknown as typeof globalThis.ResizeObserver
  globalThis.IntersectionObserver =
    ImmediateIntersectionObserver as unknown as typeof globalThis.IntersectionObserver

  return () => {
    globalThis.ResizeObserver = originalResize
    globalThis.IntersectionObserver = originalIntersection
  }
}

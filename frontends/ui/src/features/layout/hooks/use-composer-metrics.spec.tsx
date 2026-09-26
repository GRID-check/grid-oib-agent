/**
 * The composer's geometry, and the one thing about it that cannot be seen.
 *
 * This hook measures two boxes and hands back a resting place and a transition.
 * Every one of those numbers has a fallback, which is what makes it dangerous:
 * when the measurement silently does not happen, nothing throws, nothing looks
 * obviously wrong, and every consumer quietly uses its fallback instead. That is
 * exactly what happened — the composer was measured from a `[]`-dep mount effect
 * reading a ref box, so it measured nothing at all whenever the composer mounted
 * later than its column, and the `/dev` preview (which renders nothing on its
 * first pass) had been in that state for as long as it had existed. It was found
 * by eye, in a browser, which is the failure mode this file exists to end.
 *
 * happy-dom has no layout engine, so the three properties the hook reads are
 * stubbed on the prototype and driven from `data-h`. That is the whole fixture:
 * `data-h` is the height an element reports, and an element's offsetParent is
 * its DOM parent, which is true of the real structure too (the composer stack is
 * `absolute` inside the `relative` chat column).
 */

import type { JSX } from 'react'
import { render } from '@testing-library/react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useComposerMetrics, type ComposerMetrics } from './use-composer-metrics'
import { installLayoutObservers } from '@/test-utils/layout-observers'

/** Column 900, composer 206 → lift (900 − 206 − 32 − 28) / 2 = 317. */
const COLUMN_H = 900
const COMPOSER_H = 206
const EXPECTED_LIFT = 317
/** composerH + lift + gap. */
const EXPECTED_WELCOME_OFFSET = 555

let restoreObservers: () => void
const originalDescriptors: Record<string, PropertyDescriptor | undefined> = {}

const stubLayout = (): void => {
  for (const prop of ['offsetHeight', 'clientHeight', 'offsetParent'] as const) {
    originalDescriptors[prop] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop)
  }
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.h ?? 0)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.dataset.h ?? 0)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    },
  })
}

const restoreLayout = (): void => {
  for (const [prop, descriptor] of Object.entries(originalDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
  }
}

interface HarnessProps {
  isThreadEmpty: boolean
  /** Whether the composer is in the tree yet — false reproduces a late mount. */
  composerMounted?: boolean
  composerHeight?: number
  columnHeight?: number
}

/** The app's structure, reduced to the two boxes the hook measures. */
const Harness = ({
  isThreadEmpty,
  composerMounted = true,
  composerHeight = COMPOSER_H,
  columnHeight = COLUMN_H,
}: HarnessProps): JSX.Element => {
  const metrics = useComposerMetrics(isThreadEmpty)
  latest = metrics
  return (
    <div data-testid="column" data-h={columnHeight} style={metrics.columnVars}>
      {composerMounted && (
        <div data-testid="composer" data-h={composerHeight} ref={metrics.composerRef} />
      )}
    </div>
  )
}

/** The last value the harness rendered with — the hook's return under test. */
let latest: ComposerMetrics

const columnVar = (container: HTMLElement, name: string): string | null =>
  container.querySelector<HTMLElement>('[data-testid="column"]')!.style.getPropertyValue(name) ||
  null

describe('useComposerMetrics', () => {
  beforeEach(() => {
    restoreObservers = installLayoutObservers()
    stubLayout()
  })

  afterEach(() => {
    restoreLayout()
    restoreObservers()
  })

  test('measures a composer that mounts AFTER its column', () => {
    // The regression. A mount effect reading a ref box saw `null` here and,
    // having no dependencies, never looked again: the hook then published
    // nothing at all and every consumer fell back for the life of the page.
    const { container, rerender } = render(<Harness isThreadEmpty composerMounted={false} />)
    expect(columnVar(container, '--composer-h')).toBeNull()

    rerender(<Harness isThreadEmpty composerMounted />)

    expect(columnVar(container, '--composer-h')).toBe(`${COMPOSER_H}px`)
    expect(columnVar(container, '--welcome-offset')).toBe(`${EXPECTED_WELCOME_OFFSET}px`)
    expect(latest.composerMotion.animate.y).toBe(-EXPECTED_LIFT)
  })

  test('lifts the composer on an empty thread and floors it on a populated one', () => {
    const { rerender } = render(<Harness isThreadEmpty />)
    expect(latest.composerMotion.animate.y).toBe(-EXPECTED_LIFT)

    rerender(<Harness isThreadEmpty={false} />)
    expect(latest.composerMotion.animate.y).toBe(0)
  })

  test('never lifts the composer off the bottom of a short column', () => {
    // Leftover height goes negative on a phone in landscape. A negative lift
    // would push the composer off the bottom rather than simply not lift it.
    render(<Harness isThreadEmpty columnHeight={180} />)
    expect(latest.composerMotion.animate.y).toBe(0)
  })

  test('travels only when the thread stops being empty', () => {
    // Placement is not a journey. The lift also changes for reasons that are
    // pure arithmetic — the composer measuring 0px for a frame before its own
    // content mounts, a banner appearing, a resize — and animating those opened
    // every new chat with the composer sailing up from the floor.
    const { rerender } = render(<Harness isThreadEmpty />)
    expect(latest.composerMotion.transition).toEqual({ duration: 0 })
    expect(latest.composerMotion.initial).toBe(false)

    rerender(<Harness isThreadEmpty={false} />)
    expect(latest.composerMotion.transition).toMatchObject({ type: 'spring' })
  })

  test('goes back to placing instantly once the journey has arrived', () => {
    const { rerender } = render(<Harness isThreadEmpty />)
    rerender(<Harness isThreadEmpty={false} />)
    expect(latest.composerMotion.transition).toMatchObject({ type: 'spring' })

    latest.composerMotion.onAnimationComplete()
    rerender(<Harness isThreadEmpty={false} composerHeight={240} />)

    expect(latest.composerMotion.transition).toEqual({ duration: 0 })
  })

  test('freezes the greeting offset when the thread stops being empty', () => {
    // Both numbers under it move in the same tick the greeting starts to leave:
    // the lift goes to zero and the composer shrinks as the sent text leaves the
    // textarea. Live values would drop the greeting half a column in the first
    // frame of its own exit.
    const { container, rerender } = render(<Harness isThreadEmpty />)
    expect(columnVar(container, '--welcome-offset')).toBe(`${EXPECTED_WELCOME_OFFSET}px`)

    rerender(<Harness isThreadEmpty={false} composerHeight={120} />)

    expect(columnVar(container, '--welcome-offset')).toBe(`${EXPECTED_WELCOME_OFFSET}px`)
  })
})

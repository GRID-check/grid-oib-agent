/**
 * A scroller a keyboard can reach, but only when there is something to scroll.
 *
 * A mouse or a finger scrolls a wide table sideways without focus; a keyboard
 * cannot, so the columns past the edge were out of its reach.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { HorizontalScroll } from './horizontal-scroll'

function layout(scrollWidth: number, clientWidth: number): void {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HorizontalScroll', () => {
  it('is a named, focusable region when its content overflows', () => {
    layout(900, 300)
    render(
      <HorizontalScroll aria-label="Tabelle, seitlich scrollbar">
        <table />
      </HorizontalScroll>
    )
    const region = screen.getByRole('region', { name: 'Tabelle, seitlich scrollbar' })
    expect(region).toHaveAttribute('tabindex', '0')
  })

  it('stays out of the tab order and the landmarks when everything fits', () => {
    layout(300, 300)
    const { container } = render(
      <HorizontalScroll aria-label="Tabelle, seitlich scrollbar">
        <table />
      </HorizontalScroll>
    )
    expect(screen.queryByRole('region')).toBeNull()
    expect(container.firstElementChild).not.toHaveAttribute('tabindex')
    expect(container.firstElementChild).not.toHaveAttribute('aria-label')
  })
})

describe('HorizontalScroll, when its content is replaced', () => {
  it('notices a wider child that arrives after mount', () => {
    const observed: Element[] = []
    let notify = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          notify = callback
        }
        observe(target: Element) {
          observed.push(target)
        }
        disconnect() {}
      }
    )
    layout(300, 300)
    const { rerender } = render(
      <HorizontalScroll aria-label="Diagramm, seitlich scrollbar">
        <div data-testid="skeleton" />
      </HorizontalScroll>
    )
    expect(screen.queryByRole('region')).toBeNull()

    // The drawing lands in the skeleton's place and is wider than the column.
    rerender(
      <HorizontalScroll aria-label="Diagramm, seitlich scrollbar">
        <svg data-testid="drawing" />
      </HorizontalScroll>
    )
    layout(900, 300)
    const drawing = screen.getByTestId('drawing')
    // Whatever is observed must still contain the new child, or no resize of
    // it is ever reported.
    expect(
      observed.some(
        (target) =>
          target !== drawing.closest('[class*="overflow-x-auto"]') && target.contains(drawing)
      )
    ).toBe(true)
    act(() => notify())
    expect(screen.getByRole('region', { name: 'Diagramm, seitlich scrollbar' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})

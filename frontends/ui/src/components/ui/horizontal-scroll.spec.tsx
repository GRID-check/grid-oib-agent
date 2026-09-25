/**
 * A scroller a keyboard can reach, but only when there is something to scroll.
 *
 * A mouse or a finger scrolls a wide table sideways without focus; a keyboard
 * cannot, so the columns past the edge were out of its reach.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

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

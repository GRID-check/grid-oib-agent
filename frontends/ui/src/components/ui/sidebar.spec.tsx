/**
 * The rail edge is a resize handle, not a toggle wearing a resize cursor.
 *
 * Every case here fails against the vendored shadcn rail this replaces: that
 * one had exactly one behaviour (click → toggle) behind a `w-resize` cursor, so
 * a drag moved nothing and the width was a constant nobody could reach.
 */

import { useEffect } from 'react'
import { render, screen, fireEvent } from '@/test-utils'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { Sidebar, SidebarProvider, SidebarRail, useSidebar } from './sidebar'

vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }))

const WIDTH_KEY = 'grid.sidebar.width'
const COLLAPSED_KEY = 'grid.sidebar.collapsed'

function Fixture(): React.JSX.Element {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  )
}

/** The `<button>` the reader grabs. */
function rail(): HTMLElement {
  return screen.getByRole('separator', { name: 'Resize sidebar' })
}

/** The element the provider publishes `--sidebar-width` on. */
function wrapper(): HTMLElement {
  return document.querySelector('[data-slot="sidebar-wrapper"]') as HTMLElement
}

function publishedWidth(): string {
  return wrapper().style.getPropertyValue('--sidebar-width')
}

function sidebarState(): string | null {
  return document.querySelector('[data-slot="sidebar"]')!.getAttribute('data-state')
}

/** One press-drag-release, in page coordinates. */
function drag(from: number, to: number): void {
  fireEvent.pointerDown(rail(), { button: 0, clientX: from })
  fireEvent.pointerMove(window, { clientX: to })
  fireEvent.pointerUp(window, { clientX: to })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('SidebarRail - pointer', () => {
  test('drags the rail to a new width and publishes it', () => {
    render(<Fixture />)
    expect(publishedWidth()).toBe('236px')

    drag(236, 316)

    expect(publishedWidth()).toBe('316px')
  })

  test('persists the dragged width, so the next session opens at it', () => {
    render(<Fixture />)

    drag(236, 316)

    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('316')
  })

  test('restores the persisted width on mount', () => {
    window.localStorage.setItem(WIDTH_KEY, '340')

    render(<Fixture />)

    expect(publishedWidth()).toBe('340px')
  })

  test('refuses a stored width that is not a usable number', () => {
    window.localStorage.setItem(WIDTH_KEY, 'wide-ish')

    render(<Fixture />)

    // Not `NaNpx`, which resolves to nothing and leaves the gap and the rail
    // disagreeing about where the page begins.
    expect(publishedWidth()).toBe('236px')
  })

  test('treats a cleared key as no stored width, not as zero', () => {
    window.localStorage.setItem(WIDTH_KEY, '')

    render(<Fixture />)

    expect(publishedWidth()).toBe('236px')
  })

  test('clamps a stored width into the bounds', () => {
    window.localStorage.setItem(WIDTH_KEY, '9000')

    render(<Fixture />)

    expect(publishedWidth()).toBe('420px')
  })

  test('clamps the drag at both bounds', () => {
    render(<Fixture />)

    drag(236, 900)
    expect(publishedWidth()).toBe('420px')

    drag(420, 405)
    expect(publishedWidth()).toBe('405px')

    drag(405, 380)
    expect(publishedWidth()).toBe('380px')
  })

  test('collapses when the drag goes past the floor, keeping the width it had', () => {
    render(<Fixture />)
    drag(236, 300)

    fireEvent.pointerDown(rail(), { button: 0, clientX: 300 })
    fireEvent.pointerMove(window, { clientX: 120 })

    expect(sidebarState()).toBe('collapsed')

    // Back out over the threshold in the same gesture: the rail returns to the
    // width the drag is asking for, not to the default.
    fireEvent.pointerMove(window, { clientX: 260 })
    fireEvent.pointerUp(window, { clientX: 260 })

    expect(sidebarState()).toBe('expanded')
    expect(publishedWidth()).toBe('260px')
  })

  test('drags the collapsed rail back out from the icon column', () => {
    window.localStorage.setItem(COLLAPSED_KEY, 'true')
    render(<Fixture />)
    expect(sidebarState()).toBe('collapsed')

    fireEvent.pointerDown(rail(), { button: 0, clientX: 64 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window, { clientX: 300 })

    expect(sidebarState()).toBe('expanded')
    expect(publishedWidth()).toBe('300px')
  })

  test('a press that does not travel is still the toggle', () => {
    render(<Fixture />)

    fireEvent.pointerDown(rail(), { button: 0, clientX: 236 })
    fireEvent.pointerMove(window, { clientX: 238 })
    fireEvent.pointerUp(window, { clientX: 238 })
    fireEvent.click(rail())

    expect(sidebarState()).toBe('collapsed')
    expect(publishedWidth()).toBe('236px')
  })

  test('a completed drag does not also toggle on the click that ends it', () => {
    render(<Fixture />)

    fireEvent.pointerDown(rail(), { button: 0, clientX: 236 })
    fireEvent.pointerMove(window, { clientX: 316 })
    fireEvent.pointerUp(window, { clientX: 316 })
    fireEvent.click(rail())

    expect(sidebarState()).toBe('expanded')
    expect(publishedWidth()).toBe('316px')
  })

  test('ignores a non-primary button', () => {
    render(<Fixture />)

    fireEvent.pointerDown(rail(), { button: 2, clientX: 236 })
    fireEvent.pointerMove(window, { clientX: 316 })

    expect(publishedWidth()).toBe('236px')
  })

  test('releases the cursor and the selection lock it takes for the drag', () => {
    render(<Fixture />)

    fireEvent.pointerDown(rail(), { button: 0, clientX: 236 })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.style.userSelect).toBe('none')

    fireEvent.pointerUp(window, { clientX: 236 })

    expect(document.body.style.cursor).toBe('')
    expect(document.body.style.userSelect).toBe('')
  })
})

describe('SidebarRail - keyboard', () => {
  test('names both of the edge\'s moves, the right way round for where it is', () => {
    render(<Fixture />)
    expect(rail()).toHaveAttribute('title', 'Drag to resize, click to collapse')

    fireEvent.click(rail())

    // From the icon column there is no width to change yet, only a rail to
    // bring back — offering "resize" there is the same broken promise as before.
    expect(sidebarState()).toBe('collapsed')
    expect(rail()).toHaveAttribute('title', 'Drag or click to expand the sidebar')
  })

  test('is a tab stop that reports the width it controls', () => {
    render(<Fixture />)

    expect(rail()).toHaveAttribute('aria-valuenow', '236')
    expect(rail()).toHaveAttribute('aria-valuemin', '64')
    expect(rail()).toHaveAttribute('aria-valuemax', '420')
    expect(rail()).not.toHaveAttribute('tabindex')
  })

  test('arrows resize by a step, Shift by the coarse one', () => {
    render(<Fixture />)

    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(publishedWidth()).toBe('252px')

    fireEvent.keyDown(rail(), { key: 'ArrowRight', shiftKey: true })
    expect(publishedWidth()).toBe('316px')

    fireEvent.keyDown(rail(), { key: 'ArrowLeft' })
    expect(publishedWidth()).toBe('300px')
    expect(window.localStorage.getItem(WIDTH_KEY)).toBe('300')
  })

  test('Home and End go to the bounds', () => {
    render(<Fixture />)

    fireEvent.keyDown(rail(), { key: 'End' })
    expect(publishedWidth()).toBe('420px')

    fireEvent.keyDown(rail(), { key: 'Home' })
    expect(publishedWidth()).toBe('200px')
  })

  test('one more shrink at the floor collapses, and a grow brings it back', () => {
    render(<Fixture />)

    fireEvent.keyDown(rail(), { key: 'Home' })
    expect(sidebarState()).toBe('expanded')

    fireEvent.keyDown(rail(), { key: 'ArrowLeft' })
    expect(sidebarState()).toBe('collapsed')
    expect(rail()).toHaveAttribute('aria-valuenow', '64')

    fireEvent.keyDown(rail(), { key: 'ArrowRight' })
    expect(sidebarState()).toBe('expanded')
    // The width it had before the collapse, not the default.
    expect(publishedWidth()).toBe('200px')
  })

  test('mirrors the directions on a right-hand rail', () => {
    render(
      <SidebarProvider>
        <Sidebar side="right" collapsible="icon">
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    )

    fireEvent.keyDown(rail(), { key: 'ArrowLeft' })
    expect(publishedWidth()).toBe('252px')

    // And the drag: away from the edge is wider on both sides.
    fireEvent.pointerDown(rail(), { button: 0, clientX: 1000 })
    fireEvent.pointerMove(window, { clientX: 940 })
    fireEvent.pointerUp(window, { clientX: 940 })
    expect(publishedWidth()).toBe('312px')
  })

  test('leaves keys it does not own to the page', () => {
    render(<Fixture />)

    const event = fireEvent.keyDown(rail(), { key: 'PageDown' })

    expect(event).toBe(true)
    expect(publishedWidth()).toBe('236px')
  })
})

describe('useSidebar width', () => {
  test('a controlled `open` still restores the dragged width', () => {
    // The collapse restore returns early when `open` is a prop; the width the
    // reader dragged is not the caller's to withhold.
    window.localStorage.setItem(WIDTH_KEY, '408')

    render(
      <SidebarProvider open={false} onOpenChange={() => {}}>
        <Sidebar collapsible="icon">
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>
    )

    expect(publishedWidth()).toBe('408px')
  })

  test('exposes the width to consumers', () => {
    const seen: number[] = []
    const Probe = (): null => {
      const { width } = useSidebar()
      useEffect(() => {
        seen.push(width)
      }, [width])
      return null
    }

    render(
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarRail />
        </Sidebar>
        <Probe />
      </SidebarProvider>
    )
    drag(236, 316)

    expect(seen.at(-1)).toBe(316)
  })
})

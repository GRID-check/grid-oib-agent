/**
 * The lazy peek: no popover until the trigger is engaged, and the trigger the
 * reader touched is the node that answers.
 *
 * The second half is the one that regresses silently. Mounting the popover
 * AROUND the trigger at engagement moves the trigger in the React tree, React
 * remounts it, and the focus or tap that engaged it lands on a detached node.
 * Every "same node" assertion below fails under that design.
 */

import type { FC } from 'react'
import { render, screen, waitFor, fireEvent } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { popoverMounts, resetPopoverMounts } from '@/test-utils/popover-mounts'
import { HoverPeekPanel } from './hover-peek-panel'

vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/test-utils/popover-mounts')).countPopoverMounts(await importOriginal())
)

const Peek: FC<{ name: string; onTriggerClick?: (target: EventTarget) => void }> = ({
  name,
  onTriggerClick,
}) => {
  const peek = useHoverPopover()
  return (
    <>
      <button
        type="button"
        {...peek.triggerProps}
        onClick={(event) => {
          onTriggerClick?.(event.currentTarget)
          peek.triggerProps.onClick()
        }}
      >
        {name}
      </button>
      <HoverPeekPanel peek={peek} className="w-64">
        <p>{`${name} body`}</p>
      </HoverPeekPanel>
    </>
  )
}

const Page: FC<{ onTriggerClick?: (target: EventTarget) => void }> = ({ onTriggerClick }) => (
  <div>
    <Peek name="Anna" onTriggerClick={onTriggerClick} />
    <Peek name="Ben" />
    <button type="button">Elsewhere</button>
  </div>
)

const trigger = (name: string) => screen.getByRole('button', { name })

describe('HoverPeekPanel', () => {
  beforeEach(() => resetPopoverMounts())

  test('mounts no popover until a trigger is engaged, and keeps the ARIA contract', () => {
    render(<Page />)

    expect(popoverMounts.total).toBe(0)
    for (const name of ['Anna', 'Ben']) {
      expect(trigger(name)).toHaveAttribute('aria-haspopup', 'dialog')
      expect(trigger(name)).toHaveAttribute('aria-expanded', 'false')
    }
  })

  test('hover engages only that trigger, opens after the delay, and closes on leave', async () => {
    const user = userEvent.setup()
    render(<Page />)
    const anna = trigger('Anna')

    await user.hover(anna)
    expect(popoverMounts.current).toBe(1)
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    expect(trigger('Anna')).toBe(anna)
    expect(anna).toHaveAttribute('aria-expanded', 'true')

    await user.unhover(anna)
    await waitFor(() => expect(screen.queryByText('Anna body')).toBeNull())
    expect(anna).toHaveAttribute('aria-expanded', 'false')
    // Engaged once, kept: a second hover pays nothing to mount again.
    expect(popoverMounts.total).toBe(1)
  })

  test('keyboard focus opens the peek and stays on the same button', async () => {
    const user = userEvent.setup()
    render(<Page />)
    const anna = trigger('Anna')

    await user.tab()
    expect(document.activeElement).toBe(anna)
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    // After the popover mounted beside it, the focused node is still the one
    // in the document — not a detached twin.
    expect(anna.isConnected).toBe(true)
    expect(trigger('Anna')).toBe(anna)
    expect(document.activeElement).toBe(anna)
  })

  test('a touch tap reaches the click on the original button and pins the peek', async () => {
    const user = userEvent.setup()
    const clicked = vi.fn()
    render(<Page onTriggerClick={clicked} />)
    const anna = trigger('Anna')

    await user.pointer([{ keys: '[TouchA]', target: anna }])

    expect(clicked).toHaveBeenCalledTimes(1)
    expect(clicked).toHaveBeenCalledWith(anna)
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    expect(trigger('Anna')).toBe(anna)
  })

  test('a tap engages on pointerdown, so the click that follows lands on the same node', () => {
    const clicked = vi.fn()
    render(<Page onTriggerClick={clicked} />)
    const anna = trigger('Anna')

    // The window the Herleitung bug lived in: state changes between the
    // finger landing and the click. Driven by hand so nothing else happens.
    fireEvent.pointerDown(anna, { pointerType: 'touch' })
    expect(popoverMounts.current).toBe(1)
    expect(trigger('Anna')).toBe(anna)
    fireEvent.click(anna)

    expect(clicked).toHaveBeenCalledWith(anna)
    expect(screen.getByText('Anna body')).toBeInTheDocument()
  })

  test('a click pins: leaving the trigger does not close it', async () => {
    const user = userEvent.setup()
    render(<Page />)
    const anna = trigger('Anna')

    await user.click(anna)
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.unhover(anna)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.getByText('Anna body')).toBeInTheDocument()
  })

  test('clicking a trigger whose peek the hover already opened pins it', async () => {
    const user = userEvent.setup()
    render(<Page />)
    const anna = trigger('Anna')

    // The ordinary reader: rest on the chip, read, then click to keep it.
    // The pointerdown before that click used to count as a press OUTSIDE the
    // panel (the trigger is an anchor, not a Radix trigger) and closed it
    // underneath the pin.
    await user.hover(anna)
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.click(anna)
    await user.unhover(anna)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.getByText('Anna body')).toBeInTheDocument()
  })

  test('Escape closes a pinned peek', async () => {
    const user = userEvent.setup()
    render(<Page />)

    await user.click(trigger('Anna'))
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByText('Anna body')).toBeNull())
    expect(trigger('Anna')).toHaveAttribute('aria-expanded', 'false')
  })

  test('an outside click closes a pinned peek', async () => {
    const user = userEvent.setup()
    render(<Page />)

    await user.click(trigger('Anna'))
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.click(trigger('Elsewhere'))

    await waitFor(() => expect(screen.queryByText('Anna body')).toBeNull())
  })

  test('the panel is positioned against the trigger it belongs to', async () => {
    const user = userEvent.setup()
    render(<Page />)

    await user.click(trigger('Ben'))
    const body = await screen.findByText('Ben body')
    // Radix names the anchored content by its wrapper; one open panel, Ben's.
    expect(body.closest('[data-radix-popper-content-wrapper]')).not.toBeNull()
    expect(screen.queryByText('Anna body')).toBeNull()
  })

  /**
   * Put each named trigger on a line of text: jsdom lays nothing out, and
   * whether a hop is along the line or across lines decides the warm path.
   */
  const onLines = (lines: Record<string, number>) => {
    for (const [name, line] of Object.entries(lines)) {
      vi.spyOn(trigger(name), 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ x: 0, y: line * 24, width: 40, height: 20 })
      )
    }
  }

  test('moving from one open peek to the next swaps them at once, with no overlap', async () => {
    const user = userEvent.setup()
    render(<Page />)
    onLines({ Anna: 0, Ben: 0 })

    await user.hover(trigger('Anna'))
    expect(await screen.findByText('Anna body')).toBeInTheDocument()

    // The hop: Ben opens on the pointer's arrival rather than after the open
    // delay, and Anna is gone in the same commit instead of lingering through
    // her close grace underneath him.
    await user.hover(trigger('Ben'))
    expect(screen.getByText('Ben body')).toBeInTheDocument()
    expect(screen.queryByText('Anna body')).toBeNull()
    expect(trigger('Anna')).toHaveAttribute('aria-expanded', 'false')
  })

  test('crossing a marker on the next line while a peek is open does not swap at once', async () => {
    // On the way from Anna to her panel below, the pointer passes over Ben.
    // An instant swap there took the panel the reader was reaching for.
    const user = userEvent.setup()
    render(<Page />)
    onLines({ Anna: 0, Ben: 1 })

    await user.hover(trigger('Anna'))
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.hover(trigger('Ben'))
    expect(screen.queryByText('Ben body')).toBeNull()
    expect(screen.getByText('Anna body')).toBeInTheDocument()

    // Staying on Ben is a choice, and he opens on the ordinary delay.
    expect(await screen.findByText('Ben body')).toBeInTheDocument()
    expect(screen.queryByText('Anna body')).toBeNull()
  })

  test('after leaving the open panel, a marker on another line opens at once', async () => {
    const user = userEvent.setup()
    render(<Page />)
    onLines({ Anna: 0, Ben: 1 })

    await user.hover(trigger('Anna'))
    await user.hover(await screen.findByText('Anna body'))
    await user.hover(trigger('Ben'))
    expect(screen.getByText('Ben body')).toBeInTheDocument()
  })

  test("a pinned peek's close starts the warm window, even after a hovered one took the slot", async () => {
    let clock = 10_000
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    try {
      const user = userEvent.setup()
      render(<Page />)
      onLines({ Anna: 0, Ben: 1 })

      await user.click(trigger('Anna'))
      // Ben opens beside the pinned Anna and takes the page's slot, then closes.
      await user.hover(trigger('Ben'))
      expect(await screen.findByText('Ben body')).toBeInTheDocument()
      await user.hover(screen.getByRole('button', { name: 'Elsewhere' }))
      await waitFor(() => expect(screen.queryByText('Ben body')).toBeNull())

      // Long after, the reader closes the pinned Anna and moves to Ben.
      clock += 5_000
      await user.click(trigger('Anna'))
      await waitFor(() => expect(trigger('Anna')).toHaveAttribute('aria-expanded', 'false'))
      await user.hover(trigger('Ben'))
      expect(screen.getByText('Ben body')).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })

  test('a pinned peek is not closed by hovering another trigger', async () => {
    const user = userEvent.setup()
    render(<Page />)

    await user.click(trigger('Anna'))
    expect(await screen.findByText('Anna body')).toBeInTheDocument()
    await user.hover(trigger('Ben'))
    expect(await screen.findByText('Ben body')).toBeInTheDocument()
    expect(screen.getByText('Anna body')).toBeInTheDocument()
  })

  test('keeps a gutter from the viewport edge and never outgrows a phone', async () => {
    const user = userEvent.setup()
    render(<Page />)

    await user.click(trigger('Anna'))
    const panel = (await screen.findByText('Anna body')).closest('[data-slot="popover-content"]')
    expect(panel).toHaveClass('max-w-[calc(100vw-24px)]')
  })
})

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
})

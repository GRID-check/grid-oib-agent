/**
 * The kit's contract with accessibility, pinned on the atom every control in
 * the viewport is made of. If this holds, no control in the chrome can be
 * nameless or lie about its state.
 */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Home } from 'lucide-react'
import { ViewerIconButton, ViewerIconButtonBase } from './viewer-icon-button'

describe('ViewerIconButton', () => {
  it('gives an icon-only control a name a screen reader can read', () => {
    render(<ViewerIconButton label="Ganzes Modell zeigen" icon={Home} />)
    expect(screen.getByRole('button')).toHaveAccessibleName('Ganzes Modell zeigen')
  })

  it('reports pressed state when it is a toggle', () => {
    const { rerender } = render(<ViewerIconButton label="Durchsichtig" icon={Home} active={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    rerender(<ViewerIconButton label="Durchsichtig" icon={Home} active />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  })

  it('claims no state when it is an action', () => {
    // Home is not a mode. A button that reports `aria-pressed="false"` forever
    // tells a screen-reader user there is a setting here they can turn on.
    render(<ViewerIconButton label="Ganzes Modell zeigen" icon={Home} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed')
  })

  it('runs its action on click and not while disabled', async () => {
    const onClick = vi.fn()
    const { rerender } = render(<ViewerIconButton label="Schnitt" icon={Home} onClick={onClick} />)
    await userEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)

    rerender(<ViewerIconButton label="Schnitt" icon={Home} onClick={onClick} disabled />)
    await userEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('carries the same label as a long-press title for touch', () => {
    render(<ViewerIconButton label="Ebenen" icon={Home} />)
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Ebenen')
  })
})

describe('ViewerIconButtonBase', () => {
  it('forwards the props a Radix trigger needs to drive it', async () => {
    // The reason this variant exists. `asChild` clones ONE dom-forwarding
    // child, and `ViewerIconButton` returns a Tooltip root — so a control that
    // also opens a popover has to reach the button itself. Wrapped in a
    // `<span>` instead, the popover's props land on the span, the focused
    // button keeps none of them, and the menu cannot be opened from a keyboard.
    const onClick = vi.fn()
    render(
      <ViewerIconButtonBase
        label="Ansicht"
        icon={Home}
        onClick={onClick}
        aria-expanded={false}
        aria-haspopup="dialog"
        data-state="closed"
      />
    )
    const button = screen.getByRole('button', { name: 'Ansicht' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('data-state', 'closed')

    // Keyboard, not just pointer: this is the half that was broken.
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

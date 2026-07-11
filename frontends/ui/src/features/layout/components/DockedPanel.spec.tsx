import { useState } from 'react'
import { render, screen, fireEvent } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, vi } from 'vitest'
import { DockedPanel } from './DockedPanel'

/**
 * Controlled harness: a toggle button opens the panel, mirroring how the
 * chat toolbar drives the real docked panels. Focus starts on the toggle so we
 * can assert it is restored on Escape.
 */
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="toggle" onClick={() => setOpen(true)}>
        Open
      </button>
      <DockedPanel
        open={open}
        side="left"
        onClose={() => {
          setOpen(false)
          onClose?.()
        }}
        aria-label="Test panel"
        heading={<span>Heading</span>}
      >
        <button data-testid="inner">Inner</button>
      </DockedPanel>
    </>
  )
}

describe('DockedPanel', () => {
  test('has an accessible dialog with the provided name', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('toggle'))

    expect(screen.getByRole('dialog', { name: 'Test panel' })).toBeInTheDocument()
  })

  test('moves focus to the close button on open', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('toggle'))

    expect(screen.getByRole('button', { name: /close panel/i })).toHaveFocus()
  })

  test('closes on Escape and restores focus to the opener', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<Harness onClose={onClose} />)

    const toggle = screen.getByTestId('toggle')
    await user.click(toggle)
    expect(screen.getByRole('button', { name: /close panel/i })).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveFocus()
  })

  test('Escape is inert while the panel is closed', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    // forceMount not set → panel is unmounted; no Escape listener registered.
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})

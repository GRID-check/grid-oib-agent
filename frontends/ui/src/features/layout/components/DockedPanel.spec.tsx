import { useRef, useState } from 'react'
import { render, screen, fireEvent } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { DockedPanel } from './DockedPanel'

// Drive the mobile/desktop branch explicitly so the scrim + scroll-lock
// behavior can be asserted without touching matchMedia. Defaults to desktop.
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: vi.fn(() => false) }))
const mockUseIsMobile = vi.mocked(useIsMobile)

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false)
})

/**
 * Controlled harness: a toggle button opens the panel, mirroring how the
 * chat toolbar drives the real docked panels. Focus starts on the toggle so we
 * can assert it is restored on Escape.
 */
function Harness({
  onClose,
  forceMount = false,
  initialFocusRef,
}: {
  onClose?: () => void
  forceMount?: boolean
  initialFocusRef?: React.RefObject<HTMLElement | null>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="toggle" onClick={() => setOpen(true)}>
        Open
      </button>
      <DockedPanel
        open={open}
        side="left"
        forceMount={forceMount}
        initialFocusRef={initialFocusRef}
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

/** Harness whose panel hands initial focus to a field inside it. */
function FocusTargetHarness() {
  const fieldRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button data-testid="toggle" onClick={() => setOpen(true)}>
        Open
      </button>
      <DockedPanel
        open={open}
        side="left"
        initialFocusRef={fieldRef}
        onClose={() => setOpen(false)}
        aria-label="Test panel"
        heading={<span>Heading</span>}
      >
        <input ref={fieldRef} aria-label="Field" />
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

  test('hands initial focus to the panel-nominated control when given one', async () => {
    const user = userEvent.setup()
    render(<FocusTargetHarness />)

    await user.click(screen.getByTestId('toggle'))

    expect(screen.getByRole('textbox', { name: 'Field' })).toHaveFocus()
  })

  // A force-mounted panel stays in the DOM while closed. Without `inert` its
  // controls stay tabbable — Tab would walk into an off-screen dialog that
  // `aria-hidden` has already told assistive tech does not exist.
  test('a force-mounted closed panel is inert, and drops it on open', async () => {
    const user = userEvent.setup()
    render(<Harness forceMount />)

    const panel = screen.getByRole('dialog', { hidden: true })
    expect(panel).toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByTestId('toggle'))

    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
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

  describe('mobile drawer behavior', () => {
    afterEach(() => {
      // Guard against a leaked scroll lock bleeding into later tests.
      document.body.style.overflow = ''
    })

    test('renders no scrim on desktop', async () => {
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByTestId('toggle'))

      expect(screen.getByRole('dialog', { name: 'Test panel' })).toBeInTheDocument()
      expect(screen.queryByTestId('docked-panel-backdrop')).not.toBeInTheDocument()
    })

    test('renders a tap-dismissable scrim on mobile', async () => {
      mockUseIsMobile.mockReturnValue(true)
      const onClose = vi.fn()
      const user = userEvent.setup()
      render(<Harness onClose={onClose} />)

      await user.click(screen.getByTestId('toggle'))

      const backdrop = screen.getByTestId('docked-panel-backdrop')
      expect(backdrop).toBeInTheDocument()

      await user.click(backdrop)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    test('locks and restores body scroll around the open drawer on mobile', async () => {
      mockUseIsMobile.mockReturnValue(true)
      const user = userEvent.setup()
      render(<Harness />)

      expect(document.body.style.overflow).toBe('')

      await user.click(screen.getByTestId('toggle'))
      expect(document.body.style.overflow).toBe('hidden')

      // Close via the panel's own close button and the lock releases.
      await user.click(screen.getByRole('button', { name: /close panel/i }))
      expect(document.body.style.overflow).toBe('')
    })

    test('does not lock body scroll on desktop', async () => {
      const user = userEvent.setup()
      render(<Harness />)

      await user.click(screen.getByTestId('toggle'))
      expect(document.body.style.overflow).toBe('')
    })
  })

  test('docks a left panel after the global sidebar, not over it', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('toggle'))

    const panel = screen.getByRole('dialog', { name: 'Test panel' })
    // Mobile still uses left-0; desktop docks after the rail width.
    expect(panel.className).toContain('md:left-[var(--sidebar-current-width,0px)]')
  })
})

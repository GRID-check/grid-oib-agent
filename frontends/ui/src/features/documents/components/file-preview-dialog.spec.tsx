import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'

import { FilePreviewDialog } from './file-preview-dialog'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => new URLSearchParams(),
}))

/**
 * Focus, on the way out.
 *
 * This dialog is opened imperatively from five surfaces — the Files workspace,
 * the Archiv, the composer's file chips, the file-sources tab and the document
 * grid card — by setting state rather than through a `DialogTrigger`. Radix
 * restores focus to its trigger, so with none it dropped focus to the document
 * body: a keyboard user who pressed Escape lost the card they were on and
 * restarted from the top of the page, in all five places.
 *
 * A test is the only thing that catches this. It has no visual symptom, it
 * affects only keyboard and screen-reader users, and it regresses the moment
 * someone reorders the focus handlers.
 */
const FILE = {
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 1_048_576,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
}

/**
 * The shape every real caller has: a button that opens the dialog by setting
 * state. Deliberately a harness rather than one of the five workspaces — the
 * behaviour under test belongs to the dialog, and pinning it here means it holds
 * for the sixth caller too.
 */
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open plan.pdf
      </button>
      <button type="button">Somewhere else</button>
      <FilePreviewDialog file={open ? FILE : null} onClose={() => setOpen(false)} />
    </>
  )
}

describe('FilePreviewDialog focus handling', () => {
  it('returns focus to the control that opened it when Escape closes it', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const opener = screen.getByRole('button', { name: 'Open plan.pdf' })
    await user.click(opener)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // Not the body. Before this, `document.body` held focus here.
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('does not arm a control inside the dialog on open', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Open plan.pdf' }))
    const dialog = await screen.findByRole('dialog')

    // Radix focuses the first focusable child by default, which here is
    // Download — so opening a file to LOOK at it left a download button one
    // Enter away. The panel takes focus instead.
    await waitFor(() => expect(dialog).toHaveFocus())
  })

  it('falls back to Radix when the opener is gone', async () => {
    // The opener can be unmounted by what the dialog did — deleting the document
    // is one of its own actions. Focusing a detached node silently does nothing
    // AND suppresses Radix's fallback, so the guard has to let the default run.
    const user = userEvent.setup()

    function Vanishing() {
      const [open, setOpen] = useState(false)
      const [openerGone, setOpenerGone] = useState(false)
      return (
        <>
          {!openerGone && (
            <button type="button" onClick={() => setOpen(true)}>
              Open plan.pdf
            </button>
          )}
          <FilePreviewDialog
            file={open ? FILE : null}
            onClose={() => {
              setOpenerGone(true)
              setOpen(false)
            }}
          />
        </>
      )
    }

    render(<Vanishing />)
    await user.click(screen.getByRole('button', { name: 'Open plan.pdf' }))
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    // The point is that it does not throw and does not leave focus on a detached
    // node; where Radix then puts it is Radix's business.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.activeElement?.isConnected).toBe(true)
  })
})

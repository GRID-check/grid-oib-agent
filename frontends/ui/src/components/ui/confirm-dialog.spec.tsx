/**
 * What a confirm does once the user has confirmed.
 *
 * The tone icon and the button order are design; this file is about the part
 * every caller silently depends on — the outcome of `onConfirm` decides whether
 * the dialog closes. A refused mutation must not look like a success (that is
 * the contract `ShareDialog` leans on: its `sharing.*` calls resolve `false` and
 * it throws to keep the dialog up), the refusal must leave the dialog usable
 * rather than stuck pending, and it must stay a caught rejection rather than an
 * unhandled one — the click handler fires this with `void`, so nothing else
 * would catch it.
 */

import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './confirm-dialog'

const CONFIRM = 'Zugriff entziehen'

/**
 * Rendered open, with the caller owning `open` as every real caller does — so
 * "the dialog closes" is observable as the dialog leaving the DOM, not merely as
 * a callback having fired.
 */
function renderDialog(onConfirm: () => void | Promise<void>) {
  const onOpenChange = vi.fn()

  const Harness = () => {
    const [open, setOpen] = useState(true)
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          setOpen(next)
        }}
        title="Zugriff entziehen?"
        description="Markus verliert den Zugriff auf diesen Thread."
        confirmLabel={CONFIRM}
        cancelLabel="Abbrechen"
        onConfirm={onConfirm}
      />
    )
  }

  render(<Harness />)
  return {
    onOpenChange,
    confirmButton: () => screen.getByRole('button', { name: CONFIRM }),
  }
}

describe('ConfirmDialog', () => {
  it('closes when the action lands', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const { onOpenChange, confirmButton } = renderDialog(onConfirm)

    await user.click(confirmButton())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('stays open when the action is refused', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockRejectedValue(new Error('sharing mutation refused'))
    const { onOpenChange, confirmButton } = renderDialog(onConfirm)

    await user.click(confirmButton())

    // Closing here is the damaging version: the user watches the confirmation
    // dismiss exactly as it does on success, while the explanation appears on a
    // surface behind it — so a refusal reads as a completed action.
    await waitFor(() => expect(onConfirm).toHaveBeenCalled())
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // And the pending flag is cleared on the way out, or the dialog the user is
    // left staring at has two disabled buttons and no way forward but Escape.
    await waitFor(() => expect(confirmButton()).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeEnabled()
  })

  it('does not let the refusal escape as an unhandled rejection', async () => {
    // `onClick` fires this with `void`, so the `catch` in `handleConfirm` is the
    // only thing between a refused mutation and an unhandled rejection — which
    // in the browser is a console error and a noise spike in error reporting for
    // an outcome the product handles deliberately.
    const unhandled: unknown[] = []
    const record = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const user = userEvent.setup()
      const { confirmButton } = renderDialog(
        vi.fn().mockRejectedValue(new Error('sharing mutation refused'))
      )

      await user.click(confirmButton())
      // Rejections are reported at the end of a turn, not inside it.
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('refuses to close while the action is in flight', async () => {
    const user = userEvent.setup()
    let settle: () => void = () => {}
    const { onOpenChange, confirmButton } = renderDialog(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )

    await user.click(confirmButton())
    await waitFor(() => expect(confirmButton()).toBeDisabled())

    // Escaping out mid-flight would hide a mutation that is still going to land
    // (or still going to fail) behind a dialog the user believes they cancelled.
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      settle()
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

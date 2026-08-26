import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TypeToConfirmDialog } from './type-to-confirm-dialog'

function renderDialog(onConfirm = vi.fn()) {
  render(
    <TypeToConfirmDialog
      open
      onOpenChange={() => {}}
      title="Delete project"
      description="This permanently deletes everything."
      confirmName="Alpha Plant"
      confirmLabel="Delete project"
      onConfirm={onConfirm}
    />,
  )
  return onConfirm
}

describe('TypeToConfirmDialog', () => {
  it('disables the destructive button until the exact name is typed', async () => {
    const user = userEvent.setup()
    renderDialog()
    const button = screen.getByRole('button', { name: 'Delete project' })
    expect(button).toBeDisabled()

    await user.type(screen.getByRole('textbox'), 'alpha plant')
    expect(button).toBeDisabled()
  })

  it('enables and fires onConfirm on an exact match', async () => {
    const user = userEvent.setup()
    const onConfirm = renderDialog()

    await user.type(screen.getByRole('textbox'), 'Alpha Plant')
    const button = screen.getByRole('button', { name: 'Delete project' })
    expect(button).toBeEnabled()

    await user.click(button)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  /**
   * The field advertises `enterKeyHint="done"`, which is a promise to the phone
   * keyboard that its action key finishes the job. It shipped here without a
   * handler — the `Input` is in no `<form>`, so Enter dismissed the IME and did
   * nothing else, telling the reader the action was complete when it had not
   * started. These two hold the promise and its guard together.
   */
  it('confirms on Enter once the name matches, so the "done" key means it', async () => {
    const user = userEvent.setup()
    const onConfirm = renderDialog()

    await user.type(screen.getByRole('textbox'), 'Alpha Plant')
    await user.keyboard('{Enter}')
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('ignores Enter while the name does not match', async () => {
    const user = userEvent.setup()
    const onConfirm = renderDialog()

    await user.type(screen.getByRole('textbox'), 'Alpha')
    await user.keyboard('{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables everything while pending', async () => {
    const user = userEvent.setup()
    render(
      <TypeToConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete project"
        description="desc"
        confirmName="Alpha Plant"
        confirmLabel="Delete project"
        onConfirm={vi.fn()}
        pending
      />,
    )
    await user.type(screen.getByRole('textbox'), 'Alpha Plant')
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeDisabled()
  })
})

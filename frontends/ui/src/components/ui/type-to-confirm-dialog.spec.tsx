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

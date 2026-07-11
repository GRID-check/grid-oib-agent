import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FolderTreePane } from './folder-tree-pane'

/** Renders the pane with an in-test-controllable create resolver. */
function setup() {
  let resolveCreate!: (ok: boolean) => void
  const onCreateFolder = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveCreate = resolve
      })
  )
  render(
    <FolderTreePane
      folders={[]}
      selectedFolderId={null}
      onSelectFolder={vi.fn()}
      onCreateFolder={onCreateFolder}
      isLoading={false}
    />
  )
  return { onCreateFolder, resolveCreate: () => resolveCreate }
}

describe('FolderTreePane — create folder feedback', () => {
  it('keeps the input visible and disabled with a spinner while the create is in flight', async () => {
    const user = userEvent.setup()
    const { onCreateFolder } = setup()

    await user.click(screen.getByRole('button', { name: /new folder/i }))
    const input = screen.getByRole('textbox', { name: /new folder name/i })
    await user.type(input, 'Plans')
    await user.keyboard('{Enter}')

    expect(onCreateFolder).toHaveBeenCalledWith('Plans', undefined)
    // In-flight: input stays mounted, disabled, and a spinner is shown.
    expect(input).toBeDisabled()
    expect(input).toHaveValue('Plans')
    expect(screen.getByRole('status', { name: /creating folder/i })).toBeInTheDocument()
  })

  it('repopulates the input with the entered name when the create fails', async () => {
    const user = userEvent.setup()
    const { resolveCreate } = setup()

    await user.click(screen.getByRole('button', { name: /new folder/i }))
    const input = screen.getByRole('textbox', { name: /new folder name/i })
    await user.type(input, 'Plans')
    await user.keyboard('{Enter}')

    // Reject the create (server said no).
    resolveCreate()(false)

    // The row stays open with the typed name intact and re-enabled for retry.
    await waitFor(() => expect(input).not.toBeDisabled())
    expect(input).toHaveValue('Plans')
    expect(screen.queryByRole('status', { name: /creating folder/i })).not.toBeInTheDocument()
  })

  it('clears and closes the input row on a successful create', async () => {
    const user = userEvent.setup()
    const { resolveCreate } = setup()

    await user.click(screen.getByRole('button', { name: /new folder/i }))
    const input = screen.getByRole('textbox', { name: /new folder name/i })
    await user.type(input, 'Plans')
    await user.keyboard('{Enter}')

    resolveCreate()(true)

    // Input row closes; the "New folder" trigger returns.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /new folder name/i })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('button', { name: /new folder/i })).toBeInTheDocument()
  })
})

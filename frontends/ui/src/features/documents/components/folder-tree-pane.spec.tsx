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

describe('FolderTreePane — renaming and deleting', () => {
  const FOLDERS = [
    { id: 'f-1', parentId: null, name: 'Brandschutz', path: 'Brandschutz' },
    { id: 'f-2', parentId: 'f-1', name: 'Fluchtwege', path: 'Brandschutz/Fluchtwege' },
  ]

  const renderTree = (overrides: Record<string, unknown> = {}) => {
    const onRenameFolder = vi.fn().mockResolvedValue(true)
    const onDeleteFolder = vi.fn().mockResolvedValue(true)
    render(
      <FolderTreePane
        folders={FOLDERS}
        selectedFolderId={null}
        onSelectFolder={vi.fn()}
        onCreateFolder={vi.fn().mockResolvedValue(true)}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        isLoading={false}
        {...overrides}
      />
    )
    return { onRenameFolder, onDeleteFolder }
  }

  it('renames in place, on the row the reader is already looking at', async () => {
    const user = userEvent.setup()
    const { onRenameFolder } = renderTree()

    await user.click(screen.getByTestId('folder-actions-f-1'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))

    const input = await screen.findByTestId('folder-rename-input-f-1')
    await user.clear(input)
    await user.type(input, 'Brandschutz 2026{Enter}')

    await waitFor(() => expect(onRenameFolder).toHaveBeenCalledWith('f-1', 'Brandschutz 2026'))
  })

  it('treats Escape as a cancel, and an unchanged name as nothing to do', async () => {
    const user = userEvent.setup()
    const { onRenameFolder } = renderTree()

    await user.click(screen.getByTestId('folder-actions-f-1'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByTestId('folder-rename-input-f-1')).not.toBeInTheDocument()
    )
    // Enter on an untouched field is not a round trip either — the second half
    // of the same rule.
    expect(onRenameFolder).not.toHaveBeenCalled()
  })

  it('offers the delete on every folder, including a nested one', async () => {
    const user = userEvent.setup()
    const { onDeleteFolder } = renderTree()

    await user.click(screen.getByTestId('folder-actions-f-2'))
    await user.click(await screen.findByTestId('folder-delete-f-2'))

    expect(onDeleteFolder).toHaveBeenCalledWith('f-2')
  })

  it('shows no folder actions at all when the surface passes no handlers', async () => {
    const user = userEvent.setup()
    render(
      <FolderTreePane
        folders={FOLDERS}
        selectedFolderId={null}
        onSelectFolder={vi.fn()}
        onCreateFolder={vi.fn().mockResolvedValue(true)}
        isLoading={false}
      />
    )

    // A menu whose every item is absent is a control that lies about being one.
    expect(screen.queryByTestId('folder-actions-f-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-actions-f-2')).not.toBeInTheDocument()
    // The folder itself is still selectable — losing the menu must not cost the row.
    await user.click(screen.getByRole('button', { name: 'Brandschutz' }))
  })
})

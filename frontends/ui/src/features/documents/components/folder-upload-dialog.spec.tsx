import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FolderUploadDialog } from './folder-upload-dialog'
import { buildFolderUploadPlan, type FolderUploadPlan } from '../lib/folder-upload-plan'
import type { FileItem } from './project-file-workspace'

function pathed(relativePath: string, size = 100): File {
  const name = relativePath.split('/').pop()!
  const file = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

function doc(filename: string): FileItem {
  return {
    id: `doc-${filename}`,
    filename,
    displayName: null,
    fileSize: 100,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    originPath: null,
    contentHash: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees: [],
    authoredBy: 'user',
  }
}

/** One new file, one that already exists — the shape the question is about. */
function mixedPlan(): FolderUploadPlan {
  return buildFolderUploadPlan({
    files: [pathed('W/New.pdf'), pathed('W/EG.pdf')],
    documents: [doc('EG.pdf')],
    folders: [],
    currentFolderId: null,
  })
}

function renderDialog(plan: FolderUploadPlan | null, onConfirm = vi.fn()) {
  render(
    <FolderUploadDialog
      open
      onOpenChange={vi.fn()}
      plan={plan}
      currentFolderName={null}
      onConfirm={onConfirm}
    />,
  )
  return { onConfirm }
}

describe('FolderUploadDialog', () => {
  it('says what it is doing while the plan is still being worked out', () => {
    renderDialog(null)
    // On a 500-file drop this is seconds long. A bare spinner would leave the
    // reader guessing whether anything is uploading yet.
    expect(screen.getByTestId('folder-upload-planning')).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })

  it('offers the update, ticked, and carries the answer to the caller', async () => {
    const { onConfirm } = renderDialog(mixedPlan())

    const toggle = screen.getByTestId('folder-upload-include-updates')
    // Default ON: the gesture is "bring this folder in", and defaulting to off
    // would make the common case a silent no-op that looks like a success.
    expect(within(toggle).getByRole('checkbox')).toBeChecked()
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('2')

    await userEvent.click(within(toggle).getByRole('checkbox'))
    expect(screen.getByTestId('folder-upload-confirm')).toHaveTextContent('1')

    await userEvent.click(screen.getByTestId('folder-upload-confirm'))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('relabels the rows the reader has just switched off', async () => {
    renderDialog(mixedPlan())
    await userEvent.click(screen.getByText(/Show all/i))
    const details = screen.getByTestId('folder-upload-details')
    expect(within(details).getByText('Update')).toBeInTheDocument()

    await userEvent.click(
      within(screen.getByTestId('folder-upload-include-updates')).getByRole('checkbox'),
    )

    // A list still labelled „Aktualisieren" under an unticked box describes an
    // upload that is not going to happen.
    expect(within(details).queryByText('Update')).not.toBeInTheDocument()
    expect(within(details).getByText('Skipped')).toBeInTheDocument()
  })

  it('asks nothing when nothing already exists', () => {
    renderDialog(
      buildFolderUploadPlan({
        files: [pathed('W/New.pdf')],
        documents: [],
        folders: [],
        currentFolderId: null,
      }),
    )
    // Absent, not present-and-unticked: the difference between "nothing to
    // decide" and "decided for you".
    expect(screen.queryByTestId('folder-upload-include-updates')).not.toBeInTheDocument()
  })

  it('still reports a drop that has nothing left to send', () => {
    // Every file identical to what is filed. The reader wants to read "already
    // up to date"; what they must not get is a button that would do nothing.
    const file = pathed('W/EG.pdf')
    const digest = `sha256:${'a'.repeat(64)}`
    renderDialog(
      buildFolderUploadPlan({
        files: [file],
        documents: [{ ...doc('EG.pdf'), contentHash: digest }],
        folders: [],
        currentFolderId: null,
        digests: new Map([[file, digest]]),
      }),
    )

    expect(screen.getByTestId('folder-upload-count-unchanged')).toHaveTextContent('1')
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })
})

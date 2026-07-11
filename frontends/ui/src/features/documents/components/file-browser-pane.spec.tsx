import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileBrowserPane } from './file-browser-pane'
import type { FileItem } from './project-file-workspace'

const files: FileItem[] = [
  {
    id: 'f1',
    filename: 'site-plan.pdf',
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
  },
  {
    id: 'f2',
    filename: 'permit.pdf',
    fileSize: 2048,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-02T00:00:00Z',
    errorMessage: null,
  },
]

function renderPane() {
  return render(
    <FileBrowserPane
      files={files}
      selectedFileId={null}
      onSelectFile={vi.fn()}
      isLoading={false}
      hasFolderSelected={false}
    />
  )
}

describe('FileBrowserPane — search zero-match', () => {
  it('shows an EmptyState with a Clear-search action when nothing matches', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'zzzz')

    expect(screen.getByText(/no files match/i)).toBeInTheDocument()
    expect(screen.getByText(/“zzzz”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()
    // The file rows are gone while the query has no matches.
    expect(screen.queryByText('site-plan.pdf')).not.toBeInTheDocument()
  })

  it('restores the full list when Clear search is clicked', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'zzzz')
    await user.click(screen.getByRole('button', { name: /clear search/i }))

    expect(screen.getByText('site-plan.pdf')).toBeInTheDocument()
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

// The control reads the server-computed accept-list and size limit from config;
// the same stub the other document specs use.
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

import { ProjectUppyUpload } from './project-uppy-upload'

/**
 * ONE CONTROL, TWO SOURCES.
 *
 * Folder upload first shipped as a second button beside the upload one, and it
 * cost more than it looked. The action row shares its header width with the
 * section's description, so an extra full-width button squeezed that text into
 * a four-word column — and a peer button overstated the feature, which is an
 * occasional onboarding move rather than the everyday one.
 *
 * It cannot be folded into the same INPUT — one carrying `webkitdirectory` can
 * only choose folders — so the split lives in a menu behind the single button.
 */
describe('ProjectUppyUpload', () => {
  it('is a plain button where folders are not offered', () => {
    render(<ProjectUppyUpload onUpload={vi.fn()} isUploading={false} />)

    // No second control, and no menu affordance on the one that is there.
    expect(screen.queryByTestId('project-upload-folder-item')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })

  it('offers files and folders from one button when folders are allowed', async () => {
    const user = userEvent.setup()
    render(<ProjectUppyUpload onUpload={vi.fn()} isUploading={false} allowFolders />)

    // Still exactly one control in the row — that is the point.
    expect(screen.getAllByRole('button')).toHaveLength(1)

    await user.click(screen.getByTestId('project-upload-trigger'))

    expect(await screen.findByTestId('project-upload-files-item')).toBeInTheDocument()
    expect(screen.getByTestId('project-upload-folder-item')).toBeInTheDocument()
  })

  it('points the folder item at the directory input, not the file one', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ProjectUppyUpload onUpload={vi.fn()} isUploading={false} allowFolders />
    )

    const folderInput = container.querySelector('[data-testid="project-upload-folder-input"]')
    // `webkitdirectory` is what makes it a FOLDER picker; without it the menu
    // item would silently open an ordinary file dialog.
    expect(folderInput).toHaveAttribute('webkitdirectory')

    const clicked = vi.fn()
    folderInput?.addEventListener('click', clicked)
    await user.click(screen.getByTestId('project-upload-trigger'))
    await user.click(screen.getByTestId('project-upload-folder-item'))

    expect(clicked).toHaveBeenCalled()
  })

  it('does not offer a choice while an upload is running', async () => {
    render(<ProjectUppyUpload onUpload={vi.fn()} isUploading allowFolders />)

    expect(screen.getByRole('button')).toBeDisabled()
  })
})

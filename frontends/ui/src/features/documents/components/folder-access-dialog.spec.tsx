import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationRoles } from '@/adapters/api/organization-roles-client'
import { FolderAccessDialog } from './folder-access-dialog'
import { folderActionEntries } from './folder-action-entries'
import { FolderCard, FolderRow } from './folder-navigation'
import type { FolderItem } from './project-file-workspace'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
import { toast } from 'sonner'

const ROLES: OrganizationRoles = {
  roles: [
    { slug: 'admin', name: 'Admin', description: null, custom: false },
    { slug: 'org-geschaeftsfuehrung', name: 'Geschäftsführung', description: null, custom: true },
    { slug: 'org-projektleitung', name: 'Projektleitung', description: null, custom: true },
  ],
  assignable: null,
}

const OPEN: FolderItem = { id: 'f-1', parentId: null, name: 'Verträge', path: '/Verträge', restrictedRoles: null }
const RESTRICTED: FolderItem = { ...OPEN, restrictedRoles: ['org-geschaeftsfuehrung'] }

function stubPut(result: { roles: string[] | null; moved: number; failed: string[] }, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 200
        ? Response.json({ folderId: 'f-1', ...result })
        : Response.json({ error: { message: 'no' } }, { status })
    )
  )
}

const putBody = (): unknown => JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))

function renderDialog(folder: FolderItem, onSaved = vi.fn()) {
  render(
    <FolderAccessDialog
      open
      onOpenChange={() => {}}
      projectId="p-1"
      folder={folder}
      roles={ROLES}
      onSaved={onSaved}
    />
  )
  return { dialog: screen.getByTestId('folder-access-dialog'), onSaved }
}

describe('FolderAccessDialog', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('restricts an open folder to the chosen roles and reports the documents being moved', async () => {
    stubPut({ roles: ['org-geschaeftsfuehrung', 'org-projektleitung'], moved: 4, failed: [] })
    const { dialog, onSaved } = renderDialog(OPEN)

    const save = within(dialog).getByTestId('folder-access-save')
    expect(save).toBeDisabled()
    fireEvent.click(within(dialog).getByTestId('folder-access-restricted'))
    // Restricted to nobody is not a choice the dialog offers.
    expect(within(dialog).getByTestId('folder-access-pick-one')).toBeInTheDocument()
    expect(save).toBeDisabled()

    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Geschäftsführung' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Projektleitung' }))
    expect(within(dialog).getByTestId('folder-access-move-notice')).toHaveTextContent(/read them again/)
    fireEvent.click(save)

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/projects/p-1/folders/f-1/access')
    expect(putBody()).toEqual({ roles: ['org-geschaeftsfuehrung', 'org-projektleitung'] })
    expect(toast.success).toHaveBeenCalledWith('“Verträge” is now restricted.', {
      description: '4 documents are being moved and read again.',
    })
  })

  it('opens a restricted folder to everyone with roles: null', async () => {
    stubPut({ roles: null, moved: 1, failed: ['d-9'] })
    const { dialog } = renderDialog(RESTRICTED)
    expect(within(dialog).getByRole('checkbox', { name: 'Geschäftsführung' })).toBeChecked()

    fireEvent.click(within(dialog).getByTestId('folder-access-everyone'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(putBody()).toEqual({ roles: null })
    // A document that could not move is said out loud, with what to do.
    expect(toast.warning).toHaveBeenCalledWith('1 document could not be moved yet. Save again to retry.')
  })

  it('says only project admins may change access when the route refuses', async () => {
    stubPut({ roles: null, moved: 0, failed: [] }, 404)
    const { dialog } = renderDialog(RESTRICTED)
    fireEvent.click(within(dialog).getByTestId('folder-access-everyone'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only project admins can change who may see a folder.')
    )
  })

  it('says why when the folder holds IFC models (ADR-0078)', async () => {
    stubPut({ roles: null, moved: 0, failed: [] }, 409)
    const { dialog } = renderDialog(OPEN)
    fireEvent.click(within(dialog).getByTestId('folder-access-restricted'))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Geschäftsführung' }))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('cannot be filed in a restricted folder yet'))
    )
  })
})

describe('restricted folder tiles', () => {
  const tile = {
    itemCount: 2,
    onOpen: vi.fn(),
    onRenameFolder: vi.fn(async () => true),
    onDeleteFolder: vi.fn(async () => true),
  }

  it('draw a lock and name the roles in the open button', () => {
    render(<FolderCard folder={RESTRICTED} restrictedRoleNames={['Geschäftsführung']} {...tile} />)
    expect(screen.getByTestId('folder-lock-f-1')).toHaveAttribute('data-roles', 'Geschäftsführung')
    expect(
      screen.getByRole('button', { name: 'Open folder “Verträge”, restricted to: Geschäftsführung' })
    ).toBeInTheDocument()
  })

  it('draw no lock on an open folder, in the list view either', () => {
    render(<FolderRow folder={OPEN} {...tile} />)
    expect(screen.queryByTestId('folder-lock-f-1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open folder “Verträge”' })).toBeInTheDocument()
  })
})

describe('folderActionEntries', () => {
  const base = {
    folder: OPEN,
    labels: { open: 'Open', newInside: 'New', rename: 'Rename', move: 'Move', delete: 'Delete', allFiles: 'All' },
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  }
  const ids = (entries: ReturnType<typeof folderActionEntries>): Array<string | undefined> =>
    entries.map((entry) => ('id' in entry ? entry.id : undefined))

  it('offers „Zugriff…" only to a reader who may manage the project', () => {
    expect(ids(folderActionEntries(base))).not.toContain('access')
    const onAccess = vi.fn()
    expect(ids(folderActionEntries({ ...base, labels: { ...base.labels, access: 'Access…' }, onAccess }))).toContain(
      'access'
    )
  })
})

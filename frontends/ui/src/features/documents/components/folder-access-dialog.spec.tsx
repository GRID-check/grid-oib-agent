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

const INHERITS: FolderItem = { id: 'f-1', parentId: null, name: 'Verträge', path: '/Verträge', grants: null }
const CUSTOM: FolderItem = { ...INHERITS, grants: [{ role: 'org-geschaeftsfuehrung', level: 'write' }] }

function stubPut(result: { access: unknown; moved: number; failed: string[] }, status = 200): void {
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

/** Add a role through the „Rolle hinzufügen" picker (a Radix select). */
function addRole(dialog: HTMLElement, name: string): void {
  const trigger = within(dialog).getByTestId('folder-access-add')
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(screen.getByRole('option', { name }))
}

describe('FolderAccessDialog (ADR-0081)', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('gives an inheriting folder its own list, each role with Read or Edit, and reports the documents moved', async () => {
    stubPut(
      {
        access: {
          mode: 'custom',
          grants: [
            { role: 'org-geschaeftsfuehrung', level: 'write' },
            { role: '*', level: 'read' },
          ],
        },
        moved: 4,
        failed: [],
      },
    )
    const { dialog, onSaved } = renderDialog(INHERITS)

    const save = within(dialog).getByTestId('folder-access-save')
    expect(save).toBeDisabled()
    fireEvent.click(within(dialog).getByTestId('folder-access-custom'))
    // An own list naming nobody is not a choice the dialog offers.
    expect(within(dialog).getByTestId('folder-access-pick-one')).toBeInTheDocument()
    expect(save).toBeDisabled()

    addRole(dialog, 'Geschäftsführung')
    addRole(dialog, 'All project members')
    // A new entry reads; Geschäftsführung is raised to Edit.
    const row = within(dialog).getByTestId('folder-access-grant-org-geschaeftsfuehrung')
    fireEvent.click(within(row).getByRole('radio', { name: 'Edit' }))
    expect(within(dialog).getByTestId('folder-access-move-notice')).toHaveTextContent(/reads them again/)
    fireEvent.click(save)

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/projects/p-1/folders/f-1/access')
    expect(putBody()).toEqual({
      mode: 'custom',
      grants: [
        { role: 'org-geschaeftsfuehrung', level: 'write' },
        { role: '*', level: 'read' },
      ],
    })
    expect(toast.success).toHaveBeenCalledWith('“Verträge” now has its own access.', {
      description: '4 documents are being moved and read again.',
    })
  })

  it('takes a role off the list, and makes the folder inherit again', async () => {
    stubPut({ access: { mode: 'inherit' }, moved: 1, failed: ['d-9'] })
    const { dialog } = renderDialog(CUSTOM)
    const row = within(dialog).getByTestId('folder-access-grant-org-geschaeftsfuehrung')
    expect(within(row).getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(within(row).getByRole('button', { name: 'Remove Geschäftsführung' }))
    expect(within(dialog).queryByTestId('folder-access-grant-org-geschaeftsfuehrung')).toBeNull()
    expect(within(dialog).getByTestId('folder-access-save')).toBeDisabled()

    fireEvent.click(within(dialog).getByTestId('folder-access-inherit'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(putBody()).toEqual({ mode: 'inherit' })
    // A document that could not move is said out loud, with what to do.
    expect(toast.warning).toHaveBeenCalledWith('1 document could not be moved yet. Save again to retry.')
  })

  it('says only project admins may change access when the route refuses', async () => {
    stubPut({ access: { mode: 'inherit' }, moved: 0, failed: [] }, 404)
    const { dialog } = renderDialog(CUSTOM)
    fireEvent.click(within(dialog).getByTestId('folder-access-inherit'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only project admins can change who may read and edit a folder.')
    )
  })

  it('says why when the folder holds IFC models (ADR-0080)', async () => {
    stubPut({ access: { mode: 'inherit' }, moved: 0, failed: [] }, 409)
    const { dialog } = renderDialog(INHERITS)
    fireEvent.click(within(dialog).getByTestId('folder-access-custom'))
    addRole(dialog, 'Geschäftsführung')
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('cannot be filed in a folder not everyone may read'))
    )
  })
})

describe('folder tiles under read/write access', () => {
  const tile = {
    itemCount: 2,
    onOpen: vi.fn(),
    onRenameFolder: vi.fn(async () => true),
    onDeleteFolder: vi.fn(async () => true),
  }

  it('draw a lock and name the list in the open button', () => {
    render(<FolderCard folder={CUSTOM} restrictedRoleNames={['Geschäftsführung (Edit)']} {...tile} />)
    expect(screen.getByTestId('folder-lock-f-1')).toHaveAttribute('data-roles', 'Geschäftsführung (Edit)')
    expect(
      screen.getByRole('button', { name: 'Open folder “Verträge”, access: Geschäftsführung (Edit)' })
    ).toBeInTheDocument()
  })

  it('draw no lock on a folder that inherits, in the list view either', () => {
    render(<FolderRow folder={INHERITS} {...tile} />)
    expect(screen.queryByTestId('folder-lock-f-1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open folder “Verträge”' })).toBeInTheDocument()
  })

  it('mark a folder the reader may only read „Read only“, in both views', () => {
    const { unmount } = render(<FolderCard folder={CUSTOM} readOnly {...tile} />)
    expect(screen.getByTestId('folder-read-only-f-1')).toHaveTextContent('Read only')
    unmount()
    render(<FolderRow folder={CUSTOM} readOnly {...tile} />)
    expect(screen.getByTestId('folder-read-only-f-1')).toBeInTheDocument()
  })

  it('mark nothing on a folder the reader may write', () => {
    render(<FolderCard folder={CUSTOM} {...tile} />)
    expect(screen.queryByTestId('folder-read-only-f-1')).toBeNull()
  })
})

describe('folderActionEntries', () => {
  const base = {
    folder: INHERITS,
    labels: {
      open: 'Open',
      newInside: 'New',
      rename: 'Rename',
      move: 'Move',
      delete: 'Delete',
      allFiles: 'All',
      readOnly: 'Read only',
    },
    onOpen: vi.fn(),
    onNewInside: vi.fn(),
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

  it('offers no write entry on a read-only folder, and says why', () => {
    const entries = folderActionEntries({ ...base, readOnly: true })
    expect(ids(entries)).toEqual(['open', 'read-only'])
    expect(entries.find((entry) => 'id' in entry && entry.id === 'read-only')).toMatchObject({ disabled: true })
    expect(ids(folderActionEntries(base))).toEqual(expect.arrayContaining(['new-inside', 'rename', 'delete']))
  })

  it('offers no „Zugriff…" on a read-only folder even to a project manager: the list is changed by who may write it', () => {
    const entries = folderActionEntries({
      ...base,
      labels: { ...base.labels, access: 'Access…' },
      onAccess: vi.fn(),
      readOnly: true,
    })
    expect(ids(entries)).not.toContain('access')
  })
})

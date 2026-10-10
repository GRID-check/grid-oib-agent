import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/adapters/api/api-error'
import type { FolderAccessResult, FolderAccessSetting } from '@/adapters/api/folder-access-client'
import { FolderAccessDialog } from './folder-access-dialog'
import { folderActionEntries } from './folder-action-entries'
import { FolderCard, FolderRow } from './folder-navigation'
import type { FolderItem } from './project-file-workspace'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
import { toast } from 'sonner'

const client = vi.hoisted(() => ({
  getFolderAccess: vi.fn(),
  setFolderAccess: vi.fn(),
  listProjectPeople: vi.fn(),
}))
vi.mock('@/adapters/api/folder-access-client', () => client)

const PEOPLE = [
  { userId: 'u-claudia', name: 'Claudia Hofer', email: 'c.hofer@buero.example' },
  { userId: 'u-jana', name: 'Jana Weber', email: null },
  { userId: 'u-tom', name: 'Tom Berger', email: null },
]

const INHERITS: FolderItem = { id: 'f-1', parentId: null, name: 'Verträge', path: '/Verträge', ownAccess: null }
const CUSTOM: FolderItem = { ...INHERITS, ownAccess: { everyoneReads: false } }
/** What `GET …/access` answers for CUSTOM: Claudia edits. */
const CUSTOM_LIST: FolderAccessSetting = {
  mode: 'custom',
  everyoneReads: false,
  people: [{ userId: 'u-claudia', level: 'write' }],
}

function savedAs(access: FolderAccessSetting, moved = 0, failed: string[] = []): void {
  client.setFolderAccess.mockResolvedValue({ folderId: 'f-1', access, moved, failed } satisfies FolderAccessResult)
}

const saved = (): unknown => client.setFolderAccess.mock.calls[0]?.[2]

async function renderDialog(folder: FolderItem, onSaved = vi.fn()) {
  render(<FolderAccessDialog open onOpenChange={() => {}} projectId="p-1" folder={folder} onSaved={onSaved} />)
  const dialog = screen.getByTestId('folder-access-dialog')
  return { dialog, onSaved }
}

/** Switch to an own list and wait until the people are there to pick from. */
async function ownList(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByTestId('folder-access-custom'))
  await within(dialog).findByTestId('folder-access-people')
}

/** Add a person through the „Person hinzufügen" picker (a Radix select). */
function addPerson(dialog: HTMLElement, name: RegExp): void {
  const trigger = within(dialog).getByTestId('folder-access-add')
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(screen.getByRole('option', { name }))
}

describe('FolderAccessDialog (ADR-0088, ADR-0097)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.listProjectPeople.mockResolvedValue(PEOPLE)
    client.getFolderAccess.mockResolvedValue(CUSTOM_LIST)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('gives an inheriting folder its own list of people, each with Read or Edit, and reports the documents moved', async () => {
    savedAs({ mode: 'custom', everyoneReads: false, people: [{ userId: 'u-claudia', level: 'write' }] }, 4)
    const { dialog, onSaved } = await renderDialog(INHERITS)
    // Nothing to read about a folder that inherits: only the people to pick from.
    expect(client.getFolderAccess).not.toHaveBeenCalled()
    expect(client.listProjectPeople).toHaveBeenCalledWith('p-1')

    const save = within(dialog).getByTestId('folder-access-save')
    expect(save).toBeDisabled()
    await ownList(dialog)
    // An own list naming nobody, that everyone does not read, is not a choice.
    expect(within(dialog).getByTestId('folder-access-pick-one')).toBeInTheDocument()
    expect(save).toBeDisabled()

    addPerson(dialog, /Claudia Hofer/)
    // A new entry reads; Claudia is raised to Edit.
    const row = within(dialog).getByTestId('folder-access-person-u-claudia')
    expect(within(row).getByRole('radio', { name: 'Read' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(row).getByRole('radio', { name: 'Edit' }))
    expect(within(dialog).getByTestId('folder-access-move-notice')).toHaveTextContent(/reads them again/)
    expect(within(dialog).getByTestId('folder-access-ifc-notice')).toBeInTheDocument()
    fireEvent.click(save)

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(client.setFolderAccess).toHaveBeenCalledWith('p-1', 'f-1', {
      mode: 'custom',
      everyoneReads: false,
      people: [{ userId: 'u-claudia', level: 'write' }],
    })
    expect(toast.success).toHaveBeenCalledWith('“Verträge” now has its own access.', {
      description: '4 documents are being moved and read again.',
    })
  })

  it('offers only project people not yet on the list', async () => {
    const { dialog } = await renderDialog(CUSTOM)
    await within(dialog).findByTestId('folder-access-person-u-claudia')
    const trigger = within(dialog).getByTestId('folder-access-add')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['Jana Weber', 'Tom Berger'])
  })

  it('lets every project member read with nobody on the list, and the list then decides only who edits', async () => {
    savedAs({ mode: 'custom', everyoneReads: true, people: [] })
    const { dialog } = await renderDialog(INHERITS)
    await ownList(dialog)

    fireEvent.click(within(dialog).getByTestId('folder-access-everyone-reads'))
    expect(within(dialog).queryByTestId('folder-access-pick-one')).toBeNull()
    // Everyone still reads: no IFC restriction.
    expect(within(dialog).queryByTestId('folder-access-ifc-notice')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))

    await waitFor(() => expect(client.setFolderAccess).toHaveBeenCalled())
    expect(saved()).toEqual({ mode: 'custom', everyoneReads: true, people: [] })
  })

  it('loads the list of a folder with its own, and saves nothing until something changes', async () => {
    const { dialog } = await renderDialog(CUSTOM)
    expect(within(dialog).getByTestId('folder-access-loading')).toBeInTheDocument()

    const row = await within(dialog).findByTestId('folder-access-person-u-claudia')
    expect(client.getFolderAccess).toHaveBeenCalledWith('p-1', 'f-1')
    expect(row).toHaveTextContent('Claudia Hofer')
    expect(within(row).getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true')
    const save = within(dialog).getByTestId('folder-access-save')
    expect(save).toBeDisabled()
    expect(within(dialog).queryByTestId('folder-access-move-notice')).toBeNull()

    // Edit → Read changes who may write, not who may read: savable, nothing moves.
    fireEvent.click(within(row).getByRole('radio', { name: 'Read' }))
    expect(save).toBeEnabled()
    expect(within(dialog).queryByTestId('folder-access-move-notice')).toBeNull()
    // Back as it was: nothing to save again.
    fireEvent.click(within(row).getByRole('radio', { name: 'Edit' }))
    expect(save).toBeDisabled()

    // Someone else on the list changes who may read.
    addPerson(dialog, /Tom Berger/)
    expect(save).toBeEnabled()
    expect(within(dialog).getByTestId('folder-access-move-notice')).toBeInTheDocument()
  })

  it('takes a person off the list, and makes the folder inherit again', async () => {
    savedAs({ mode: 'inherit' }, 1, ['d-9'])
    const { dialog } = await renderDialog(CUSTOM)
    const row = await within(dialog).findByTestId('folder-access-person-u-claudia')

    fireEvent.click(within(row).getByRole('button', { name: 'Remove Claudia Hofer' }))
    expect(within(dialog).queryByTestId('folder-access-person-u-claudia')).toBeNull()
    expect(within(dialog).getByTestId('folder-access-save')).toBeDisabled()

    fireEvent.click(within(dialog).getByTestId('folder-access-inherit'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(saved()).toEqual({ mode: 'inherit' })
    // A document that could not move is said out loud, with what to do.
    expect(toast.warning).toHaveBeenCalledWith('1 document could not be moved yet. Save again to retry.')
  })

  it('names someone on the list who is not in the project, so they can be taken off', async () => {
    client.getFolderAccess.mockResolvedValue({ ...CUSTOM_LIST, people: [{ userId: 'u-gone', level: 'read' }] })
    const { dialog } = await renderDialog(CUSTOM)
    const row = await within(dialog).findByTestId('folder-access-person-u-gone')
    expect(row).toHaveTextContent('Person without project access')
  })

  it('says when the list could not be read, and reads it again on retry', async () => {
    client.getFolderAccess.mockRejectedValueOnce(new ApiRequestError('down', 500))
    const { dialog } = await renderDialog(CUSTOM)

    const alert = await within(dialog).findByTestId('folder-access-load-error')
    expect(alert).toHaveTextContent('The access list could not be loaded.')
    expect(within(dialog).getByTestId('folder-access-save')).toBeDisabled()

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await within(dialog).findByTestId('folder-access-person-u-claudia')).toBeInTheDocument()
    expect(client.getFolderAccess).toHaveBeenCalledTimes(2)
  })

  it('says only project admins may change access when the route refuses', async () => {
    client.setFolderAccess.mockRejectedValue(new ApiRequestError('no', 404))
    const { dialog } = await renderDialog(CUSTOM)
    fireEvent.click(within(dialog).getByTestId('folder-access-inherit'))
    fireEvent.click(within(dialog).getByTestId('folder-access-save'))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Only project admins can change who may read and edit a folder.')
    )
  })

  it('says why when the folder holds IFC models (ADR-0087)', async () => {
    client.setFolderAccess.mockRejectedValue(new ApiRequestError('ifc', 409))
    const { dialog } = await renderDialog(INHERITS)
    await ownList(dialog)
    addPerson(dialog, /Claudia Hofer/)
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

  it('draw a lock and say in the open button that the folder has its own list', () => {
    render(<FolderCard folder={CUSTOM} {...tile} />)
    expect(screen.getByTestId('folder-lock-f-1')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open folder “Verträge”. Own access: only the listed people' })
    ).toBeInTheDocument()
  })

  it('say when every project member reads a folder with its own list, in the list view too', () => {
    render(<FolderRow folder={{ ...CUSTOM, ownAccess: { everyoneReads: true } }} {...tile} />)
    expect(screen.getByTestId('folder-lock-f-1')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open folder “Verträge”. Own access: all project members read, only the listed people edit',
      })
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

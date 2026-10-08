import { fireEvent, render, screen, waitFor, within } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssignablePermission, OrganizationRole } from '@/adapters/api/organization-roles-client'
import { CustomRolesSection } from './custom-roles-section'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
import { toast } from 'sonner'

const ADMIN: OrganizationRole = {
  slug: 'admin',
  name: 'Admin',
  description: 'Everything in the organization',
  custom: false,
  permissions: ['org:settings:manage', 'org:members:manage'],
}
const GF: OrganizationRole = {
  slug: 'org-geschaeftsfuehrung',
  name: 'Geschäftsführung',
  description: 'Sees fee agreements',
  custom: true,
  permissions: ['org:archiv:manage', 'org:models:manage'],
}
/** A User Admin: may manage roles, holds Archiv and members, not models. */
const ASSIGNABLE: AssignablePermission[] = [
  { slug: 'org:models:manage', grantable: false },
  { slug: 'org:archiv:manage', grantable: true },
  { slug: 'org:members:manage', grantable: true },
]

interface Stub {
  roles: OrganizationRole[]
  assignable: AssignablePermission[] | null
  status?: { POST?: number; PATCH?: number; DELETE?: number }
  /** What `GET …/usage` answers: the folders that name the role (ADR-0087). */
  usage?: {
    total: number
    folders: Array<{ folderId: string; folderName: string; projectId: string; projectName: string; deleted: 'folder' | 'project' | null }>
  }
  /** The reason the DELETE refusal carries. */
  reason?: string
}

function stubApi(stub: Stub): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const status = stub.status?.[method as 'POST' | 'PATCH' | 'DELETE']
      if (status) {
        return Response.json({ error: { message: 'no' }, details: stub.reason ? { reason: stub.reason } : undefined }, { status })
      }
      if (url.endsWith('/usage')) return Response.json(stub.usage ?? { total: 0, folders: [] })
      if (method === 'POST' || method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Partial<OrganizationRole>
        return Response.json({
          role: { slug: 'org-projektleitung', name: 'x', description: null, custom: true, permissions: [], ...body },
        })
      }
      if (method === 'DELETE') return Response.json({ slug: 'x' })
      return Response.json({ roles: stub.roles, assignable: stub.assignable })
    })
  )
}

const calls = (method: string): Array<[string, RequestInit | undefined]> =>
  vi.mocked(fetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method) as Array<
    [string, RequestInit | undefined]
  >
const bodyOf = (method: string): unknown => JSON.parse(String(calls(method)[0]?.[1]?.body))

describe('CustomRolesSection', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('lists the office’s roles with labelled permissions, and Piloti’s read-only', async () => {
    stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
    render(<CustomRolesSection />)

    const own = await screen.findByTestId('custom-roles-own')
    const gf = within(own).getByTestId('role-row-org-geschaeftsfuehrung')
    expect(gf).toHaveTextContent('Geschäftsführung')
    expect(gf).toHaveTextContent('Manage Office filing')
    expect(gf).toHaveTextContent('Manage AI models')

    const platform = screen.getByTestId('custom-roles-environment')
    expect(within(platform).getByTestId('role-row-admin')).toHaveTextContent('2 permissions')
    expect(within(platform).queryByRole('button')).toBeNull()
    // The copy says where roles are assigned and what they are for here.
    expect(screen.getByTestId('custom-roles')).toHaveTextContent(/People tab/)
    expect(screen.getByTestId('custom-roles')).toHaveTextContent(/folder can be restricted/)
  })

  it('shows no editing controls to a reader who may not manage roles', async () => {
    stubApi({ roles: [ADMIN, { ...GF, permissions: undefined }], assignable: null })
    render(<CustomRolesSection />)
    expect(await screen.findByTestId('custom-roles-readonly')).toBeInTheDocument()
    expect(screen.queryByTestId('custom-role-create')).toBeNull()
    expect(screen.queryByTestId('custom-role-edit-org-geschaeftsfuehrung')).toBeNull()
  })

  it('creates a role with only permissions the editor may grant', async () => {
    stubApi({ roles: [ADMIN], assignable: ASSIGNABLE })
    render(<CustomRolesSection />)
    fireEvent.click(await screen.findByTestId('custom-role-create'))

    const dialog = await screen.findByTestId('custom-role-dialog')
    expect(within(dialog).getByRole('checkbox', { name: 'Manage AI models' })).toBeDisabled()
    expect(within(dialog).getByText(/do not hold this permission yourself/)).toBeInTheDocument()

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Projektleitung' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Manage Office filing' }))
    fireEvent.click(within(dialog).getByTestId('custom-role-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(bodyOf('POST')).toEqual({ name: 'Projektleitung', description: null, permissions: ['org:archiv:manage'] })
    // The list is read again so the new role appears with its slug.
    await waitFor(() => expect(calls('GET').length).toBe(2))
  })

  it('says so in the name field when the name is taken', async () => {
    stubApi({ roles: [ADMIN], assignable: ASSIGNABLE, status: { POST: 409 } })
    render(<CustomRolesSection />)
    fireEvent.click(await screen.findByTestId('custom-role-create'))
    const dialog = await screen.findByTestId('custom-role-dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Geschäftsführung' } })
    fireEvent.click(within(dialog).getByTestId('custom-role-save'))
    expect(await within(dialog).findByTestId('custom-role-name-error')).toHaveTextContent(/already exists/)
  })

  it('edits by sending only what changed, and lets the editor remove a permission they lack', async () => {
    stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
    render(<CustomRolesSection />)
    fireEvent.click(await screen.findByTestId('custom-role-edit-org-geschaeftsfuehrung'))

    const dialog = await screen.findByTestId('custom-role-dialog')
    const models = within(dialog).getByRole('checkbox', { name: 'Manage AI models' })
    // Already on the role: taking it away grants nothing, so it stays changeable.
    expect(models).toBeEnabled()
    fireEvent.click(models)
    fireEvent.click(within(dialog).getByTestId('custom-role-save'))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(calls('PATCH')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung')
    expect(bodyOf('PATCH')).toEqual({ permissions: ['org:archiv:manage'] })
  })

  it('asks before throwing away unsaved changes', async () => {
    stubApi({ roles: [ADMIN], assignable: ASSIGNABLE })
    render(<CustomRolesSection />)
    fireEvent.click(await screen.findByTestId('custom-role-create'))
    const dialog = await screen.findByTestId('custom-role-dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Halb' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument()
  })

  /** Open the delete dialog for Geschäftsführung and wait until the folders are known. */
  async function openDelete(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))
    expect(await screen.findByText('Delete the role “Geschäftsführung”?')).toBeInTheDocument()
    const confirm = screen.getByTestId('custom-role-delete-confirm')
    await waitFor(() => expect(confirm).toBeEnabled())
    return confirm
  }

  it('deletes after confirmation, and explains a 409 as a role still held', async () => {
    stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, status: { DELETE: 409 }, reason: 'role-assigned' })
    render(<CustomRolesSection />)
    fireEvent.click(await openDelete())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/still holds this role/)))
    expect(calls('DELETE')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung')
  })

  describe('a role that folders name (ADR-0088)', () => {
    const FOLDERS = [
      { folderId: 'f1', folderName: 'Honorare', projectId: 'p1', projectName: 'Schule Süd', deleted: null },
      { folderId: 'f2', folderName: 'Verträge', projectId: 'p2', projectName: 'Halle 3', deleted: null },
    ]

    it('names the folders in the confirmation, holds the button until they are known, and deletes only with the confirmation', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, usage: { total: 2, folders: FOLDERS } })
      render(<CustomRolesSection />)
      fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))

      const notice = await screen.findByTestId('role-usage')
      expect(notice).toHaveTextContent('2 folders name this role in its access list')
      const lines = within(notice).getAllByTestId('role-usage-folder')
      expect(lines[0]).toHaveTextContent('Honorare')
      expect(lines[0]).toHaveTextContent('Schule Süd')
      expect(lines[1]).toHaveTextContent('Verträge')
      expect(notice).toHaveTextContent('only organization admins can read these folders')

      const confirm = screen.getByTestId('custom-role-delete-confirm')
      expect(confirm).toHaveTextContent('Delete anyway')
      fireEvent.click(confirm)
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
      expect(calls('DELETE')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung?confirmFolders=1')
    })

    it('marks a folder in the bin and a folder of a deleted project, which the folder tree does not show', async () => {
      const folders = [
        { folderId: 'f1', folderName: 'Honorare', projectId: 'p1', projectName: 'Schule Süd', deleted: null },
        { folderId: 'f2', folderName: 'Altakten', projectId: 'p1', projectName: 'Schule Süd', deleted: 'folder' as const },
        { folderId: 'f3', folderName: 'Verträge', projectId: 'p2', projectName: 'Halle 3', deleted: 'project' as const },
      ]
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, usage: { total: 3, folders } })
      render(<CustomRolesSection />)
      fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))

      const notice = await screen.findByTestId('role-usage')
      const lines = within(notice).getAllByTestId('role-usage-folder')
      expect(within(lines[0]).queryByTestId('role-usage-folder-deleted')).toBeNull()
      expect(within(lines[1]).getByTestId('role-usage-folder-deleted')).toHaveTextContent('in the bin')
      expect(within(lines[2]).getByTestId('role-usage-folder-deleted')).toHaveTextContent('project deleted')
      expect(within(notice).getByTestId('role-usage-deleted-note')).toHaveTextContent('comes back with this list')
    })

    it('adds no restore note when every folder that names the role is living', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, usage: { total: 2, folders: FOLDERS } })
      render(<CustomRolesSection />)
      fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))

      const notice = await screen.findByTestId('role-usage')
      expect(within(notice).queryByTestId('role-usage-deleted-note')).toBeNull()
      expect(within(notice).queryAllByTestId('role-usage-folder-deleted')).toHaveLength(0)
    })

    it('tells a role manager who may not read the folders how many, and not which', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, usage: { total: 3, folders: [] } })
      render(<CustomRolesSection />)
      fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))

      const notice = await screen.findByTestId('role-usage')
      expect(notice).toHaveTextContent('3 folders name this role')
      expect(notice).toHaveTextContent('Only organization admins see which folders these are.')
      expect(within(notice).queryAllByTestId('role-usage-folder')).toHaveLength(0)
    })

    it('shows no folder notice, and a plain button, for a role nothing names', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
      render(<CustomRolesSection />)
      const confirm = await openDelete()

      expect(screen.queryByTestId('role-usage')).toBeNull()
      expect(confirm).toHaveTextContent('Delete role')
      fireEvent.click(confirm)
      await waitFor(() => expect(toast.success).toHaveBeenCalled())
      expect(calls('DELETE')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung')
    })

    it('does not let the deletion through when the folders could not be checked', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
      vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/usage')) return Response.json({ error: { message: 'down' } }, { status: 500 })
        return Response.json({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
      })
      render(<CustomRolesSection />)
      fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))

      expect(await screen.findByTestId('role-usage-error')).toBeInTheDocument()
      expect(screen.getByTestId('custom-role-delete-confirm')).toBeDisabled()
      expect(calls('DELETE')).toHaveLength(0)
    })

    it('asks again when folders started naming the role after the list was read', async () => {
      stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, status: { DELETE: 409 }, reason: 'role-used-by-folders' })
      render(<CustomRolesSection />)
      fireEvent.click(await openDelete())

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/Folders now use this role/)))
      const usageReads = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/usage'))
      expect(usageReads).toHaveLength(2)
    })
  })
})

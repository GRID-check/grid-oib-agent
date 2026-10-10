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
    expect(screen.getByTestId('custom-roles')).toHaveTextContent(/set on the folder, under “Access…”, person by person/)
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

  /** Open the delete dialog for Geschäftsführung. */
  async function openDelete(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByTestId('custom-role-delete-org-geschaeftsfuehrung'))
    expect(await screen.findByText('Delete the role “Geschäftsführung”?')).toBeInTheDocument()
    return screen.getByTestId('custom-role-delete-confirm')
  }

  it('deletes after a plain confirmation: no folder depends on a role (ADR-0097)', async () => {
    stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE })
    render(<CustomRolesSection />)
    const confirm = await openDelete()

    expect(confirm).toBeEnabled()
    expect(confirm).toHaveTextContent('Delete role')
    fireEvent.click(confirm)
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(calls('DELETE')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung')
    // Nothing is read about the role before it goes.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/usage'))).toHaveLength(0)
  })

  it('deletes after confirmation, and explains a 409 as a role still held', async () => {
    stubApi({ roles: [ADMIN, GF], assignable: ASSIGNABLE, status: { DELETE: 409 }, reason: 'role-assigned' })
    render(<CustomRolesSection />)
    fireEvent.click(await openDelete())

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/still holds this role/)))
    expect(calls('DELETE')[0][0]).toBe('/api/organization/roles/org-geschaeftsfuehrung')
  })
})

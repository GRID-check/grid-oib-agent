import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ProjectMembersForm } from './project-members-form'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const members = [
  {
    organizationMembershipId: 'om_1',
    userId: 'user_1',
    email: 'ada@studio.at',
    name: 'Ada Lovelace',
    profilePictureUrl: 'https://cdn.example.com/ada.png',
    role: 'project-admin',
  },
  {
    organizationMembershipId: 'om_2',
    userId: 'user_2',
    email: 'grace@studio.at',
    name: 'Grace Hopper',
    profilePictureUrl: null,
    role: null,
  },
]

const mockFetch = (ok: boolean, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  })

describe('ProjectMembersForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch(true, { members }))
  })

  test('managers get the invite form and role controls', async () => {
    render(<ProjectMembersForm projectId="p1" canManage />)

    expect(await screen.findByText('Ada Lovelace')).toBeDefined()
    expect(screen.getByText(/Add a member/i)).toBeDefined()
    // one role Select trigger per member
    expect(screen.getAllByLabelText(/Project role for/i).length).toBe(2)
  })

  test('non-managers see a dignified read-only roster, no controls', async () => {
    render(<ProjectMembersForm projectId="p1" canManage={false} />)

    expect(await screen.findByText('Grace Hopper')).toBeDefined()
    expect(screen.getByText(/Read-only access/i)).toBeDefined()
    expect(screen.queryByText(/Add a member/i)).toBeNull()
    expect(screen.queryByLabelText(/Project role for/i)).toBeNull()
    // roles are shown as static badges; members without access read "No access"
    expect(screen.getByText('Admin')).toBeDefined()
    expect(screen.getByText('No access')).toBeDefined()
  })

  test('suggests the org roster on focus, members without access first', async () => {
    const user = userEvent.setup()
    render(<ProjectMembersForm projectId="p1" canManage />)

    await user.click(await screen.findByLabelText('Member'))

    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')
    expect(options.length).toBe(2)
    expect(options[0].textContent).toContain('Grace Hopper')
    expect(options[0].textContent).toContain('No access')
    expect(options[1].textContent).toContain('Ada Lovelace')
    expect(options[1].textContent).toContain('Admin')
  })

  test('filters suggestions as you type and fills the email on pick', async () => {
    const user = userEvent.setup()
    render(<ProjectMembersForm projectId="p1" canManage />)

    const input = await screen.findByLabelText('Member')
    await user.type(input, 'grace')

    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByText('Ada Lovelace')).toBeNull()

    await user.click(within(listbox).getByRole('option'))
    expect(input).toHaveValue('grace@studio.at')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('role pickers explain what each role means', async () => {
    const user = userEvent.setup()
    render(<ProjectMembersForm projectId="p1" canManage />)

    // Invite form's role select.
    await user.click(await screen.findByLabelText('Role'))
    let listbox = await screen.findByRole('listbox')
    expect(
      within(listbox).getByText(/Can view project content, files, and conversations/i),
    ).toBeDefined()
    expect(
      within(listbox).getByText(/Can also edit documents, run workflows/i),
    ).toBeDefined()
    expect(
      within(listbox).getByText(/Can also manage project settings, members, and roles/i),
    ).toBeDefined()
    await user.keyboard('{Escape}')

    // Roster row's role select (Ada already has a role assigned).
    await user.click(screen.getByLabelText('Project role for Ada Lovelace'))
    listbox = await screen.findByRole('listbox')
    expect(
      within(listbox).getByText(/Can view project content, files, and conversations/i),
    ).toBeDefined()
    expect(
      within(listbox).getByText(/Can also edit documents, run workflows/i),
    ).toBeDefined()
    expect(
      within(listbox).getByText(/Can also manage project settings, members, and roles/i),
    ).toBeDefined()
  })

  test('supports keyboard selection with arrow keys and Enter', async () => {
    const user = userEvent.setup()
    render(<ProjectMembersForm projectId="p1" canManage />)

    const input = await screen.findByLabelText('Member')
    await user.click(input)
    await user.keyboard('{ArrowDown}{Enter}')

    expect(input).toHaveValue('ada@studio.at')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  test('surfaces a load failure with a retry button', async () => {
    vi.stubGlobal('fetch', mockFetch(false, {}))
    render(<ProjectMembersForm projectId="p1" canManage />)

    expect(await screen.findByText(/Couldn't load members/i)).toBeDefined()
    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/i })).toBeDefined())
  })

  test('changing your own row requires explicit confirmation, and is not applied until confirmed', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch(true, { members })
    vi.stubGlobal('fetch', fetchMock)

    render(<ProjectMembersForm projectId="p1" canManage currentMembershipId="om_1" />)

    await screen.findByText('Ada Lovelace')
    // "You" badge marks the self row.
    expect(screen.getByText('You')).toBeDefined()

    await user.click(screen.getByLabelText('Project role for Ada Lovelace'))
    await user.click(await screen.findByRole('option', { name: /No project access/i }))

    // The change must not be sent to the server yet — a confirm dialog gates it.
    const postCallsBeforeConfirm = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(postCallsBeforeConfirm.length).toBe(0)
    expect(await screen.findByText(/^Remove your own access\?$/)).toBeDefined()
    expect(screen.getByText(/You'll lose the ability to see or manage it/i)).toBeDefined()

    // Cancelling leaves the role untouched.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/^Remove your own access\?$/)).toBeNull()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length).toBe(0)

    // Re-open and confirm — only now is the request sent.
    await user.click(screen.getByLabelText('Project role for Ada Lovelace'))
    await user.click(await screen.findByRole('option', { name: /No project access/i }))
    await user.click(await screen.findByRole('button', { name: /Remove my access/i }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(postCalls.length).toBe(1)
    })
  })

  test("changing another member's row is unaffected by the self-row guard (no confirm dialog)", async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch(true, { members })
    vi.stubGlobal('fetch', fetchMock)

    render(<ProjectMembersForm projectId="p1" canManage currentMembershipId="om_1" />)

    await screen.findByText('Grace Hopper')
    await user.click(screen.getByLabelText('Project role for Grace Hopper'))
    await user.click(await screen.findByRole('option', { name: /Viewer/i }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(postCalls.length).toBe(1)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('"Add member" on someone who already has a different role confirms the role change instead of silently downgrading', async () => {
    const user = userEvent.setup()
    const fetchMock = mockFetch(true, { members })
    vi.stubGlobal('fetch', fetchMock)

    render(<ProjectMembersForm projectId="p1" canManage />)

    const input = await screen.findByLabelText('Member')
    await user.type(input, 'ada@studio.at')

    // Leave the role select at its default ("Viewer") — Ada is currently Admin.
    await user.click(screen.getByRole('button', { name: 'Add member' }))

    // No request yet — the downgrade must be confirmed first.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length).toBe(0)
    expect(await screen.findByText(/Change their role instead/i)).toBeDefined()
    expect(screen.getByText(/already has Admin access/i)).toBeDefined()

    await user.click(screen.getByRole('button', { name: /Change role to Viewer/i }))

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(postCalls.length).toBe(1)
      expect(JSON.parse(postCalls[0][1]?.body as string)).toEqual({
        organizationMembershipId: 'om_1',
        roleSlug: 'project-viewer',
      })
    })
  })
})

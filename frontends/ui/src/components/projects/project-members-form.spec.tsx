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
})

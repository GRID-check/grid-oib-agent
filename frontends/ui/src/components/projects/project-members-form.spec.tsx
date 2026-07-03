// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@/test-utils'
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
    role: 'project-admin',
  },
  {
    organizationMembershipId: 'om_2',
    userId: 'user_2',
    email: 'grace@studio.at',
    name: 'Grace Hopper',
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

  test('surfaces a load failure with a retry button', async () => {
    vi.stubGlobal('fetch', mockFetch(false, {}))
    render(<ProjectMembersForm projectId="p1" canManage />)

    expect(await screen.findByText(/Couldn't load members/i)).toBeDefined()
    await waitFor(() => expect(screen.getByRole('button', { name: /Try again/i })).toBeDefined())
  })
})

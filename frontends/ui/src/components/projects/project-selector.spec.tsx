// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ProjectSelector } from './project-selector'

const mockRouter = {
  push: vi.fn(),
  refresh: vi.fn(),
}

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
}))

const mockProjects = [
  { id: 'p1', name: 'Alpha', collectionName: 'coll_1' },
  { id: 'p2', name: 'Beta', collectionName: 'coll_2' },
]

const mockPreferences = {
  prefs: { active_project_id: 'p2' },
}

vi.mock('@/adapters/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/ui')>()
  return {
    ...actual,
    Select: function Select({
      value,
      onValueChange,
      items,
    }: {
      value?: string
      onValueChange?: (value: string) => void
      items: Array<{ value: string; children: React.ReactNode }>
    }) {
      return (
        <select
          value={value}
          onChange={(event) => onValueChange?.(event.target.value)}
          data-testid="project-select"
        >
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.children}
            </option>
          ))}
        </select>
      )
    },
  }
})

describe('ProjectSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function setupFetch() {
    global.fetch = vi.fn(async (url) => {
      const path = url.toString()
      if (path.endsWith('/api/projects')) {
        return {
          ok: true,
          json: async () => mockProjects,
        } as Response
      }
      if (path.endsWith('/api/user/preferences')) {
        return {
          ok: true,
          json: async () => mockPreferences,
        } as Response
      }
      return { ok: false, json: async () => ({}) } as Response
    }) as typeof fetch
  }

  test('loads projects and selects the saved active project', async () => {
    setupFetch()
    render(<ProjectSelector />)

    const select = await screen.findByTestId('project-select')
    expect(select).toHaveValue('p2')
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  test('posts preferences and reloads when a different project is selected', async () => {
    setupFetch()
    const user = userEvent.setup()
    render(<ProjectSelector />)

    const select = await screen.findByTestId('project-select')
    await user.selectOptions(select, 'p1')

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/user/preferences',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefs: { active_project_id: 'p1' } }),
        }),
      )
    })

    expect(mockRouter.push).toHaveBeenCalledWith(window.location.pathname)
    expect(mockRouter.refresh).toHaveBeenCalledOnce()
  })
})

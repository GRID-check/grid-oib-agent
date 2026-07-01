// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import { describe, test, expect } from 'vitest'
import { ProjectCard } from './project-card'
import type { Project } from '@/lib/db/schema'

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  organizationId: 'org-1',
  name: 'Alpha Project',
  collectionName: 'alpha_collection',
  createdBy: 'user-1',
  workosResourceId: 'res-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
})

describe('ProjectCard', () => {
  test('renders project name and collection name', () => {
    render(<ProjectCard project={createProject({ name: 'Alpha', collectionName: 'coll_alpha' })} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('coll_alpha')).toBeInTheDocument()
  })

  test('links to the project chat and members page', () => {
    render(<ProjectCard project={createProject({ id: 'proj-abc' })} />)

    expect(screen.getByRole('link', { name: /open chat/i })).toHaveAttribute(
      'href',
      '/chat?projectId=proj-abc',
    )
    expect(screen.getByRole('link', { name: /members/i })).toHaveAttribute(
      'href',
      '/projects/proj-abc/members',
    )
  })
})

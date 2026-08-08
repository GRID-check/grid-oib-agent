/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/projects/folder-service', () => ({
  listProjectFolders: vi.fn().mockResolvedValue([
    {
      id: 'folder-1',
      projectId: 'proj-1',
      parentId: null,
      name: 'Plans',
      path: 'Plans',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]),
  createProjectFolder: vi.fn().mockImplementation((input) => {
    if (input.name === 'fail') {
      return Promise.resolve({ ok: false, error: 'Folder name is reserved.' })
    }
    return Promise.resolve({
      ok: true,
      folder: {
        id: 'folder-2',
        projectId: input.projectId,
        parentId: input.parentId ?? null,
        name: input.name,
        path: input.parentId ? `Plans/${input.name}` : input.name,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
  }),
}))

import { GET, POST } from './route'

describe('GET /api/projects/[id]/folders', () => {
  it('returns folder list for authorized user', async () => {
    const request = new NextRequest('https://grid.test/api/projects/proj-1/folders')
    const response = await GET(request, { params: Promise.resolve({ id: 'proj-1' }) })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('folders')
    expect(body.folders).toHaveLength(1)
    expect(body.folders[0].name).toBe('Plans')
  })
})

describe('POST /api/projects/[id]/folders', () => {
  it('creates a root-level folder', async () => {
    const request = new NextRequest('https://grid.test/api/projects/proj-1/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'New Folder' }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'proj-1' }) })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.folder.name).toBe('New Folder')
  })

  it('rejects invalid folder names', async () => {
    const request = new NextRequest('https://grid.test/api/projects/proj-1/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'fail' }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'proj-1' }) })
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toHaveProperty('error')
  })

  it('rejects missing name', async () => {
    const request = new NextRequest('https://grid.test/api/projects/proj-1/folders', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: 'proj-1' }) })
    expect(response.status).toBe(400)
  })
})

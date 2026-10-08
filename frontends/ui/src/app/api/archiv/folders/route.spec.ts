/**
 * @vitest-environment node
 *
 * The Archiv's folder routes — the same handlers as a project's
 * (`@/lib/documents/folder-route-handlers`) with the Archiv's service behind
 * them, so what is pinned here is that the shapes match
 * (`{ folders }`, 201 `{ folder }`, `{ documentsMoved, foldersMoved }`,
 * `{ folders, folderIdByPath }`), the feature gate holds, and a refusal from the
 * service is a 400 and a missing permission a 403 (ADR-0078).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'member',
    permissions: [],
    featureFlags: null,
  }),
}))

vi.mock('@/lib/authz/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/feature-flags')>()),
  requireFeature: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/archiv/folder-service', () => ({
  listArchivFolders: vi.fn(),
  createArchivFolder: vi.fn(),
  updateArchivFolder: vi.fn(),
  deleteArchivFolder: vi.fn(),
  ensureArchivFolderPaths: vi.fn(),
}))

import { ForbiddenError } from '@/lib/api/errors'
import { requireFeature } from '@/lib/authz/feature-flags'
import {
  createArchivFolder,
  deleteArchivFolder,
  ensureArchivFolderPaths,
  listArchivFolders,
  updateArchivFolder,
} from '@/lib/archiv/folder-service'
import { GET, POST } from './route'
import { DELETE, PATCH } from './[folderId]/route'
import { POST as ENSURE } from './ensure/route'

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
const folder = {
  id: FOLDER_ID,
  projectId: null,
  parentId: null,
  name: 'Normen',
  path: 'Normen',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
}

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://grid.test${url}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
const item = { params: Promise.resolve({ folderId: FOLDER_ID }) }
const noParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireFeature).mockReturnValue(null)
})

describe('GET /api/archiv/folders', () => {
  it('answers { folders }, with a null project, like a project does', async () => {
    vi.mocked(listArchivFolders).mockResolvedValue([folder])

    const response = await GET(new NextRequest('https://grid.test/api/archiv/folders'), noParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.folders).toHaveLength(1)
    expect(body.folders[0]).toMatchObject({ id: FOLDER_ID, projectId: null, parentId: null, path: 'Normen' })
  })

  it('is refused while the Archiv feature is off, without reading anything', async () => {
    vi.mocked(requireFeature).mockReturnValue(
      Response.json({ error: 'feature-disabled', feature: 'organization-archiv' }, { status: 403 }),
    )

    const response = await GET(new NextRequest('https://grid.test/api/archiv/folders'), noParams)

    expect(response.status).toBe(403)
    expect(listArchivFolders).not.toHaveBeenCalled()
  })
})

describe('POST /api/archiv/folders', () => {
  it('creates a folder and answers 201 { folder }', async () => {
    vi.mocked(createArchivFolder).mockResolvedValue({ ok: true, folder })

    const response = await POST(json('/api/archiv/folders', 'POST', { name: 'Normen' }), noParams)

    expect(response.status).toBe(201)
    expect((await response.json()).folder.name).toBe('Normen')
    expect(createArchivFolder).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), {
      name: 'Normen',
      parentId: null,
    })
  })

  it('turns a refusal from the service into a 400', async () => {
    vi.mocked(createArchivFolder).mockResolvedValue({ ok: false, error: 'Folder name is reserved.' })

    const response = await POST(json('/api/archiv/folders', 'POST', { name: 'CON' }), noParams)

    expect(response.status).toBe(400)
  })

  it('answers 403 for a member without org:archiv:manage', async () => {
    vi.mocked(createArchivFolder).mockRejectedValue(new ForbiddenError())

    const response = await POST(json('/api/archiv/folders', 'POST', { name: 'Normen' }), noParams)

    expect(response.status).toBe(403)
  })

  it('rejects a body that is not { name, parentId? }', async () => {
    const response = await POST(json('/api/archiv/folders', 'POST', { name: '' }), noParams)

    expect(response.status).toBe(400)
    expect(createArchivFolder).not.toHaveBeenCalled()
  })
})

describe('PATCH and DELETE /api/archiv/folders/[folderId]', () => {
  it('renames and moves, an explicit null parent meaning the root', async () => {
    vi.mocked(updateArchivFolder).mockResolvedValue({ ok: true, folder })

    const response = await PATCH(
      json(`/api/archiv/folders/${FOLDER_ID}`, 'PATCH', { name: 'Neu', parentId: null }),
      item,
    )

    expect(response.status).toBe(200)
    expect((await response.json()).folder.id).toBe(FOLDER_ID)
    expect(updateArchivFolder).toHaveBeenCalledWith(expect.anything(), {
      folderId: FOLDER_ID,
      name: 'Neu',
      parentId: null,
    })
  })

  it('rejects an empty patch', async () => {
    const response = await PATCH(json(`/api/archiv/folders/${FOLDER_ID}`, 'PATCH', {}), item)

    expect(response.status).toBe(400)
  })

  it('deletes and reports where the contents went', async () => {
    vi.mocked(deleteArchivFolder).mockResolvedValue({
      ok: true,
      result: { documentsMoved: 3, foldersMoved: 1 },
    })

    const response = await DELETE(
      new NextRequest(`https://grid.test/api/archiv/folders/${FOLDER_ID}`, { method: 'DELETE' }),
      item,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ documentsMoved: 3, foldersMoved: 1 })
    expect(deleteArchivFolder).toHaveBeenCalledWith(expect.anything(), FOLDER_ID)
  })

  it('is a 400 for a folder that is not on the shelf', async () => {
    vi.mocked(deleteArchivFolder).mockResolvedValue({ ok: false, error: 'Folder not found.' })

    const response = await DELETE(
      new NextRequest(`https://grid.test/api/archiv/folders/${FOLDER_ID}`, { method: 'DELETE' }),
      item,
    )

    expect(response.status).toBe(400)
  })
})

describe('POST /api/archiv/folders/ensure', () => {
  it('answers { folders, folderIdByPath }', async () => {
    vi.mocked(ensureArchivFolderPaths).mockResolvedValue({
      ok: true,
      folders: [folder],
      folderIdByPath: { Normen: FOLDER_ID },
    })

    const response = await ENSURE(json('/api/archiv/folders/ensure', 'POST', { paths: ['Normen'] }), noParams)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.folderIdByPath).toEqual({ Normen: FOLDER_ID })
    expect(ensureArchivFolderPaths).toHaveBeenCalledWith(expect.anything(), { parentId: null, paths: ['Normen'] })
  })

  it('refuses more than 300 paths at the edge', async () => {
    const paths = Array.from({ length: 301 }, (_, index) => `d${index}`)

    const response = await ENSURE(json('/api/archiv/folders/ensure', 'POST', { paths }), noParams)

    expect(response.status).toBe(400)
    expect(ensureArchivFolderPaths).not.toHaveBeenCalled()
  })
})

/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/project-experience/service', () => ({
  extractProjectExperience: vi.fn().mockResolvedValue({ suggested: 2, drafted: 1, documentsRead: ['a.pdf'], error: null }),
}))

import { extractProjectExperience } from '@/lib/project-experience/service'
import { POST } from './route'

const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

describe('POST /api/projects/[id]/experience', () => {
  it('declares its authorization on the factory, enforced by the service', () => {
    // authz-coverage.spec.ts checks the factory is used; this checks the declared
    // posture names the service that really asks for memory write access.
    const source = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    expect(source).toMatch(/authz:\s*\{\s*enforcedBy:\s*'extractProjectExperience /)
  })

  it('hands the project id to the service and returns its result', async () => {
    const request = new Request(`https://grid.test/api/projects/${PROJECT_ID}/experience`, { method: 'POST' })

    const response = await POST(request, { params: Promise.resolve({ id: PROJECT_ID }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ suggested: 2, drafted: 1, documentsRead: ['a.pdf'], error: null })
    expect(extractProjectExperience).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), PROJECT_ID)
  })
})

/**
 * @vitest-environment node
 *
 * Which bindings reach the agent's `documents:` block (ADR-0078).
 *
 * A binding carries its document's filename into the prompt, and the prompt
 * view is cached once per project and read by every member and by scheduled
 * and deep-research runs. So a binding to a document in a restricted folder is
 * named only for a turn whose session is cleared for it, and the reader every
 * other caller gets is "nobody's clearance". The repository is mocked: the SQL
 * that receives the hidden folders is covered against Postgres in
 * `lib/authz/folder-access.integration.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DocumentRoleBinding } from './repository'

vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/projects/repository', () => ({ findProjectProfile: vi.fn(async () => null) }))
vi.mock('./repository', () => ({ listProjectDocumentRoles: vi.fn(async () => []) }))

const { loadDocumentRolesPromptSection } = await import('./prompt-loader')
const { getHiddenFolderIds, getRestrictedFolderIds } = await import('@/lib/authz/folder-access')
const { listProjectDocumentRoles } = await import('./repository')

const RESTRICTED = 'folder-honorare'
const session = { userId: 'user-1', organizationId: 'org-1' } as AuthorizedSession

function binding(overrides: Partial<DocumentRoleBinding> = {}): DocumentRoleBinding {
  return {
    id: 'binding-1',
    projectId: 'proj-1',
    documentId: 'doc-1',
    role: 'lageplan',
    scopeInstanceId: null,
    confidence: 'declared',
    source: 'user',
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    filename: 'Lageplan.pdf',
    displayName: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getRestrictedFolderIds).mockResolvedValue([RESTRICTED])
  vi.mocked(getHiddenFolderIds).mockResolvedValue([])
})

describe('loadDocumentRolesPromptSection', () => {
  it('leaves every restricted folder out when no session is cleared', async () => {
    await loadDocumentRolesPromptSection('proj-1', 'org-1')

    expect(getRestrictedFolderIds).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(getHiddenFolderIds).not.toHaveBeenCalled()
    expect(listProjectDocumentRoles).toHaveBeenCalledWith('proj-1', { hiddenFolderIds: [RESTRICTED] })
  })

  it("names what a cleared turn's session may see, and only that", async () => {
    await loadDocumentRolesPromptSection('proj-1', 'org-1', session)

    expect(getHiddenFolderIds).toHaveBeenCalledWith(session, 'proj-1')
    expect(getRestrictedFolderIds).not.toHaveBeenCalled()
    expect(listProjectDocumentRoles).toHaveBeenCalledWith('proj-1', { hiddenFolderIds: [] })
  })

  it('names no filed document at all when there is no tenant to read the folders in', async () => {
    await loadDocumentRolesPromptSection('proj-1', null)

    expect(listProjectDocumentRoles).toHaveBeenCalledWith('proj-1', { unfiledOnly: true })
  })

  it('drops the whole block when folder access cannot be decided', async () => {
    vi.mocked(getRestrictedFolderIds).mockRejectedValue(new Error('db down'))
    vi.mocked(listProjectDocumentRoles).mockResolvedValue([binding({ filename: 'Honorarnote.pdf' })])

    expect(await loadDocumentRolesPromptSection('proj-1', 'org-1')).toBe('')
    expect(listProjectDocumentRoles).not.toHaveBeenCalled()
  })
})

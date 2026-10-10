/**
 * @vitest-environment node
 *
 * Which bindings reach the agent's `documents:` block (ADR-0087).
 *
 * A binding carries its document's filename into the prompt, and the prompt
 * view is cached once per project and read by every member and by scheduled
 * and deep-research runs. Listing is not use: a binding to a document in a
 * restricted folder is named for nobody, and every caller gets the reader of
 * "nobody's clearance". The repository is mocked: the SQL
 * that receives the hidden folders is covered against Postgres in
 * `lib/authz/folder-access.integration.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentRoleBinding } from './repository'
import type { ProjectProfile } from '@/lib/project-profile/types'

vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/projects/repository', () => ({ findProjectProfile: vi.fn(async () => null) }))
vi.mock('./repository', () => ({ listProjectDocumentRoles: vi.fn(async () => []) }))

const { loadDocumentRolesPromptSection, loadMissingDocuments, recommendedSlotsFor } = await import('./prompt-loader')
const { getHiddenFolderIds, getRestrictedFolderIds } = await import('@/lib/authz/folder-access')
const { findProjectProfile } = await import('@/lib/projects/repository')
const { listProjectDocumentRoles } = await import('./repository')

const RESTRICTED = 'folder-honorare'

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
  it('leaves every restricted folder out, whoever asks', async () => {
    await loadDocumentRolesPromptSection('proj-1', 'org-1')

    expect(getRestrictedFolderIds).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(getHiddenFolderIds).not.toHaveBeenCalled()
    expect(listProjectDocumentRoles).toHaveBeenCalledWith('proj-1', {
      hiddenFolderIds: [RESTRICTED],
      documents: { kind: 'screened-only' },
    })
  })

  it('names no filed document at all when there is no tenant to read the folders in', async () => {
    await loadDocumentRolesPromptSection('proj-1', null)

    expect(listProjectDocumentRoles).toHaveBeenCalledWith('proj-1', { unfiledOnly: true, documents: { kind: 'screened-only' } })
  })

  it('drops the whole block when folder access cannot be decided', async () => {
    vi.mocked(getRestrictedFolderIds).mockRejectedValue(new Error('db down'))
    vi.mocked(listProjectDocumentRoles).mockResolvedValue([binding({ filename: 'Honorarnote.pdf' })])

    expect(await loadDocumentRolesPromptSection('proj-1', 'org-1')).toBe('')
    expect(listProjectDocumentRoles).not.toHaveBeenCalled()
  })
})

/** A stored profile with the given facts, each confirmed. */
function profileWith(facts: Record<string, string | number | boolean>): ProjectProfile {
  const meta = { confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '2026-01-01T00:00:00.000Z' }
  return {
    facts: Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, { value, ...meta }])),
    goals: {},
    unknowns: [],
    assumptions: {},
  }
}

/**
 * `bebauungsplan` is recommended for the project (B2 = ja); `bestandsplan` and
 * `foto_bestand` are recommended for building bw1 (C2 = bestand), named Hoftrakt.
 */
const RECOMMENDING_PROFILE = profileWith({
  bebauungsplan: true,
  'errichtungsstatus@bw1': 'bestand',
  'bauwerk_name@bw1': 'Hoftrakt',
})

describe('recommendedSlotsFor', () => {
  it('recommends nothing and names no building for a project with no profile', () => {
    expect(recommendedSlotsFor(null)).toEqual({ recommended: [], bauwerkNames: {} })
  })

  it('keeps a per-building recommendation at its building and names that building', () => {
    const { recommended, bauwerkNames } = recommendedSlotsFor(RECOMMENDING_PROFILE)

    expect(recommended).toContainEqual({ role: 'bebauungsplan', scopeInstanceId: null })
    expect(recommended).toContainEqual({ role: 'bestandsplan', scopeInstanceId: 'bw1' })
    expect(bauwerkNames).toEqual({ bw1: 'Hoftrakt' })
  })
})

describe('loadMissingDocuments', () => {
  beforeEach(() => {
    vi.mocked(findProjectProfile).mockResolvedValue(null)
    vi.mocked(listProjectDocumentRoles).mockResolvedValue([])
  })

  it('lists every recommended slot that no document fills, with the building it is missing for', async () => {
    vi.mocked(findProjectProfile).mockResolvedValue(RECOMMENDING_PROFILE)

    const missing = await loadMissingDocuments('proj-1', 'org-1')

    expect(missing).toEqual(
      expect.arrayContaining([
        { role: 'bebauungsplan', label: 'Bebauungsplan', bauwerkName: null },
        { role: 'bestandsplan', label: 'Bestandspläne', bauwerkName: 'Hoftrakt' },
      ])
    )
  })

  it('drops a slot once a document fills it, and keeps the other building-scoped slots', async () => {
    vi.mocked(findProjectProfile).mockResolvedValue(RECOMMENDING_PROFILE)
    vi.mocked(listProjectDocumentRoles).mockResolvedValue([
      binding({ role: 'bebauungsplan', scopeInstanceId: null, filename: 'bplan.pdf' }),
    ])

    const missing = await loadMissingDocuments('proj-1', 'org-1')

    expect(missing?.map((entry) => entry.role)).not.toContain('bebauungsplan')
    expect(missing).toEqual(
      expect.arrayContaining([{ role: 'bestandsplan', label: 'Bestandspläne', bauwerkName: 'Hoftrakt' }])
    )
  })

  it('returns null, not an empty list, when reading the profile fails', async () => {
    vi.mocked(findProjectProfile).mockRejectedValue(new Error('db down'))

    expect(await loadMissingDocuments('proj-1', 'org-1')).toBeNull()
  })

  it('returns null, not an empty list, when reading the bindings fails', async () => {
    vi.mocked(findProjectProfile).mockResolvedValue(RECOMMENDING_PROFILE)
    vi.mocked(listProjectDocumentRoles).mockRejectedValue(new Error('db down'))

    expect(await loadMissingDocuments('proj-1', 'org-1')).toBeNull()
  })
})

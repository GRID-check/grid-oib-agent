/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
  SYSTEM_ACTORS: { uploadScreening: 'system:upload_screening', memoryJudge: 'system:memory_judge' },
}))
vi.mock('@/lib/authz/folder-access', () => ({ sourceFoldersOfCollections: vi.fn() }))
vi.mock('./repository', () => ({ findProjectInOrg: vi.fn() }))

import { recordAuditEvent } from '@/lib/audit/service'
import { sourceFoldersOfCollections } from '@/lib/authz/folder-access'
import { makeMemoryItem, makeProject } from '@/test-utils/db-fixtures'
import { recordMemoryJudgeVerdict, recordRefusedMemoryJudgeVerdict } from './memory-judge-audit'
import { findProjectInOrg } from './repository'

const CONTRACTS = 'proj_x_r0123456789ab'
const PERSONNEL = 'proj_x_rba9876543210'
const STALE = 'proj_x_rffffffffffff'
const CONTRACTS_FOLDER = '11111111-aaaa-4bbb-8ccc-000000000001'
const PERSONNEL_FOLDER = '22222222-aaaa-4bbb-8ccc-000000000002'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ collectionName: 'proj_x' }))
  vi.mocked(sourceFoldersOfCollections).mockResolvedValue(
    new Map([
      [CONTRACTS, CONTRACTS_FOLDER],
      [PERSONNEL, PERSONNEL_FOLDER],
    ])
  )
})

describe('recordMemoryJudgeVerdict', () => {
  it('records which note, which folders and the verdict, as the memory judge, without the text', async () => {
    const item = makeMemoryItem({
      id: 'item-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      content: 'Honorar LP 5-8: 184.000 EUR',
      restrictedFolderIds: [PERSONNEL_FOLDER],
      provenanceType: 'distillation',
      sourceConversationId: 'conv-1',
    })

    await recordMemoryJudgeVerdict(item, {
      verdict: 'drawn',
      judgedCollections: [PERSONNEL, CONTRACTS],
      drawnCollections: [PERSONNEL],
    })

    expect(sourceFoldersOfCollections).toHaveBeenCalledWith('org-1', 'proj-1', 'proj_x', [PERSONNEL, CONTRACTS])
    expect(recordAuditEvent).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actor: { userId: 'system:memory_judge', email: null },
      action: 'project.memory.restriction_judged',
      targetType: 'project_memory_item',
      targetId: 'item-1',
      metadata: {
        projectId: 'proj-1',
        verdict: 'drawn',
        outcome: 'stored',
        judgedFolders: `${CONTRACTS_FOLDER},${PERSONNEL_FOLDER}`,
        judgedCount: 2,
        drawnFolders: PERSONNEL_FOLDER,
        drawnCount: 1,
        restrictedFolders: PERSONNEL_FOLDER,
        provenance: 'distillation',
        conversationId: 'conv-1',
      },
    })
    expect(JSON.stringify(vi.mocked(recordAuditEvent).mock.calls)).not.toContain('184.000')
  })

  it('records a "none" that left the note open, and keeps a collection that no longer resolves by its name', async () => {
    const item = makeMemoryItem({ id: 'item-2', projectId: 'proj-1', restrictedFolderIds: null })

    await recordMemoryJudgeVerdict(item, { verdict: 'none', judgedCollections: [CONTRACTS, STALE], drawnCollections: [] })

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          verdict: 'none',
          judgedFolders: `${CONTRACTS_FOLDER},${STALE}`,
          judgedCount: 2,
          drawnFolders: '',
          drawnCount: 0,
          restrictedFolders: '',
        }),
      })
    )
  })

  it('records a refused organization write against the organization, its collections by name', async () => {
    await recordRefusedMemoryJudgeVerdict(
      { organizationId: 'org-1', provenanceType: 'agent', sourceConversationId: 'conv-1' },
      { verdict: 'none', judgedCollections: [CONTRACTS], drawnCollections: [] }
    )

    // No project to resolve the collections against.
    expect(findProjectInOrg).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actor: { userId: 'system:memory_judge', email: null },
      action: 'project.memory.restriction_judged',
      targetType: 'organization',
      targetId: 'org-1',
      metadata: {
        projectId: '',
        verdict: 'none',
        outcome: 'refused',
        judgedFolders: CONTRACTS,
        judgedCount: 1,
        drawnFolders: '',
        drawnCount: 0,
        restrictedFolders: '',
        provenance: 'agent',
        conversationId: 'conv-1',
      },
    })
  })

  it('never throws into the write it audits', async () => {
    vi.mocked(findProjectInOrg).mockRejectedValue(new Error('db down'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      recordMemoryJudgeVerdict(makeMemoryItem({ projectId: 'proj-1' }), {
        verdict: 'failed',
        judgedCollections: [CONTRACTS],
        drawnCollections: [],
      })
    ).resolves.toBeUndefined()
    error.mockRestore()
  })
})

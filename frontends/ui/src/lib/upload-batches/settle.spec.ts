import { isFolderVisibleToClearance } from '@/lib/authz/folder-access'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  batchIdsOfDocuments: vi.fn(),
  completeSettledBatches: vi.fn(),
}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  resolveSubjectMembership: vi.fn(),
  userHoldsProjectPermission: vi.fn(),
}))
vi.mock('@/lib/authz/org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleToClearance: vi.fn().mockResolvedValue(true) }))

import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { UploadBatch } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import { batchIdsOfDocuments, completeSettledBatches } from './repository'
import { onDocumentsSettled, settleUploadBatches } from './settle'

const batch = (overrides: Partial<UploadBatch> = {}): UploadBatch => ({
  id: 'batch-1',
  organizationId: 'org-1',
  createdBy: 'uploader',
  scope: 'project',
  projectId: 'proj-1',
  conversationId: null,
  expectedCount: 3,
  excluded: [],
  unchangedCount: 0,
  failedCount: 0,
  sealedAt: new Date('2026-10-01T10:00:00Z'),
  completedAt: new Date('2026-10-01T10:05:00Z'),
  createdAt: new Date('2026-10-01T09:59:00Z'),
  ...overrides,
})

const person = (userId: string) => ({ userId, email: null, name: userId, profilePictureUrl: null })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findProjectInOrg).mockResolvedValue(makeProject({ name: 'Wohnbau Nord' }))
  vi.mocked(completeSettledBatches).mockResolvedValue([])
  vi.mocked(batchIdsOfDocuments).mockResolvedValue([])
})

describe('settleUploadBatches', () => {
  it('tells the uploader once per batch this call completed, naming where it went', async () => {
    vi.mocked(completeSettledBatches).mockResolvedValue([batch()])

    await settleUploadBatches('org-1', ['batch-1', 'batch-2'])

    expect(emitInboxItems).toHaveBeenCalledWith([
      expect.objectContaining({
        recipientUserId: 'uploader',
        type: 'upload.completed',
        resourceType: 'upload_batch',
        resourceId: 'batch-1',
        anchorId: 'batch-1',
        actorUserId: null,
        payload: { subject: 'Wohnbau Nord' },
      }),
    ])
  })

  it('names no place for the Büroablage or a chat: the payload is rendered in every language as it is', async () => {
    vi.mocked(completeSettledBatches).mockResolvedValue([
      batch({ id: 'batch-a', scope: 'archiv', projectId: null }),
      batch({ id: 'batch-s', scope: 'session', projectId: null, conversationId: 'conv-1' }),
    ])

    await settleUploadBatches('org-1', ['batch-a', 'batch-s'])

    const emitted = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emitted.map((item) => item.payload)).toEqual([{}, {}])
  })

  it('emits nothing when no batch completed (another reader got there first)', async () => {
    await settleUploadBatches('org-1', ['batch-1'])
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('onDocumentsSettled', () => {
  it('settles the batches the moved documents belong to', async () => {
    vi.mocked(batchIdsOfDocuments).mockResolvedValue(['batch-1'])
    await onDocumentsSettled('org-1', [{ id: 'doc-1', status: 'completed' }])
    expect(completeSettledBatches).toHaveBeenCalledWith('org-1', ['batch-1'], expect.any(Date))
  })

  it("tells a quarantined project document's reviewers: org admins and that project's admins, nobody else", async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ id: 'doc-q', projectId: 'proj-1', createdBy: 'uploader' }))
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([
        ['admin', person('admin')],
        ['lead', person('lead')],
        ['intern', person('intern')],
      ])
    )
    vi.mocked(resolveSubjectMembership).mockImplementation(async (_org, userId) => ({
      organizationMembershipId: `om-${userId}`,
      role: userId === 'admin' ? 'admin' : 'member',
    }))
    vi.mocked(orgRoleHoldsPermission).mockImplementation(async (role) => role === 'admin')
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_s, _p, userId) => userId === 'lead')

    await onDocumentsSettled('org-1', [{ id: 'doc-q', status: 'quarantined' }])

    const emitted = vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []
    expect(emitted.map((emission) => emission.recipientUserId).sort()).toEqual(['admin', 'lead'])
    expect(emitted[0]).toMatchObject({
      type: 'document.quarantined',
      resourceType: 'organization',
      resourceId: 'org-1',
      groupKey: 'document.quarantined:organization:org-1',
    })
    // The row names no file: a badge must not leak another project's file names.
    expect(JSON.stringify(emitted)).not.toContain('doc-q')
  })

  it('leaves out a project admin the quarantined document\'s folder is hidden from (ADR-0087)', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(
      makeDocument({ id: 'doc-q', projectId: 'proj-1', folderId: 'f-honorare', createdBy: 'uploader' })
    )
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([
        ['lead', person('lead')],
        ['gf', person('gf')],
      ])
    )
    vi.mocked(resolveSubjectMembership).mockImplementation(async (_org, userId) => ({
      organizationMembershipId: `om-${userId}`,
      role: userId === 'gf' ? 'org-geschaeftsfuehrung' : 'member',
    }))
    vi.mocked(orgRoleHoldsPermission).mockResolvedValue(false)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    vi.mocked(isFolderVisibleToClearance).mockImplementation(async (_o, _p, _f, clearance) =>
      clearance.roles.includes('org-geschaeftsfuehrung')
    )

    await onDocumentsSettled('org-1', [{ id: 'doc-q', status: 'quarantined' }])

    const emitted = vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []
    expect(emitted.map((emission) => emission.recipientUserId)).toEqual(['gf'])
  })

  it('never throws into the read that reconciled', async () => {
    vi.mocked(batchIdsOfDocuments).mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(onDocumentsSettled('org-1', [{ id: 'doc-1', status: 'completed' }])).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

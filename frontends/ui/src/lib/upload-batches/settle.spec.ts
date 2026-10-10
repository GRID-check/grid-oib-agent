import { isFolderVisibleToMember } from '@/lib/authz/folder-access'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  batchIdsOfDocuments: vi.fn(),
  completeSettledBatches: vi.fn(),
  reopenCompletedBatches: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleToMember: vi.fn().mockResolvedValue(true) }))
// The event itself is `quarantine-audit.spec.ts`'s subject; here, settling hands it over.
vi.mock('@/lib/upload-screening/quarantine-audit', () => ({
  auditOwedQuarantines: vi.fn().mockResolvedValue(undefined),
}))

import { auditOwedQuarantines } from '@/lib/upload-screening/quarantine-audit'
import { orgRoleHoldsPermission } from '@/lib/authz/org-role-permissions'
import { resolveSubjectMembership, userHoldsProjectPermission } from '@/lib/authz/project-membership'
import type { UploadBatch } from '@/lib/db/schema'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { makeDocument, makeProject } from '@/test-utils/db-fixtures'
import { batchIdsOfDocuments, completeSettledBatches, reopenCompletedBatches } from './repository'
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

  // A completed batch is never settled again, so an uploader not told when it
  // completed would never be: the completion is undone for the sweep to redo.
  it('reopens what it completed when the uploader cannot be told, and says so', async () => {
    vi.mocked(completeSettledBatches).mockResolvedValue([batch(), batch({ id: 'batch-2' })])
    vi.mocked(emitInboxItems).mockRejectedValueOnce(new Error('inbox upsert refused'))

    await expect(settleUploadBatches('org-1', ['batch-1', 'batch-2'])).rejects.toThrow('inbox upsert refused')

    const completedAt = vi.mocked(completeSettledBatches).mock.calls[0][2]
    expect(reopenCompletedBatches).toHaveBeenCalledWith('org-1', ['batch-1', 'batch-2'], completedAt)
  })

  it('reopens nothing when the uploader was told', async () => {
    vi.mocked(completeSettledBatches).mockResolvedValue([batch()])
    await settleUploadBatches('org-1', ['batch-1'])
    expect(reopenCompletedBatches).not.toHaveBeenCalled()
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
      role: 'member',
    }))
    vi.mocked(orgRoleHoldsPermission).mockResolvedValue(false)
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
    // Only gf holds a folder role on Honorare (ADR-0097): asked per person, by their membership as it is now.
    vi.mocked(isFolderVisibleToMember).mockImplementation(async (_o, _p, _f, userId) => userId === 'gf')

    await onDocumentsSettled('org-1', [{ id: 'doc-q', status: 'quarantined' }])

    const emitted = vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []
    expect(emitted.map((emission) => emission.recipientUserId)).toEqual(['gf'])
    expect(isFolderVisibleToMember).toHaveBeenCalledWith('org-1', 'proj-1', 'f-honorare', 'lead')
  })

  it("sends the content gate's owed decisions to the audit trail before telling the reviewers", async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(makeDocument({ id: 'doc-q', projectId: 'proj-1' }))
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())

    await onDocumentsSettled('org-1', [
      { id: 'doc-q', status: 'quarantined' },
      { id: 'doc-ok', status: 'completed' },
    ])

    expect(auditOwedQuarantines).toHaveBeenCalledTimes(1)
    expect(auditOwedQuarantines).toHaveBeenCalledWith('org-1', ['doc-q'])
  })

  it('audits nothing for a document that came to rest any other way', async () => {
    await onDocumentsSettled('org-1', [
      { id: 'doc-1', status: 'completed' },
      { id: 'doc-2', status: 'failed' },
    ])
    expect(auditOwedQuarantines).not.toHaveBeenCalled()
  })

  it('never throws into the read that reconciled', async () => {
    vi.mocked(batchIdsOfDocuments).mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(onDocumentsSettled('org-1', [{ id: 'doc-1', status: 'completed' }])).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

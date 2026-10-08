/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit/service', () => ({
  auditLogsEnabled: vi.fn(() => true),
  recordAuditEventOrThrow: vi.fn().mockResolvedValue(undefined),
  SYSTEM_ACTORS: { uploadScreening: 'system:upload_screening', memoryJudge: 'system:memory_judge' },
}))
vi.mock('./repository', () => ({
  listOwedQuarantineDecisions: vi.fn(),
  listOwedQuarantineDecisionsBetween: vi.fn(),
  markQuarantineDecisionAudited: vi.fn().mockResolvedValue(true),
}))

import { auditLogsEnabled, recordAuditEventOrThrow } from '@/lib/audit/service'
import type { DocumentQuarantineDecision } from '@/lib/db/schema'
import {
  auditOwedQuarantines,
  auditQuarantineDecision,
  QUARANTINE_AUDIT_GRACE_MS,
  QUARANTINE_AUDIT_SWEEP_LIMIT,
  sweepOwedQuarantines,
} from './quarantine-audit'
import {
  listOwedQuarantineDecisions,
  listOwedQuarantineDecisionsBetween,
  markQuarantineDecisionAudited,
} from './repository'

const DECIDED_AT = new Date('2026-10-01T08:00:00Z')

const decision = (
  overrides: Partial<DocumentQuarantineDecision> = {}
): DocumentQuarantineDecision => ({
  id: 'decision-1',
  organizationId: 'org-1',
  documentId: 'doc-q',
  jobId: 'job-7',
  decidedAt: DECIDED_AT,
  scope: 'project',
  projectId: 'proj-1',
  folderId: 'folder-personal',
  filename: 'Lohnzettel März.pdf',
  reasons: 'term:Lohnzettel,iban',
  checked: 'partial',
  uploadedBy: 'uploader',
  auditedAt: null,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(auditLogsEnabled).mockReturnValue(true)
  vi.mocked(recordAuditEventOrThrow).mockResolvedValue(undefined)
})

describe('auditQuarantineDecision', () => {
  it('sends the decision as the content gate, built from the row alone, then marks it audited', async () => {
    expect(await auditQuarantineDecision(decision())).toBe(true)

    expect(recordAuditEventOrThrow).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actor: { userId: 'system:upload_screening', email: null },
      action: 'document.quarantined',
      targetType: 'document',
      targetId: 'doc-q',
      metadata: {
        projectId: 'proj-1',
        filename: 'Lohnzettel März.pdf',
        scope: 'project',
        reasons: 'term:Lohnzettel,iban',
        checked: 'partial',
        uploadedBy: 'uploader',
        jobId: 'job-7',
      },
      // Where it was filed: the trail withholds the name under a folder not
      // every project member may read.
      filedIn: { projectId: 'proj-1', folderId: 'folder-personal' },
      // The decision's time, and a key per decision: a second send is the
      // same event, and WorkOS answers it with the first.
      occurredAt: DECIDED_AT,
      idempotencyKey: 'document.quarantined:decision-1',
    })
    expect(markQuarantineDecisionAudited).toHaveBeenCalledWith(
      'org-1',
      'decision-1',
      expect.any(Date)
    )
  })

  it('says a decision off any project shelf is filed in no folder', async () => {
    await auditQuarantineDecision(decision({ scope: 'archiv', projectId: null, folderId: null }))

    expect(vi.mocked(recordAuditEventOrThrow).mock.calls[0][0]).toMatchObject({ filedIn: null })
  })

  it('sends the same event however often one decision is sent', async () => {
    await auditQuarantineDecision(decision())
    await auditQuarantineDecision(decision())
    const [first, second] = vi.mocked(recordAuditEventOrThrow).mock.calls
    expect(second).toEqual(first)
  })

  it('leaves a decision owed when the trail refuses it, and does not throw', async () => {
    vi.mocked(recordAuditEventOrThrow).mockRejectedValue(new Error('WorkOS 503'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await auditQuarantineDecision(decision())).toBe(false)
    expect(markQuarantineDecisionAudited).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('auditOwedQuarantines', () => {
  it('sends the owed decisions of the documents that came to rest', async () => {
    vi.mocked(listOwedQuarantineDecisions).mockResolvedValue([
      decision(),
      decision({ id: 'decision-2' }),
    ])

    await auditOwedQuarantines('org-1', ['doc-q'])

    expect(listOwedQuarantineDecisions).toHaveBeenCalledWith('org-1', ['doc-q'])
    expect(recordAuditEventOrThrow).toHaveBeenCalledTimes(2)
  })

  it('sends and marks nothing where the deployment keeps no trail, so turning it on finds them', async () => {
    vi.mocked(auditLogsEnabled).mockReturnValue(false)

    await auditOwedQuarantines('org-1', ['doc-q'])

    expect(listOwedQuarantineDecisions).not.toHaveBeenCalled()
    expect(markQuarantineDecisionAudited).not.toHaveBeenCalled()
  })

  it('never throws into the read that settled', async () => {
    vi.mocked(listOwedQuarantineDecisions).mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(auditOwedQuarantines('org-1', ['doc-q'])).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('sweepOwedQuarantines', () => {
  it('sends what is still owed after the grace, across organizations, and counts what went out', async () => {
    const now = new Date('2026-10-08T12:00:00Z')
    vi.mocked(listOwedQuarantineDecisionsBetween).mockResolvedValue([
      decision(),
      decision({ id: 'decision-9', organizationId: 'org-2' }),
    ])
    vi.mocked(recordAuditEventOrThrow)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('503'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await sweepOwedQuarantines(now)).toBe(1)

    const [after, before, limit] = vi.mocked(listOwedQuarantineDecisionsBetween).mock.calls[0]
    expect(before).toEqual(new Date(now.getTime() - QUARANTINE_AUDIT_GRACE_MS))
    expect(after.getTime()).toBeLessThan(before.getTime())
    expect(limit).toBe(QUARANTINE_AUDIT_SWEEP_LIMIT)
    expect(markQuarantineDecisionAudited).toHaveBeenCalledTimes(1)
    expect(markQuarantineDecisionAudited).toHaveBeenCalledWith(
      'org-1',
      'decision-1',
      expect.any(Date)
    )
    warn.mockRestore()
  })

  it('does nothing where the deployment keeps no trail', async () => {
    vi.mocked(auditLogsEnabled).mockReturnValue(false)
    expect(await sweepOwedQuarantines()).toBe(0)
    expect(listOwedQuarantineDecisionsBetween).not.toHaveBeenCalled()
  })
})

/**
 * @vitest-environment node
 */
/**
 * A decision's line in the trail is owed (ADR-0134): sent under a fixed key at
 * the time it was decided, marked audited only when taken, and left for the
 * sweep when not. Its metadata is ids, codes and flags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEventOrThrow: vi.fn(async () => undefined) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('./repository', () => ({
  findPartKinds: vi.fn(async () => new Map([['p-1', 'attachment']])),
  markDecisionsAudited: vi.fn(async () => undefined),
}))

import { recordAuditEventOrThrow } from '@/lib/audit/service'
import type { InboundMailDecisionRow } from '@/lib/db/schema'
import { auditDecisions, decisionMetadata } from './audit'
import { markDecisionsAudited } from './repository'

const decided = new Date('2026-10-21T09:00:00Z')
const row = (id: string): InboundMailDecisionRow =>
  ({
    id,
    organizationId: 'org_1',
    projectId: 'proj',
    mailId: 'mail',
    partId: 'p-1',
    action: 'file',
    decidedBy: 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A',
    via: 'agent',
    proposalId: null,
    followId: null,
    decidedAt: decided,
    folderId: null,
    folderPath: 'Tragwerk',
    fileName: 'S-101_C.pdf',
    targetDocumentId: null,
    documentType: null,
    threadAction: null,
    mailThreadId: null,
    messageText: null,
    screeningRelease: false,
    acknowledgedSender: true,
    acknowledgedRisk: false,
    auditedAt: null,
  }) as InboundMailDecisionRow

beforeEach(() => vi.clearAllMocks())

describe('the audit of decisions', () => {
  it('carries ids, codes and flags, never a name or a path', () => {
    const metadata = decisionMetadata(row('d-1'), 'attachment')
    expect(metadata).toEqual({
      projectId: 'proj',
      decisionId: 'd-1',
      partId: 'p-1',
      action: 'file',
      via: 'agent',
      partKind: 'attachment',
      screeningRelease: false,
      acknowledgedSender: true,
      acknowledgedRisk: false,
    })
    expect(JSON.stringify(metadata)).not.toMatch(/S-101|Tragwerk/)
  })

  it('sends each under a fixed key at its decision time, and marks only what was taken', async () => {
    vi.mocked(recordAuditEventOrThrow).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('workos down'))
    expect(await auditDecisions([row('d-1'), row('d-2')])).toBe(false)
    expect(recordAuditEventOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inbound_mail.decided', idempotencyKey: 'inbound_mail.decided:d-1', occurredAt: decided }),
    )
    expect(markDecisionsAudited).toHaveBeenCalledWith(['d-1'])
  })
})

/**
 * Rows of a held mail as the review service reads them, for the specs of the
 * decision, the candidates and the service. Each builder answers a mail that
 * keeps every rule of migration 0186 for its state; a spec overrides only the
 * fact its case is about.
 */

import type { InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'

export const PROJECT_ID = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
export const MAIL_ID = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
export const TEXT_PART_ID = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
export const FILE_PART_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
export const THREAD_ID = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
export const FOLDER_ID = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
export const DOCUMENT_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
export const PERSON = 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A'

const AT = new Date('2026-10-21T08:14:00.000Z')

/** A `member_verified` mail addressed to the project, waiting, with a reference match on {@link THREAD_ID}. */
export function heldMail(overrides: Partial<InboundMailRow> = {}): InboundMailRow {
  return {
    id: MAIL_ID,
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    addressId: '0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
    status: 'waiting',
    deliveryKey: 'a'.repeat(64),
    envelopeFrom: 'p.weber@statik-weber.at',
    rawSizeBytes: 4096,
    stagingBucket: 'tenant-org-1',
    rawStorageKey: `org/org_1/project/${PROJECT_ID}/_inbound-mail/${MAIL_ID}/raw.eml`,
    readStorageKey: `org/org_1/project/${PROJECT_ID}/_inbound-mail/${MAIL_ID}/read.json`,
    rawScanStatus: 'clean',
    rawScanEngine: 'ClamAV 1.5.4/28157',
    rawScanSignature: null,
    rawScannedAt: AT,
    rawScanAttempts: 1,
    messageId: '<reply-2@statik-weber.at>',
    inReplyTo: ['<first@piloti.test>'],
    referenceIds: ['<first@piloti.test>'],
    threadIndexGuid: null,
    baseSubject: 'statik einreichung',
    threadMatch: [{ threadId: THREAD_ID, strength: 'reference', headers: ['in-reply-to', 'references'] }],
    senderAddress: 'p.weber@statik-weber.at',
    senderName: 'DI Petra Weber',
    subject: 'AW: Statik Einreichung',
    participants: [],
    participantDomains: ['statik-weber.at'],
    recipientCount: 2,
    senderTrust: 'member_verified',
    senderUserId: PERSON,
    senderReason: 'dkim_pass',
    signerDomain: 'statik-weber.at',
    signedHeaders: ['from', 'subject', 'date', 'message-id', 'to', 'in-reply-to', 'references'],
    senderFlags: [],
    authenticationResults: 'dkim=pass header.d=statik-weber.at',
    automatic: false,
    droppedReason: null,
    sentAt: AT,
    sentAtHeader: AT,
    receivedAt: AT,
    expiresAt: new Date('2026-11-20T08:14:00.000Z'),
    settledAt: null,
    notifiedAt: AT,
    expiringNotifiedAt: null,
    notStaged: [],
    ignored: {},
    erasureDeferredAt: null,
    originalMovePendingAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

/** The mail's text part, waiting. */
export function textPart(overrides: Partial<InboundMailPartRow> = {}): InboundMailPartRow {
  return {
    id: TEXT_PART_ID,
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    mailId: MAIL_ID,
    position: 0,
    kind: 'message',
    filename: null,
    contentType: 'text/plain',
    sizeBytes: 812,
    sha256: 'b'.repeat(64),
    storageKey: null,
    state: 'waiting',
    scanStatus: 'not_applicable',
    scanEngine: null,
    scanSignature: null,
    scannedAt: null,
    scanAttempts: 0,
    riskFlags: [],
    nameStopTerms: [],
    contentFindings: [],
    duplicateOfDocumentId: null,
    revisionCandidateDocumentId: null,
    decisionId: null,
    claimExpiresAt: null,
    lastFailure: null,
    documentId: null,
    documentVersionId: null,
    mailThreadEntryId: null,
    filedAt: null,
    endedAt: null,
    erasureDeferredAt: null,
    suggestion: null,
    suggestionTraceId: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

/** One clean PDF attachment, waiting. */
export function filePart(overrides: Partial<InboundMailPartRow> = {}): InboundMailPartRow {
  return textPart({
    id: FILE_PART_ID,
    position: 1,
    kind: 'attachment',
    filename: 'S-101_C.pdf',
    contentType: 'application/pdf',
    sizeBytes: 482113,
    sha256: 'c'.repeat(64),
    storageKey: `org/org_1/project/${PROJECT_ID}/_inbound-mail/${MAIL_ID}/1`,
    scanStatus: 'clean',
    scanEngine: 'ClamAV 1.5.4/28157',
    scannedAt: AT,
    ...overrides,
  })
}

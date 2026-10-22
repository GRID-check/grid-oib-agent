/**
 * @vitest-environment node
 */
/**
 * Candidates are the viewer's (D9, RT-S13): what sits in a folder they may not
 * read is counted or dropped, never named, and only a strong match from a
 * sender whose domain signed it is pre-selected (RT-S1).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({}))
vi.mock('@/lib/authz/folder-access', () => ({ getHiddenFolderIds: vi.fn() }))

import { DOCUMENT_ID, FOLDER_ID, THREAD_ID, heldMail } from './__fixtures__/review'
import { partCandidatesFor, senderEvidenceOf, threadCandidatesFor } from './candidates'
import type { CandidateDocument, ThreadDocument } from './repository'

const HIDDEN = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c'
const SECOND = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d'

const thread = (threadId: string, folderId: string | null, overrides: Partial<ThreadDocument> = {}): ThreadDocument => ({
  threadId,
  documentId: DOCUMENT_ID,
  name: 'Stellplatznachweis',
  folderId,
  folderPath: folderId ? 'Behörde' : null,
  nextVersion: 4,
  entryCount: 3,
  renderedBytes: 1000,
  ...overrides,
})

describe('thread candidates for the viewer', () => {
  it('names a thread the viewer may read, pre-selected on a signed reference from a verified member', () => {
    const mail = heldMail()
    const { shown, hidden } = threadCandidatesFor(mail.threadMatch, senderEvidenceOf(mail), new Map([[THREAD_ID, thread(THREAD_ID, FOLDER_ID)]]), new Set())
    expect(hidden).toBe(0)
    expect(shown).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, name: 'Stellplatznachweis', nextVersion: 4, preselected: true, blocks: [], full: false }),
    ])
  })

  it('counts a thread in a folder the viewer may not read, and never names it', () => {
    const mail = heldMail()
    const result = threadCandidatesFor(mail.threadMatch, senderEvidenceOf(mail), new Map([[THREAD_ID, thread(THREAD_ID, HIDDEN)]]), new Set([HIDDEN]))
    expect(result).toEqual({ shown: [], hidden: 1 })
    expect(JSON.stringify(result)).not.toContain('Stellplatznachweis')
  })

  it('drops a matched thread with no live, screened document for everyone', () => {
    const mail = heldMail()
    expect(threadCandidatesFor(mail.threadMatch, senderEvidenceOf(mail), new Map(), new Set())).toEqual({ shown: [], hidden: 0 })
  })

  it('offers a stranger’s reference unchecked, with the reason', () => {
    const mail = heldMail({ senderTrust: 'external_unverified', senderUserId: null, senderReason: 'dkim_none', signedHeaders: [] })
    const [candidate] = threadCandidatesFor(mail.threadMatch, senderEvidenceOf(mail), new Map([[THREAD_ID, thread(THREAD_ID, null)]]), new Set()).shown
    expect(candidate).toMatchObject({ preselected: false, blocks: ['sender_not_verified'] })
  })

  it('never pre-selects a full thread: it can only be continued', () => {
    const mail = heldMail()
    const [candidate] = threadCandidatesFor(
      mail.threadMatch,
      senderEvidenceOf(mail),
      new Map([[THREAD_ID, thread(THREAD_ID, null, { entryCount: 200 })]]),
      new Set(),
    ).shown
    expect(candidate).toMatchObject({ preselected: false, full: true })
  })

  it('shows at most three, and still counts the hidden ones beyond', () => {
    const ids = [THREAD_ID, SECOND, '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f', '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a']
    const matches = ids.map((threadId) => ({ threadId, strength: 'subject' as const, headers: ['subject' as const] }))
    const threads = new Map(ids.map((id, index) => [id, thread(id, index === 4 ? HIDDEN : null)]))
    const { shown, hidden } = threadCandidatesFor(matches, senderEvidenceOf(heldMail()), threads, new Set([HIDDEN]))
    expect(shown).toHaveLength(3)
    expect(hidden).toBe(1)
  })
})

describe('a part’s documents for the viewer', () => {
  const doc = (folderId: string | null): CandidateDocument => ({ documentId: DOCUMENT_ID, name: 'S-101_B.pdf', folderId, folderPath: null, nextVersion: 3 })

  it('names a duplicate and an earlier version the viewer may read', () => {
    const part = { duplicateOfDocumentId: DOCUMENT_ID, revisionCandidateDocumentId: DOCUMENT_ID }
    expect(partCandidatesFor(part, new Map([[DOCUMENT_ID, doc(null)]]), new Set())).toEqual({
      duplicateOf: { documentId: DOCUMENT_ID, name: 'S-101_B.pdf', folderPath: null },
      revisionCandidate: { documentId: DOCUMENT_ID, name: 'S-101_B.pdf', folderPath: null, nextVersion: 3 },
      revisionCandidateHidden: false,
    })
  })

  it('says only that an earlier version exists where the viewer may not look, and nothing of a duplicate there', () => {
    const part = { duplicateOfDocumentId: DOCUMENT_ID, revisionCandidateDocumentId: DOCUMENT_ID }
    expect(partCandidatesFor(part, new Map([[DOCUMENT_ID, doc(HIDDEN)]]), new Set([HIDDEN]))).toEqual({
      duplicateOf: null,
      revisionCandidate: null,
      revisionCandidateHidden: true,
    })
  })

  it('knows nothing of a document that is held, gone or binned', () => {
    const part = { duplicateOfDocumentId: DOCUMENT_ID, revisionCandidateDocumentId: DOCUMENT_ID }
    expect(partCandidatesFor(part, new Map(), new Set())).toEqual({ duplicateOf: null, revisionCandidate: null, revisionCandidateHidden: false })
  })
})

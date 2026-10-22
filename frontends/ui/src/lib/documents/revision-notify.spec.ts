/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document, DocumentVersion } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/assignments/repository', () => ({ listAssignmentsForResources: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({ listDocumentAnnotations: vi.fn(), findDocumentAnnotation: vi.fn() }))
vi.mock('@/lib/authz/folder-access', () => ({ filterUsersWhoMayReadFolder: vi.fn() }))
vi.mock('@/lib/authz/project-membership', () => ({
  PERMISSION_CHECKS_AT_ONCE: 8,
  userHoldsProjectPermission: vi.fn(),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/inbox/repository', () => ({ recipientsHoldingGroup: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(0) }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn(), findRevisionCounterparts: vi.fn() }))
vi.mock('./reconcile-status', () => ({ readRevisionLinkNames: vi.fn(), refreshCollectionFiles: vi.fn() }))
vi.mock('./version-repository', () => ({ findPublishedVersion: vi.fn(), findPreviousVersion: vi.fn() }))
vi.mock('@/lib/revision-notice/queue', () => ({ queueRevisionNotice: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/document-check/queue', () => ({ queueDocumentCheck: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/upload-batches/repository', () => ({ findBatchSettleEffects: vi.fn() }))
vi.mock('./revision-announcement-repository', () => ({
  claimRevisionAnnouncement: vi.fn(),
  releaseRevisionAnnouncement: vi.fn(),
}))

import { listDocumentAnnotations, type AnnotationRecord } from '@/lib/annotations/repository'
import { listAssignmentsForResources } from '@/lib/assignments/repository'
import { filterUsersWhoMayReadFolder } from '@/lib/authz/folder-access'
import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import type { DirectoryPerson } from '@/lib/sharing/types'
import { emitInboxItems } from '@/lib/inbox/service'
import { queueDocumentCheck } from '@/lib/document-check/queue'
import { queueRevisionNotice } from '@/lib/revision-notice/queue'
import { findBatchSettleEffects } from '@/lib/upload-batches/repository'
import { SCREENED_ONLY } from './document-reader'
import { claimRevisionAnnouncement, releaseRevisionAnnouncement } from './revision-announcement-repository'
import {
  announceNewRevision,
  announceSettledVersions,
  revisionRecipients,
  revisionRowNames,
  firstSummaryLine,
  notifyNewRevision,
  openMarksFacts,
} from './revision-notify'
import { readRevisionLinkNames, refreshCollectionFiles } from './reconcile-status'
import { findDocumentInOrg, findRevisionCounterparts } from './repository'
import { findPreviousVersion, findPublishedVersion } from './version-repository'

const doc = (overrides: Partial<Document>): Document =>
  ({
    id: 'doc-a',
    filename: 'Grundriss_A.pdf',
    displayName: null,
    scope: 'project',
    projectId: 'p1',
    folderId: null,
    lifecycle: 'active',
    authoredBy: 'user',
    collectionName: 'proj_abc',
    publishedVersionId: null,
    status: 'completed',
    screeningOutcome: 'clean',
    contentHash: 'h',
    screenedHash: 'h',
    createdBy: 'uploader',
    ...overrides,
  }) as Document

const OLDER = doc({ id: 'doc-a', filename: 'Grundriss_A.pdf', createdBy: 'uploader' })
const NEWER = doc({ id: 'doc-b', filename: 'Grundriss_B.pdf', createdBy: 'editor' })

function assignedTo(...userIds: string[]) {
  vi.mocked(listAssignmentsForResources).mockResolvedValue(
    userIds.map((subjectUserId) => ({
      resourceType: 'document',
      resourceId: 'doc-a',
      subjectUserId,
      assignedBy: 'someone',
      createdAt: new Date(),
    })),
  )
}

function emitted() {
  return vi.mocked(emitInboxItems).mock.calls.flatMap(([items]) => items)
}

const link = {
  organizationId: 'org-1',
  actorUserId: 'editor',
  newerId: 'doc-b',
  olderId: 'doc-a',
} as const

/** An open mark on the followed document, with the people its thread names. */
const openMark = (fields: Partial<AnnotationRecord>): AnnotationRecord =>
  ({
    id: 'ann-1',
    documentId: 'doc-a',
    versionId: 'v1',
    revisionNumber: 1,
    status: 'open',
    authorKind: 'person',
    createdBy: 'author',
    acceptedBy: null,
    assigneeUserId: null,
    delegatedBy: null,
    mentions: [],
    replies: [],
    ...fields,
  }) as AnnotationRecord

beforeEach(() => {
  vi.mocked(queueDocumentCheck).mockClear()
  vi.mocked(listDocumentAnnotations).mockReset()
  vi.mocked(listDocumentAnnotations).mockResolvedValue([])
  vi.mocked(emitInboxItems).mockReset()
  vi.mocked(emitInboxItems).mockResolvedValue(0)
  vi.mocked(findDocumentInOrg).mockReset()
  vi.mocked(findDocumentInOrg).mockImplementation(async (id) => [OLDER, NEWER].find((d) => d.id === id) ?? null)
  vi.mocked(listAssignmentsForResources).mockReset()
  assignedTo()
  vi.mocked(userHoldsProjectPermission).mockReset()
  vi.mocked(userHoldsProjectPermission).mockResolvedValue(true)
  vi.mocked(filterUsersWhoMayReadFolder).mockReset()
  vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, _folder, ids) => new Set(ids))
  vi.mocked(loadOrganizationDirectory).mockReset()
  vi.mocked(recipientsHoldingGroup).mockReset()
  vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set())
  vi.mocked(findPublishedVersion).mockReset()
  vi.mocked(findPreviousVersion).mockReset()
  vi.mocked(readRevisionLinkNames).mockReset()
  vi.mocked(readRevisionLinkNames).mockResolvedValue(null)
  vi.mocked(refreshCollectionFiles).mockReset()
  vi.mocked(refreshCollectionFiles).mockResolvedValue(undefined)
  vi.mocked(findRevisionCounterparts).mockReset()
  vi.mocked(findRevisionCounterparts).mockResolvedValue([])
  vi.mocked(claimRevisionAnnouncement).mockReset()
  vi.mocked(claimRevisionAnnouncement).mockResolvedValue(true)
  vi.mocked(releaseRevisionAnnouncement).mockReset()
  vi.mocked(releaseRevisionAnnouncement).mockResolvedValue(undefined)
  vi.mocked(findBatchSettleEffects).mockReset()
  vi.mocked(findBatchSettleEffects).mockResolvedValue(new Map())
})

describe('revisionRecipients', () => {
  it('is the assignees and the uploaders, once each, without the person who made the change', () => {
    expect(
      revisionRecipients({
        assigneeIds: ['anna', 'bernd', 'editor'],
        uploaderIds: ['anna', 'carla', null, undefined],
        actorUserId: 'editor',
      }),
    ).toEqual(['anna', 'bernd', 'carla'])
  })

  it('keeps only the mark participants for `marks_only`, still without the actor', () => {
    expect(
      revisionRecipients({
        assigneeIds: ['anna'],
        uploaderIds: ['carla'],
        participantIds: ['marker', 'anna', 'editor'],
        actorUserId: 'editor',
        audience: 'marks_only',
      }),
    ).toEqual(['marker', 'anna'])
  })

  it('tells everyone when no person made the change', () => {
    expect(revisionRecipients({ assigneeIds: ['anna'], uploaderIds: ['editor'], actorUserId: null })).toEqual([
      'anna',
      'editor',
    ])
  })
})

describe('revisionRowNames', () => {
  it('names a document as people see it, without the file extension', () => {
    expect(revisionRowNames({ filename: 'Grundriss EG Index B.pdf' }, { filename: 'Grundriss EG Index C.pdf' })).toEqual({
      subject: 'Grundriss EG Index B',
      related: 'Grundriss EG Index C',
    })
  })

  it('keeps a label that carries no extension whole, digits and dots included', () => {
    expect(revisionRowNames({ filename: 'x.pdf', displayName: 'Stand 14.08.2026' }, null)).toEqual({
      subject: 'Stand 14.08.2026',
    })
  })

  it('takes the extension off a renamed label that still ends in it', () => {
    expect(revisionRowNames({ filename: 'scan.PDF', displayName: 'Bescheid Bauamt.pdf' }, null)).toEqual({
      subject: 'Bescheid Bauamt',
    })
  })

  it('keeps the extensions when they are all that tells the two apart', () => {
    expect(revisionRowNames({ filename: 'Grundriss.pdf' }, { filename: 'Grundriss.dwg' })).toEqual({
      subject: 'Grundriss.pdf',
      related: 'Grundriss.dwg',
    })
  })

  it('keeps a name that is nothing but its extension', () => {
    expect(revisionRowNames({ filename: '.pdf' }, null)).toEqual({ subject: '.pdf' })
  })
})

describe('firstSummaryLine', () => {
  it('is the first line that says something, without list or heading markers', () => {
    expect(firstSummaryLine('\n  \n- Wand im EG verschoben\n- Tür neu')).toBe('Wand im EG verschoben')
    expect(firstSummaryLine('## Änderungen\nTür neu')).toBe('Änderungen')
  })

  it('is null for nothing to say', () => {
    expect(firstSummaryLine(null)).toBeNull()
    expect(firstSummaryLine(' \n ')).toBeNull()
  })

  it('cuts a very long line', () => {
    const line = firstSummaryLine('x'.repeat(500))
    expect(line?.length).toBe(200)
    expect(line?.endsWith('…')).toBe(true)
  })
})

describe('notifyNewRevision — a confirmed link', () => {
  it('tells the older document\'s assignees and uploader, not the person who linked, pointing at the newer document', async () => {
    assignedTo('anna', 'editor')

    const told = await notifyNewRevision({ ...link, changeSummary: 'Wand verschoben.\nTür neu.' })

    expect(told).toBe(2)
    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    for (const item of items) {
      expect(item).toMatchObject({
        organizationId: 'org-1',
        type: 'document.new_revision',
        resourceType: 'document',
        resourceId: 'doc-b',
        anchorId: 'doc-a',
        actorUserId: 'editor',
        payload: { subject: 'Grundriss_A', related: 'Grundriss_B', excerpt: 'Wand verschoben.' },
      })
      expect(item.groupKey).toContain('doc-b')
    }
  })

  it('leaves the excerpt out when there is no change summary', async () => {
    await notifyNewRevision(link)

    expect(emitted()[0].payload).toEqual({ subject: 'Grundriss_A', related: 'Grundriss_B' })
  })

  it('names the documents as people see them: a renamed one by its label', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, displayName: 'EG Index C' }) : OLDER,
    )

    await notifyNewRevision(link)

    expect(emitted()[0].payload).toMatchObject({ related: 'EG Index C' })
  })

  it('asks both documents through the screened-only reader, so a held one is never read', async () => {
    await notifyNewRevision(link)

    expect(findDocumentInOrg).toHaveBeenCalledWith('doc-b', 'org-1', SCREENED_ONLY)
    expect(findDocumentInOrg).toHaveBeenCalledWith('doc-a', 'org-1', SCREENED_ONLY)
  })

  it('says nothing about a held newer document', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => (id === 'doc-a' ? OLDER : null))
    assignedTo('anna')

    expect(await notifyNewRevision(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing when the older document is held either', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => (id === 'doc-b' ? NEWER : null))

    expect(await notifyNewRevision(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing about an archived newer document or a chat attachment', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, lifecycle: 'archived' }) : OLDER,
    )
    expect(await notifyNewRevision(link)).toBe(0)

    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, scope: 'session', projectId: null }) : OLDER,
    )
    expect(await notifyNewRevision(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('drops a recipient who is not in the project of the newer document', async () => {
    assignedTo('anna', 'outsider')
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_org, _project, userId) => userId !== 'outsider')

    await notifyNewRevision(link)

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(userHoldsProjectPermission).toHaveBeenCalledWith({ organizationId: 'org-1' }, 'p1', 'outsider', 'project:view')
  })

  it('drops a recipient who may not open the folder the newer document is filed in', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? doc({ ...NEWER, folderId: 'f-restricted' }) : OLDER,
    )
    assignedTo('anna')
    vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, folderId, ids) =>
      folderId === 'f-restricted' ? new Set(ids.filter((id) => id === 'anna')) : new Set(ids),
    )

    await notifyNewRevision(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['anna'])
  })

  it('drops a recipient who may not open the older document either', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-a' ? doc({ ...OLDER, folderId: 'f-old' }) : NEWER,
    )
    assignedTo('anna')
    vi.mocked(filterUsersWhoMayReadFolder).mockImplementation(async (_org, _project, folderId, ids) =>
      folderId === 'f-old' ? new Set(ids.filter((id) => id !== 'anna')) : new Set(ids),
    )

    await notifyNewRevision(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['uploader'])
  })

  it('tells nobody when nobody may open the newer document', async () => {
    assignedTo('anna')
    vi.mocked(userHoldsProjectPermission).mockResolvedValue(false)

    expect(await notifyNewRevision(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('reads the Büroablage as organization membership', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      doc({ ...(id === 'doc-b' ? NEWER : OLDER), scope: 'office_shelf', projectId: null }),
    )
    assignedTo('anna', 'gone')
    const member = (userId: string): [string, DirectoryPerson] => [
      userId,
      { userId, email: null, name: userId, profilePictureUrl: null },
    ]
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map([member('anna'), member('uploader')]))

    await notifyNewRevision(link)

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(userHoldsProjectPermission).not.toHaveBeenCalled()
  })

  it('does not tell someone who already holds the item again', async () => {
    assignedTo('anna')
    vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set(['anna']))

    await notifyNewRevision(link)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['uploader'])
  })

  it('writes nothing when there is nobody to tell', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-b' ? NEWER : doc({ ...OLDER, createdBy: 'editor' }),
    )

    expect(await notifyNewRevision(link)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('openMarksFacts', () => {
  it('counts the open marks, and names their Fassung when they all sit on one of the same document', () => {
    expect(openMarksFacts([{ revisionNumber: 2 }, { revisionNumber: 2 }], { sameDocument: true })).toEqual({
      variant: 'marks',
      openMarks: 2,
      marksRevision: 2,
    })
    expect(openMarksFacts([{ revisionNumber: 2 }], { sameDocument: true })).toMatchObject({ variant: 'mark', marksRevision: 2 })
  })

  it('says „the previous Fassung" for marks on several, or on another document', () => {
    expect(openMarksFacts([{ revisionNumber: 1 }, { revisionNumber: 2 }], { sameDocument: true })).toMatchObject({
      variant: 'marks_earlier',
      marksRevision: null,
    })
    expect(openMarksFacts([{ revisionNumber: 3 }], { sameDocument: false })).toMatchObject({
      variant: 'mark_earlier',
      marksRevision: null,
    })
    expect(openMarksFacts([], { sameDocument: true })).toBeNull()
  })
})

describe('notifyNewRevision — the people working on its marks', () => {
  const sameName = {
    organizationId: 'org-1',
    actorUserId: 'editor',
    newerId: 'doc-a',
    olderId: 'doc-a',
    versionId: 'v3',
  } as const

  it('tells everyone working on an open mark the new Fassung leaves behind, and how many to check', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([
      openMark({ id: 'm1', assigneeUserId: 'zustaendig', revisionNumber: 2, versionId: 'v2' }),
      openMark({
        id: 'm2',
        replies: [{ authorKind: 'person', createdBy: 'replier' }] as AnnotationRecord['replies'],
        revisionNumber: 2,
        versionId: 'v2',
      }),
      // Set on the new Fassung already, or closed: nothing to check.
      openMark({ id: 'm3', createdBy: 'fresh', versionId: 'v3', revisionNumber: 3 }),
      openMark({ id: 'm4', createdBy: 'closer', status: 'resolved', versionId: 'v2' }),
    ])

    await notifyNewRevision(sameName)

    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['author', 'replier', 'uploader', 'zustaendig'])
    expect(items[0].payload).toMatchObject({ variant: 'marks', openMarks: 2, marksRevision: 2 })
    expect(listDocumentAnnotations).toHaveBeenCalledWith('org-1', 'doc-a')
  })

  it('asks every one of them whether they may open the document, and leaves the actor out', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([openMark({ createdBy: 'editor', assigneeUserId: 'outsider', versionId: 'v2' })])
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_org, _project, userId) => userId !== 'outsider')

    await notifyNewRevision(sameName)

    expect(emitted().map((item) => item.recipientUserId)).toEqual(['uploader'])
  })

  it('counts every open mark of a document another one replaced, as from the previous Fassung', async () => {
    vi.mocked(listDocumentAnnotations).mockResolvedValue([openMark({ createdBy: 'author', revisionNumber: 4 })])

    await notifyNewRevision(link)

    expect(emitted().find((item) => item.recipientUserId === 'author')?.payload).toMatchObject({
      variant: 'mark_earlier',
      openMarks: 1,
      marksRevision: null,
    })
  })

  it('says nothing about marks when none are open', async () => {
    await notifyNewRevision(sameName)

    expect(emitted()[0].payload).not.toHaveProperty('openMarks')
  })

  // Migration 0185: the next Fassung of an E-Mail-Verlauf is news only to the
  // people whose open mark it leaves behind.
  it('reaches only the mark participants for `marks_only`: not the assignees, not the uploaders', async () => {
    assignedTo('anna')
    vi.mocked(listDocumentAnnotations).mockResolvedValue([
      openMark({ id: 'm1', createdBy: 'author', assigneeUserId: 'zustaendig', revisionNumber: 2, versionId: 'v2' }),
    ])

    await notifyNewRevision({ ...sameName, previousUploaderIds: ['first-uploader'], audience: 'marks_only' })

    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['author', 'zustaendig'])
    expect(items[0].payload).toMatchObject({ variant: 'mark', openMarks: 1, marksRevision: 2 })
    expect(listAssignmentsForResources).not.toHaveBeenCalled()
  })

  it('tells nobody for `marks_only` when no mark is open, and still claims the Fassung once', async () => {
    assignedTo('anna')

    expect(await notifyNewRevision({ ...sameName, audience: 'marks_only' })).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(claimRevisionAnnouncement).toHaveBeenCalledTimes(1)
    expect(releaseRevisionAnnouncement).not.toHaveBeenCalled()
  })
})

describe('notifyNewRevision — a same-name version', () => {
  const sameName = {
    organizationId: 'org-1',
    actorUserId: 'editor',
    newerId: 'doc-a',
    olderId: 'doc-a',
    versionId: 'v2',
    previousUploaderIds: ['first-uploader'],
  } as const

  it('tells the document\'s followers, anchored on the new version, naming no second document', async () => {
    assignedTo('anna')

    await notifyNewRevision(sameName)

    const items = emitted()
    expect(items.map((item) => item.recipientUserId).sort()).toEqual(['anna', 'first-uploader', 'uploader'])
    expect(items[0]).toMatchObject({
      type: 'document.new_revision',
      resourceType: 'document',
      resourceId: 'doc-a',
      anchorId: 'v2',
      payload: { subject: 'Grundriss_A' },
    })
    expect(items[0].payload).not.toHaveProperty('related')
  })

  it('makes a second version a second row', async () => {
    await notifyNewRevision(sameName)
    await notifyNewRevision({ ...sameName, versionId: 'v3' })

    const keys = emitted().map((item) => item.groupKey)
    expect(new Set(keys).size).toBe(2)
  })

  it('says nothing while the document is still held', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    expect(await notifyNewRevision(sameName)).toBe(0)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('announceNewRevision', () => {
  it('logs and resolves when the announcement fails: it never fails its caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(findDocumentInOrg).mockRejectedValue(new Error('db down'))

    await expect(announceNewRevision(link)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('announceSettledVersions', () => {
  const version = (overrides: Partial<DocumentVersion>): DocumentVersion =>
    ({ id: 'v2', versionNumber: 2, createdBy: 'editor', ...overrides }) as DocumentVersion

  it('announces a document whose published version is not its first, as its uploader', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))
    vi.mocked(findPreviousVersion).mockResolvedValue(version({ id: 'v1', versionNumber: 1, createdBy: 'first-uploader' }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['first-uploader', 'uploader'])
    expect(emitted()[0]).toMatchObject({ anchorId: 'v2', actorUserId: 'editor', resourceId: 'doc-a' })
  })

  it('queues the check of a document against the project, a first upload included, as its uploader', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ id: 'v1', versionNumber: 1 }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(queueDocumentCheck).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorUserId: 'uploader',
      documentId: 'doc-a',
      versionId: 'v1',
    })
  })

  it('queues no check when one settle batch announces more than ten documents (a bulk import)', async () => {
    const ids = Array.from({ length: 11 }, (_, index) => `bulk-${index}`)
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => doc({ id }))
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ids)

    expect(queueDocumentCheck).not.toHaveBeenCalled()
  })

  it('still checks a batch of ten', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `few-${index}`)
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => doc({ id }))
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ids)

    expect(queueDocumentCheck).toHaveBeenCalledTimes(10)
  })

  it('queues no check for a document that is not a project\'s', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(doc({ id: 'shelf', scope: 'office_shelf', projectId: null }))

    await announceSettledVersions('org-1', ['shelf'])

    expect(queueDocumentCheck).not.toHaveBeenCalled()
  })

  it('reads who hears from the batch that brought the document: `marks_only` keeps the uploaders out', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'doc-a' ? doc({ id: 'doc-a', uploadBatchId: 'batch-quiet' }) : doc({ id, uploadBatchId: 'batch-loud' }),
    )
    vi.mocked(findBatchSettleEffects).mockResolvedValue(
      new Map([
        ['batch-quiet', { revisionNotice: 'marks_only', runsDocumentCheck: true }],
        ['batch-loud', { revisionNotice: 'all', runsDocumentCheck: true }],
      ])
    )
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))
    vi.mocked(findPreviousVersion).mockResolvedValue(version({ id: 'v1', versionNumber: 1, createdBy: 'first-uploader' }))
    vi.mocked(listDocumentAnnotations).mockImplementation(async (_org, documentId) =>
      documentId === 'doc-a' ? [openMark({ createdBy: 'marker', versionId: 'v1' })] : [],
    )

    await announceSettledVersions('org-1', ['doc-a', 'doc-c'])

    expect(findBatchSettleEffects).toHaveBeenCalledWith('org-1', ['batch-quiet', 'batch-loud'])
    const byDocument = (id: string) => emitted().filter((item) => item.resourceId === id).map((item) => item.recipientUserId).sort()
    expect(byDocument('doc-a')).toEqual(['marker'])
    expect(byDocument('doc-c')).toEqual(['first-uploader', 'uploader'])
  })

  it('asks for no batch when no settled document carries one', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(findBatchSettleEffects).not.toHaveBeenCalled()
  })

  // Migration 0185 `runs_document_check`: the next Fassung of an E-Mail-Verlauf
  // is filed by a batch that turns the check off; a mail's attachments keep it.
  it('checks only the documents whose batch keeps the document check', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      doc({ id, uploadBatchId: id === 'thread' ? 'batch-thread' : 'batch-attachments' }),
    )
    vi.mocked(findBatchSettleEffects).mockResolvedValue(
      new Map([
        ['batch-thread', { revisionNotice: 'marks_only', runsDocumentCheck: false }],
        ['batch-attachments', { revisionNotice: 'all', runsDocumentCheck: true }],
      ])
    )
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ['thread', 'drawing'])

    expect(vi.mocked(queueDocumentCheck).mock.calls.map(([input]) => input.documentId)).toEqual(['drawing'])
  })

  it('checks a document whose batch is not found, as a person\'s upload', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(doc({ id: 'doc-a', uploadBatchId: 'batch-gone' }))
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(queueDocumentCheck).toHaveBeenCalledTimes(1)
  })

  it('says nothing for a first version', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ versionNumber: 1 }))

    await announceSettledVersions('org-1', ['doc-a'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing for a document that is still held, a Piloti document or a missing one', async () => {
    vi.mocked(findPublishedVersion).mockResolvedValue(version({}))
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'held' ? null : id === 'agent' ? doc({ id: 'agent', authoredBy: 'agent' }) : null,
    )

    await announceSettledVersions('org-1', ['held', 'agent', 'unknown'])

    expect(findDocumentInOrg).toHaveBeenCalledWith('held', 'org-1', SCREENED_ONLY)
    expect(findPublishedVersion).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('announceSettledVersions — a link written at ingestion', () => {
  const written = (change: string | null = 'Wand verschoben.\nTür neu.', basis: string | null = 'Grundriss_A.pdf') => ({
    supersededBy: null,
    supersedes: ['Grundriss_A.pdf'],
    suggestion: null,
    change: change ? { text: change, basis } : null,
  })

  beforeEach(() => {
    vi.mocked(readRevisionLinkNames).mockResolvedValue(written())
    vi.mocked(findRevisionCounterparts).mockResolvedValue([
      { id: 'doc-a', filename: 'Grundriss_A.pdf', projectId: 'p1', folderId: null, createdAt: new Date() },
    ])
    vi.mocked(findPublishedVersion).mockResolvedValue(null)
    assignedTo('anna')
  })

  it('announces once on settle: the older document\'s followers, as the newer document\'s uploader, with the first line of what changed', async () => {
    await announceSettledVersions('org-1', ['doc-b'])

    expect(findRevisionCounterparts).toHaveBeenCalledWith('org-1', 'proj_abc', ['Grundriss_A.pdf'], SCREENED_ONLY)
    expect(emitted().map((item) => item.recipientUserId).sort()).toEqual(['anna', 'uploader'])
    expect(emitted()[0]).toMatchObject({
      type: 'document.new_revision',
      resourceId: 'doc-b',
      anchorId: 'doc-a',
      actorUserId: 'editor',
      payload: { subject: 'Grundriss_A', related: 'Grundriss_B', excerpt: 'Wand verschoben.' },
    })
  })

  it('announces nothing on a second settle: those who hold the item are skipped', async () => {
    vi.mocked(recipientsHoldingGroup).mockResolvedValue(new Set(['anna', 'uploader']))

    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('reads the collection listing fresh, once per collection, before it looks at the names', async () => {
    await announceSettledVersions('org-1', ['doc-b', 'doc-b'])

    expect(refreshCollectionFiles).toHaveBeenCalledTimes(1)
    expect(refreshCollectionFiles).toHaveBeenCalledWith('proj_abc')
  })

  it('says nothing when the backend lists no replaced document, or the name resolves to nothing screened', async () => {
    vi.mocked(readRevisionLinkNames).mockResolvedValue(null)
    await announceSettledVersions('org-1', ['doc-b'])
    vi.mocked(readRevisionLinkNames).mockResolvedValue(written())
    vi.mocked(findRevisionCounterparts).mockResolvedValue([])
    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('never reads the names of a held document, a Piloti document or a chat attachment', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) =>
      id === 'agent' ? doc({ id: 'agent', authoredBy: 'agent' }) : id === 'chat' ? doc({ id: 'chat', scope: 'session' }) : null,
    )

    await announceSettledVersions('org-1', ['held', 'agent', 'chat'])

    expect(readRevisionLinkNames).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('is bounded: only the first 50 documents are looked at', async () => {
    await announceSettledVersions('org-1', Array.from({ length: 80 }, (_, i) => `doc-${i}`))

    expect(findDocumentInOrg).toHaveBeenCalledTimes(50)
  })

  it.each([
    ['the earlier upload under the newer document\'s own name', null],
    ['a third document', 'Geheim_Lohnliste.pdf'],
  ])('sends no excerpt when the change line was written against %s, not the older document', async (_label, basis) => {
    vi.mocked(readRevisionLinkNames).mockResolvedValue(written('Lohnsummen entfernt.', basis))

    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitted().length).toBeGreaterThan(0)
    for (const item of emitted()) expect(item.payload).not.toHaveProperty('excerpt')
  })

  it('a re-read announces nothing again, not even to a person assigned since the first settle', async () => {
    await announceSettledVersions('org-1', ['doc-b'])
    expect(claimRevisionAnnouncement).toHaveBeenCalledWith({ organizationId: 'org-1', documentId: 'doc-b', anchorId: 'doc-a' })
    vi.mocked(emitInboxItems).mockClear()

    // „Erneut lesen": the same document settles again. Bernd was assigned
    // meanwhile and holds no row; the Fassung was announced already.
    vi.mocked(claimRevisionAnnouncement).mockResolvedValue(false)
    assignedTo('anna', 'bernd')
    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('does not tell the older document\'s own followers about a link to itself', async () => {
    vi.mocked(findRevisionCounterparts).mockResolvedValue([
      { id: 'doc-b', filename: 'Grundriss_B.pdf', projectId: 'p1', folderId: null, createdAt: new Date() },
    ])

    await announceSettledVersions('org-1', ['doc-b'])

    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('notifyNewRevision — announced once', () => {
  it('claims the Fassung (newer document and anchor) before anything is written', async () => {
    assignedTo('anna')

    await notifyNewRevision(link)

    expect(claimRevisionAnnouncement).toHaveBeenCalledWith({ organizationId: 'org-1', documentId: 'doc-b', anchorId: 'doc-a' })
    expect(vi.mocked(claimRevisionAnnouncement).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(emitInboxItems).mock.invocationCallOrder[0],
    )
  })

  it('anchors a same-name Fassung on its version', async () => {
    await notifyNewRevision({ ...link, newerId: 'doc-a', olderId: 'doc-a', versionId: 'v2' })

    expect(claimRevisionAnnouncement).toHaveBeenCalledWith({ organizationId: 'org-1', documentId: 'doc-a', anchorId: 'v2' })
  })

  it('tells nobody about a Fassung announced before, and reads no recipient for it', async () => {
    vi.mocked(claimRevisionAnnouncement).mockResolvedValue(false)
    assignedTo('anna')

    expect(await notifyNewRevision(link)).toBe(0)
    expect(listAssignmentsForResources).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('claims nothing while a document is held, so it is announced when it passes', async () => {
    vi.mocked(findDocumentInOrg).mockImplementation(async (id) => (id === 'doc-a' ? OLDER : null))

    expect(await notifyNewRevision(link)).toBe(0)
    expect(claimRevisionAnnouncement).not.toHaveBeenCalled()
  })

  it('gives the claim back when the announcement fails, so the next settle tries again', async () => {
    assignedTo('anna')
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('db down'))

    await expect(notifyNewRevision(link)).rejects.toThrow('db down')
    expect(releaseRevisionAnnouncement).toHaveBeenCalledWith({ organizationId: 'org-1', documentId: 'doc-b', anchorId: 'doc-a' })
  })
})

describe('notifyNewRevision — Piloti notices the Fassung (ADR-0130)', () => {
  beforeEach(() => {
    vi.mocked(queueRevisionNotice).mockClear()
  })

  it('queues one notice of a Fassung under another name, as the person who made it, once the announcement is claimed', async () => {
    await notifyNewRevision(link)

    expect(queueRevisionNotice).toHaveBeenCalledWith({
      organizationId: 'org-1',
      actorUserId: 'editor',
      newerId: 'doc-b',
      olderId: 'doc-a',
    })
  })

  it('queues nothing for a Fassung announced before', async () => {
    vi.mocked(claimRevisionAnnouncement).mockResolvedValue(false)

    await notifyNewRevision(link)

    expect(queueRevisionNotice).not.toHaveBeenCalled()
  })

  it('queues nothing for a same-name version, whose older bytes the index no longer holds', async () => {
    await notifyNewRevision({ organizationId: 'org-1', actorUserId: 'editor', newerId: 'doc-a', olderId: 'doc-a', versionId: 'v2' })

    expect(queueRevisionNotice).not.toHaveBeenCalled()
  })

  it('queues nothing for a held document', async () => {
    vi.mocked(findDocumentInOrg).mockResolvedValue(null)

    await notifyNewRevision(link)

    expect(queueRevisionNotice).not.toHaveBeenCalled()
  })
})

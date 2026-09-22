/**
 * @vitest-environment node
 */
/**
 * The one-published-version invariant, exercised against a repository that
 * ENFORCES it (ADR-0054, migration 0082).
 *
 * ## Why this suite exists beside `lifecycle.spec.ts`
 *
 * That suite doubles `insertDocumentVersion` and `promoteVersionToPublished` at
 * their seams, which is right for what it asserts — permissions, effects,
 * whether the swap is asked for with the state that was read. It is exactly the
 * wrong shape for THIS bug, because the bug was an ORDERING that only a
 * database refuses: `createDocumentVersion` inserted the new version as
 * `published` and superseded the old one afterwards, and
 * `uniq_document_versions_published_per_document` is a plain partial unique
 * index — checked per statement, never deferred — so the insert was refused
 * while the previous version was still published. Every re-upload of a
 * document. A double that says "yes" to any insert cannot see it.
 *
 * So the repository is an in-memory FAKE rather than a mock: it holds rows, and
 * it refuses a second `published` row for one document exactly as Postgres
 * does. Not a substitute for `task db:test:rls` and not pretending to be one —
 * what it stands in for is a UNIQUE INDEX, which is the one part of the
 * database whose behaviour can be stated in four lines and checked here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { Document, DocumentVersion, NewDocumentVersion } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'

/** Postgres' `uniq_document_versions_published_per_document`, in four lines. */
class PublishedPerDocumentViolation extends Error {
  constructor(documentId: string) {
    super(
      `duplicate key value violates unique constraint ` +
        `"uniq_document_versions_published_per_document" (document_id)=(${documentId})`,
    )
    this.name = 'PublishedPerDocumentViolation'
  }
}

const rows: DocumentVersion[] = []
const items = new Map<string, { publishedVersionId: string | null; fileSize: number | null }>()

function assertOnePublished(documentId: string): void {
  const published = rows.filter(
    (row) => row.documentId === documentId && row.state === 'published',
  )
  if (published.length > 1) throw new PublishedPerDocumentViolation(documentId)
}

function materialize(values: NewDocumentVersion): DocumentVersion {
  return {
    id: `ver_${rows.length + 1}`,
    storageBucket: null,
    contentType: null,
    fileSize: null,
    contentHash: null,
    submittedBy: null,
    submittedByActor: 'human',
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    originConversationId: null,
    projectId: null,
    state: 'draft',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...values,
  } as DocumentVersion
}

vi.mock('./version-repository', () => ({
  nextVersionNumber: vi.fn(async (documentId: string) =>
    rows.filter((row) => row.documentId === documentId).length + 1,
  ),
  /**
   * The pre-fix path: insert, then supersede. Kept callable so the revert check
   * is a one-line edit in `lifecycle.ts` rather than a rewrite of this fake.
   */
  insertDocumentVersion: vi.fn(async (values: NewDocumentVersion) => {
    const row = materialize(values)
    rows.push(row)
    assertOnePublished(row.documentId)
    return row
  }),
  insertPublishedVersion: vi.fn(async (values: NewDocumentVersion) => {
    // Supersede FIRST, inside the transaction, exactly as the real one does.
    const superseded = rows.filter(
      (row) => row.documentId === values.documentId && row.state === 'published',
    )
    for (const row of superseded) row.state = 'superseded'
    const row = materialize(values)
    rows.push(row)
    assertOnePublished(row.documentId)
    items.set(row.documentId, {
      publishedVersionId: row.id,
      fileSize: row.fileSize ?? null,
    })
    return { version: row, superseded }
  }),
  promoteVersionToPublished: vi.fn(async (versionId: string, documentId: string) => {
    const superseded = rows.filter(
      (row) => row.documentId === documentId && row.state === 'published' && row.id !== versionId,
    )
    for (const row of superseded) row.state = 'superseded'
    const target = rows.find((row) => row.id === versionId)
    if (!target) return null
    target.state = 'published'
    assertOnePublished(documentId)
    items.set(documentId, { publishedVersionId: target.id, fileSize: target.fileSize ?? null })
    return { version: target, superseded }
  }),
  compareAndSwapVersionState: vi.fn(),
  findDocumentVersion: vi.fn(),
  findOpenVersion: vi.fn().mockResolvedValue(null),
  findPublishedVersion: vi.fn().mockResolvedValue(null),
  listDocumentVersionSummaries: vi.fn().mockResolvedValue([]),
  listDocumentVersions: vi.fn().mockResolvedValue([]),
}))

vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./repository', () => ({
  findDocumentInOrg: vi.fn(),
  findFolderPathInProject: vi.fn().mockResolvedValue(null),
}))
vi.mock('./reviewers', () => ({
  listReviewCandidates: vi.fn().mockResolvedValue([]),
  resolveReviewers: vi.fn().mockResolvedValue({ reviewers: ['user_anna'], selfReview: false }),
}))
vi.mock('./version-content', () => ({
  BACKEND_PURGE_TIMEOUT_MS: 10_000,
  admitVersionBytes: vi.fn(),
  readVersionContent: vi.fn().mockResolvedValue(''),
  renderVersionBytes: vi.fn(),
  resolveVersionBucket: vi.fn().mockResolvedValue('grid-org-1'),
  storeVersionBytes: vi.fn(),
  versionStorageKey: (doc: { storageKey: string }) => doc.storageKey,
}))
vi.mock('./service', () => ({
  dispatchDocument: vi.fn(),
  AgentAuthoredDocumentNotIndexableError: class extends Error {},
}))
vi.mock('./collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./collection-file-ref')>()),
  purgeIngestedChunks: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn().mockResolvedValue(new Map()) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn(), resolveInboxItemsFor: vi.fn() }))
vi.mock('@/lib/tasks/delegation', () => ({ delegateTask: vi.fn() }))

import { getAccessibleDocument } from './access'
import { createDocumentVersion } from './lifecycle'

const session: AuthorizedSession = {
  userId: 'user_uploader',
  email: 'uploader@example.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
}

const document: Document = makeDocument({ id: 'doc_1', projectId: 'proj_1' })

const upload = (fileSize: number) =>
  createDocumentVersion(session, {
    document,
    op: 'upload',
    storageKey: 'org/org_1/project/proj_1/doc/doc_1/plan.pdf',
    storageBucket: 'grid-org-1',
    contentType: 'application/pdf',
    fileSize,
    contentHash: `sha256:${fileSize}`,
  })

beforeEach(() => {
  rows.length = 0
  items.clear()
  vi.mocked(getAccessibleDocument).mockResolvedValue(document)
})

describe('a re-upload, against a repository that holds the index', () => {
  it('writes version 2 without ever leaving two published rows standing', async () => {
    await upload(1_000)
    await expect(upload(2_000)).resolves.toMatchObject({ state: 'published' })

    expect(rows.map((row) => row.state)).toEqual(['superseded', 'published'])
    expect(rows.map((row) => row.versionNumber)).toEqual([1, 2])
  })

  it('leaves the superseded version’s bytes named by its own row', async () => {
    // History you cannot open is a list of dates: the previous version keeps
    // its object, and nothing here deletes it.
    await upload(1_000)
    await upload(2_000)

    const [previous] = rows
    expect(previous.state).toBe('superseded')
    expect(previous.storageKey).toBe('org/org_1/project/proj_1/doc/doc_1/plan.pdf')
    expect(previous.fileSize).toBe(1_000)
  })

  it('moves the item’s pointer to the new version, in the same call', async () => {
    await upload(1_000)
    await upload(2_000)
    expect(items.get('doc_1')).toEqual({ publishedVersionId: rows[1].id, fileSize: 2_000 })
  })

  it('is idempotent in the shape that matters: N uploads leave exactly one published row', async () => {
    for (const size of [1_000, 2_000, 3_000, 4_000]) await upload(size)
    expect(rows.filter((row) => row.state === 'published')).toHaveLength(1)
    expect(rows).toHaveLength(4)
  })
})

/**
 * @vitest-environment node
 */
/**
 * The BYTE half of the lifecycle (ADR-0054): what a version's replacement is
 * rendered through, what it costs, when it is written, and what archiving does.
 *
 * Four things are asserted here, and they are different in kind:
 *
 *   - the AI-provenance marking survives an update. The Python tool sends raw
 *     Markdown and the branding is the filing seam's, so writing the body
 *     verbatim stripped the marking off every document Piloti revised;
 *   - the bytes are ADMITTED before they are written, as a delta;
 *   - the item's columns mirror the version that IS the item's bytes, and only
 *     that one — the quota ledger reads `documents.file_size`;
 *   - the internal read is scoped by the conversation the turn is running in,
 *     not by an organization the caller states.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { Document, DocumentVersion } from '@/lib/db/schema'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('./version-repository', () => ({
  findDocumentVersion: vi.fn(),
  findDocumentVersionInOrg: vi.fn(),
  setDocumentLifecycle: vi.fn(),
  swapVersionContent: vi.fn(),
}))
vi.mock('@/lib/storage/discard', () => ({ discardObject: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationInOrg: vi.fn() }))
// A subject in a folder every member may read admits nothing (ADR-0087); the
// restricted case overrides `placementCollectionFor` and the admission.
vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/conversations/restricted-use', () => ({ admitRestrictedUse: vi.fn() }))
vi.mock('@/lib/projects/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects/repository')>()),
  findProjectCollectionName: vi.fn(async () => 'proj_abc'),
}))
vi.mock('@/lib/organizations/service', () => ({
  getOrganizationDisplayName: vi.fn().mockResolvedValue('Büro Nord ZT GmbH'),
}))
vi.mock('@/lib/storage/service', () => ({
  assertWithinStorageQuota: vi.fn(),
  getStorageQuotaBytes: vi.fn().mockResolvedValue(10_000),
  STORAGE_QUOTA_EXCEEDED_MESSAGE: 'no storage space left',
}))
vi.mock('@/lib/storage/bucket', () => ({
  ensureTenantBucketChecked: vi.fn().mockResolvedValue('grid-org-1'),
  resolveDocumentBucket: () => 'grid-org-1',
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/download-log/service', () => ({ recordDocumentAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('./collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./collection-file-ref')>()),
  purgeIngestedChunks: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn() },
  bucketAdminS3Client: { send: vi.fn() },
}))

import { s3Client } from '@/lib/s3'
import { assertWithinStorageQuota } from '@/lib/storage/service'
import { recordAuditEvent } from '@/lib/audit/service'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { placementCollectionFor } from '@/lib/authz/folder-access'
import { admitRestrictedUse } from '@/lib/conversations/restricted-use'
import { getAccessibleDocument } from './access'
import { purgeIngestedChunks } from './collection-file-ref'
import { findDocumentInOrg } from './repository'
import { mayReadDocument } from './document-reader'
import {
  findDocumentVersion,
  findDocumentVersionInOrg,
  setDocumentLifecycle,
  swapVersionContent,
} from './version-repository'
import { discardObject } from '@/lib/storage/discard'
import {
  admitVersionBytes,
  archiveDocument,
  newVersionWriteId,
  readVersionContent,
  readVersionForService,
  readVersionTextForTask,
  renderVersionBytes,
  versionMirrorsItem,
  versionWriteKey,
  writeVersionContent,
} from './version-content'
import { AI_PROVENANCE_PROPERTIES } from '@/lib/ai-provenance'
import { recordDocumentAccess } from '@/lib/download-log/service'

const session: AuthorizedSession = {
  userId: 'user_reviewer',
  email: 'reviewer@example.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
}

const document: Document = makeDocument({ id: 'doc_1', projectId: 'proj_1' })

const agentDocument: Document = makeDocument({
  id: 'doc_1',
  projectId: 'proj_1',
  authoredBy: 'agent',
  authoredByProducer: 'agent_document',
  authoredByRef: 'conv_1-aktenvermerk',
  authoredByRefKind: 'answer_artifact',
  filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md',
  contentType: 'text/markdown',
})

function version(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: 'ver_1',
    organizationId: 'org_1',
    documentId: 'doc_1',
    projectId: 'proj_1',
    versionNumber: 1,
    state: 'draft',
    storageKey: 'org/org_1/project/proj_1/doc/doc_1/plan.md',
    storageBucket: 'grid-org-1',
    contentType: 'text/markdown',
    fileSize: 12,
    contentHash: 'sha256:abc',
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
    createdBy: 'user_author',
    originConversationId: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAccessibleDocument).mockResolvedValue(document)
})

describe('versionWriteKey', () => {
  it('gives every re-upload a directory of its own, even when the number reads 1', () => {
    // The number is a hint. It reads 1 while a concurrent first upload has its
    // row but not its version; a plain key here would overwrite that upload.
    expect(versionWriteKey('org/o/session/s_1/doc/d/plan.pdf', 1, 'a1b2c3d4e5f6')).toBe( // pragma: allowlist secret (a write-id fixture, not a credential)
      'org/o/session/s_1/doc/d/v1/a1b2c3d4e5f6/plan.pdf',
    )
  })

  it('never hands two overlapping re-uploads the same key, although both read the same number', () => {
    const base = 'org/o/project/p/doc/d/plan.pdf'
    const first = versionWriteKey(base, 3, newVersionWriteId())
    const second = versionWriteKey(base, 3, newVersionWriteId())
    expect(first).not.toBe(second)
    expect(first).toMatch(/\/doc\/d\/v3\/[0-9a-f]{12}\/plan\.pdf$/)
  })

  it('replaces an earlier version segment rather than nesting inside it', () => {
    expect(
      versionWriteKey('org/o/project/p/doc/d/v3/a1b2c3d4e5f6/plan.md', 5, 'ffffffffffff'),
    ).toBe('org/o/project/p/doc/d/v5/ffffffffffff/plan.md')
    expect(versionWriteKey('org/o/archiv/doc/d/v2/plan.md', 2, 'ffffffffffff')).toBe(
      'org/o/archiv/doc/d/v2/ffffffffffff/plan.md',
    )
  })

  it('has no version-1 shortcut: a rewrite of version 1 still gets its own object', () => {
    expect(versionWriteKey('org/o/session/s_1/doc/d/plan.md', 1, 'ffffffffffff')).toBe(
      'org/o/session/s_1/doc/d/v1/ffffffffffff/plan.md',
    )
  })

  it('still gives a key that predates the shelf layout a directory of its own', () => {
    expect(versionWriteKey('legacy/plan.md', 2, 'ffffffffffff')).toBe(
      'legacy/v2/ffffffffffff/plan.md',
    )
    expect(versionWriteKey('plan.md', 2, 'ffffffffffff')).toBe('v2/ffffffffffff/plan.md')
  })
})

describe('renderVersionBytes — the marking survives an update', () => {
  it('re-renders an agent document through its producer, marking and all', async () => {
    // The Python tool sends the model's raw Markdown; the branding line, the
    // disclaimer and the marking belong to the FILING seam and were added when
    // the first draft was written. Writing the body verbatim over them left the
    // product saying nothing about its own authorship — the one failure
    // `markingIsInBytes` exists to make impossible.
    const rendered = await renderVersionBytes(agentDocument, version(), '# Aktenvermerk\n\nGK 4.')
    const text = rendered.bytes.toString('utf8')

    expect(text).toContain('# Aktenvermerk')
    expect(text).toContain(`${AI_PROVENANCE_PROPERTIES.generated}=true`)
    expect(text).toContain(`${AI_PROVENANCE_PROPERTIES.generator}=Piloti`)
    expect(rendered.contentType).toBe('text/markdown')
    expect(rendered.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('leaves a person’s own Markdown exactly as they wrote it', async () => {
    // The same lie in the other direction: stamping „von Piloti erstellt" onto
    // a file a person wrote.
    const rendered = await renderVersionBytes(document, version(), '# Von Hand\n')
    expect(rendered.bytes.toString('utf8')).toBe('# Von Hand\n')
  })
})

/**
 * The courtesy check's estimate. The ceiling is measured in the swap's own
 * transaction (`version-repository.spec.ts`); this only has to refuse the
 * obvious case before the bytes move, and it must not undercharge a fork.
 */
describe('admitVersionBytes', () => {
  const published = makeDocument({
    ...document,
    storageKey: 'org/org_1/project/proj_1/doc/doc_1/plan.md',
    publishedVersionId: 'ver_published',
  })

  it('charges a freshly forked draft the FULL size, because the published bytes stay', async () => {
    // The fork shares the published object, so its `fileSize` IS the published
    // file's. `1_600 − 1_000` charged 600 for 1_600 new bytes; the loop of fork,
    // write, reject, fork again was never checked at all when sizes matched.
    const fork = version({ id: 'ver_draft', storageKey: published.storageKey, fileSize: 1_000 })
    await admitVersionBytes('org_1', published, fork, 1_600)
    expect(assertWithinStorageQuota).toHaveBeenCalledWith('org_1', 1_600)
  })

  it('charges the DELTA for a draft that owns its previous object', async () => {
    const written = version({
      id: 'ver_draft',
      storageKey: 'org/org_1/project/proj_1/doc/doc_1/v2/aaaaaaaaaaaa/plan.md',
      fileSize: 1_000,
    })
    await admitVersionBytes('org_1', published, written, 1_600)
    expect(assertWithinStorageQuota).toHaveBeenCalledWith('org_1', 600)
  })

  it('charges the DELTA for the version that IS the item’s bytes', async () => {
    const item = makeDocument({ ...published, publishedVersionId: null })
    await admitVersionBytes(
      'org_1',
      item,
      version({ versionNumber: 1, storageKey: item.storageKey, fileSize: 1_000 }),
      1_600,
    )
    expect(assertWithinStorageQuota).toHaveBeenCalledWith('org_1', 600)
  })

  it('asks nothing when a draft of its own shrinks', async () => {
    await admitVersionBytes(
      'org_1',
      published,
      version({ id: 'ver_draft', storageKey: 'k/own', fileSize: 1_000 }),
      400,
    )
    expect(assertWithinStorageQuota).not.toHaveBeenCalled()
  })

  it('lets a refusal through, so nothing is written or swapped', async () => {
    vi.mocked(assertWithinStorageQuota).mockRejectedValueOnce(new Error('no room'))
    await expect(admitVersionBytes('org_1', published, version(), 10_000)).rejects.toThrow(
      /no room/,
    )
  })
})

/**
 * Two writers holding the same `If-Match` (the defect this block pins).
 *
 * `If-Match` is checked against a row read at the start, and the swap used to
 * filter on `state = 'draft'` alone — draft → draft — so both writers won and
 * both wrote ONE key, in either order. Now each write has its own object,
 * stored before the swap, and the swap asserts the state, key and hash that
 * were read.
 */
describe('writeVersionContent — one object per write, swapped only if unchanged', () => {
  const rendered = {
    bytes: Buffer.from('# neu', 'utf8'),
    contentType: 'text/markdown',
    contentHash: 'sha256:neu',
  }
  const draftKey = 'org/org_1/project/proj_1/doc/doc_1/v2/aaaaaaaaaaaa/plan.md'
  const read = version({
    id: 'ver_draft',
    versionNumber: 2,
    storageKey: draftKey,
    contentHash: 'sha256:alt',
  })
  const item = makeDocument({
    ...agentDocument,
    storageKey: 'org/org_1/project/proj_1/doc/doc_1/plan.md',
    publishedVersionId: 'ver_published',
  })

  function putKeys(): string[] {
    return vi
      .mocked(s3Client.send)
      .mock.calls.map(([command]) => (command as unknown as { input: { Key: string } }).input.Key)
  }

  beforeEach(() => {
    vi.mocked(swapVersionContent).mockImplementation(async (input) => ({
      ok: true,
      version: { ...read, ...input.patch } as DocumentVersion,
      previousKeyOrphaned: true,
    }))
  })

  it('stores the bytes under a fresh key BEFORE the swap, and swaps on what it read', async () => {
    const order: string[] = []
    vi.mocked(s3Client.send).mockImplementation(async () => {
      order.push('put')
      return {}
    })
    vi.mocked(swapVersionContent).mockImplementationOnce(async (input) => {
      order.push('swap')
      return { ok: true, version: { ...read, ...input.patch } as DocumentVersion, previousKeyOrphaned: false }
    })

    const swapped = await writeVersionContent({
      organizationId: 'org_1',
      document: item,
      version: read,
      rendered,
      stamp: { state: 'draft' },
    })

    expect(order).toEqual(['put', 'swap'])
    const [written] = putKeys()
    expect(written).toMatch(/\/doc\/doc_1\/v2\/[0-9a-f]{12}\/plan\.md$/)
    expect(written).not.toBe(draftKey)
    expect(swapVersionContent).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'ver_draft',
        // The expectation is the row AS READ — the loser of two writers holding
        // one If-Match matches no row.
        expected: { state: 'draft', storageKey: draftKey, contentHash: 'sha256:alt' },
        patch: expect.objectContaining({
          state: 'draft',
          storageKey: written,
          contentHash: 'sha256:neu',
          fileSize: 5,
        }),
        mirrorsItem: false,
      }),
    )
    expect(swapped.storageKey).toBe(written)
  })

  it('never writes two concurrent replaces to one key', async () => {
    const input = { organizationId: 'org_1', document: item, version: read, rendered, stamp: {} }
    await Promise.all([writeVersionContent(input), writeVersionContent(input)])
    const [first, second] = putKeys()
    expect(first).not.toBe(second)
  })

  it('answers the loser with 409 and deletes the object it wrote — never the winner’s', async () => {
    vi.mocked(swapVersionContent).mockResolvedValueOnce({ ok: false, reason: 'conflict' })

    await expect(
      writeVersionContent({ organizationId: 'org_1', document: item, version: read, rendered, stamp: {} }),
    ).rejects.toMatchObject({ status: 409 })

    const [written] = putKeys()
    expect(discardObject).toHaveBeenCalledTimes(1)
    expect(discardObject).toHaveBeenCalledWith('grid-org-1', written)
  })

  it('deletes the object it wrote when the swap itself fails', async () => {
    vi.mocked(swapVersionContent).mockRejectedValueOnce(new Error('connection reset'))
    await expect(
      writeVersionContent({ organizationId: 'org_1', document: item, version: read, rendered, stamp: {} }),
    ).rejects.toThrow('connection reset')
    expect(discardObject).toHaveBeenCalledWith('grid-org-1', putKeys()[0])
  })

  it('deletes the draft’s previous object once nothing names it', async () => {
    await writeVersionContent({ organizationId: 'org_1', document: item, version: read, rendered, stamp: {} })
    expect(discardObject).toHaveBeenCalledWith('grid-org-1', draftKey)
  })

  it('leaves a shared previous object alone — a fresh fork still carries the published key', async () => {
    vi.mocked(swapVersionContent).mockImplementationOnce(async (input) => ({
      ok: true,
      version: { ...read, ...input.patch } as DocumentVersion,
      previousKeyOrphaned: false,
    }))
    await writeVersionContent({
      organizationId: 'org_1',
      document: item,
      version: { ...read, storageKey: item.storageKey },
      rendered,
      stamp: {},
    })
    expect(discardObject).not.toHaveBeenCalled()
  })

  it('mirrors onto the item when the version IS the item’s bytes', async () => {
    // `sum(documents.file_size)` is the hot half of the quota ledger, and the
    // download path reads `documents.storage_key`.
    await writeVersionContent({
      organizationId: 'org_1',
      document: makeDocument({ ...agentDocument, publishedVersionId: null }),
      version: version({ versionNumber: 1 }),
      rendered,
      stamp: {},
    })
    expect(swapVersionContent).toHaveBeenCalledWith(expect.objectContaining({ mirrorsItem: true }))
  })

  it('hands the swap the organization’s quota, so the ceiling is held under the lock', async () => {
    await writeVersionContent({ organizationId: 'org_1', document: item, version: read, rendered, stamp: {} })
    expect(swapVersionContent).toHaveBeenCalledWith(expect.objectContaining({ quotaBytes: 10_000 }))
  })

  it('takes its object back and answers 507 when the locked admission refuses', async () => {
    vi.mocked(swapVersionContent).mockResolvedValueOnce({
      ok: false,
      reason: 'quota',
      usedBytes: 9_999,
    })

    await expect(
      writeVersionContent({ organizationId: 'org_1', document: item, version: read, rendered, stamp: {} }),
    ).rejects.toMatchObject({ status: 507 })
    expect(discardObject).toHaveBeenCalledWith('grid-org-1', putKeys()[0])
    // The previous object is NOT touched: the row still names it.
    expect(discardObject).toHaveBeenCalledTimes(1)
  })

  it('writes and swaps nothing when the quota courtesy check refuses', async () => {
    vi.mocked(assertWithinStorageQuota).mockRejectedValueOnce(new Error('no room'))
    await expect(
      writeVersionContent({
        organizationId: 'org_1',
        document: item,
        version: { ...read, fileSize: 1 },
        rendered: { ...rendered, bytes: Buffer.alloc(10_000) },
        stamp: {},
      }),
    ).rejects.toThrow(/no room/)
    expect(s3Client.send).not.toHaveBeenCalled()
    expect(swapVersionContent).not.toHaveBeenCalled()
  })
})

describe('versionMirrorsItem', () => {
  it('is the published pointer whenever there is one', () => {
    const doc = makeDocument({ ...document, publishedVersionId: 'ver_live' })
    expect(versionMirrorsItem(doc, version({ id: 'ver_live' }))).toBe(true)
    expect(versionMirrorsItem(doc, version({ id: 'ver_draft', versionNumber: 1 }))).toBe(false)
  })

  it('is version 1 before anything has been published', () => {
    const doc = makeDocument({ ...document, publishedVersionId: null })
    expect(versionMirrorsItem(doc, version({ versionNumber: 1 }))).toBe(true)
    expect(versionMirrorsItem(doc, version({ versionNumber: 2 }))).toBe(false)
  })
})

describe('readVersionForService — the conversation is part of the predicate', () => {
  const body = { transformToString: async () => '# Aktenvermerk' }

  beforeEach(() => {
    vi.mocked(findDocumentVersionInOrg).mockResolvedValue(version())
    vi.mocked(findDocumentInOrg).mockResolvedValue(agentDocument)
    vi.mocked(s3Client.send).mockResolvedValue({ Body: body } as never)
  })

  it('serves the bytes when the version IS that conversation’s subject', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: 'document',
      subjectResourceId: 'doc_1',
    } as never)

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).resolves.toMatchObject({
      documentId: 'doc_1',
      content: '# Aktenvermerk',
      state: 'draft',
    })
  })

  it('answers 404 for a conversation about a DIFFERENT document', async () => {
    // The organization is something the caller STATES, and a version id is a
    // uuid the caller supplies — so the organization alone let anything holding
    // the internal token read any version's bytes.
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: 'document',
      subjectResourceId: 'doc_other',
    } as never)

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('answers 404 for a quarantined subject, so its bytes never reach a model (ADR-0085)', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: 'document',
      subjectResourceId: 'doc_1',
    } as never)
    // The repository answers by the reader it is asked for (`documentVisibleTo`).
    const held = { ...agentDocument, status: 'quarantined' }
    vi.mocked(findDocumentInOrg).mockImplementation(async (_id, _org, reader) =>
      mayReadDocument(held, reader) ? held : null
    )

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({ status: 404 })
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  // Held from upload until the screen passes, not from the verdict: a person's
  // upload still on its way through the gate is no model's subject either.
  it('answers 404 for an upload whose screening has not passed yet (ADR-0085)', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: 'document',
      subjectResourceId: 'doc_1',
    } as never)
    const pending = { ...agentDocument, authoredBy: 'user' as const, status: 'pending', screeningOutcome: null }
    vi.mocked(findDocumentInOrg).mockImplementation(async (_id, _org, reader) =>
      mayReadDocument(pending, reader) ? pending : null
    )

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({ status: 404 })
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  /**
   * The verdict is about the item's bytes; the subject read returns a VERSION's
   * (ADR-0085). A superseded version a person uploaded holds bytes no verdict
   * on record judged: replaced while it was still being read, or after its
   * reading failed. It reaches no model, however the item stands now.
   */
  describe('the bytes the screen judged, not the item', () => {
    const screened = makeDocument({
      id: 'doc_1',
      projectId: 'proj_1',
      contentHash: 'sha256:now',
      screenedHash: 'sha256:now',
      screeningOutcome: 'clean',
    })

    beforeEach(() => {
      vi.mocked(findConversationInOrg).mockResolvedValue({
        subjectResourceType: 'document',
        subjectResourceId: 'doc_1',
      } as never)
      vi.mocked(findDocumentInOrg).mockImplementation(async (_id, _org, reader) =>
        mayReadDocument(screened, reader) ? screened : null
      )
    })

    it('answers 404 for an earlier upload of a screened document whose bytes no verdict judged', async () => {
      vi.mocked(findDocumentVersionInOrg).mockResolvedValue(version({ state: 'superseded', contentHash: 'sha256:before' }))

      await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({ status: 404 })
      expect(s3Client.send).not.toHaveBeenCalled()
    })

    it('serves the version that holds the bytes the verdict judged', async () => {
      vi.mocked(findDocumentVersionInOrg).mockResolvedValue(version({ state: 'published', contentHash: 'sha256:now' }))

      await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).resolves.toMatchObject({ content: '# Aktenvermerk' })
    })

    it('serves a draft, whose text was written in the workflow rather than uploaded', async () => {
      vi.mocked(findDocumentVersionInOrg).mockResolvedValue(version({ state: 'draft', contentHash: 'sha256:edited' }))

      await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).resolves.toMatchObject({ content: '# Aktenvermerk' })
    })
  })

  it('answers 404 for an ordinary chat, which is about nothing', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as never)

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({
      status: 404,
    })
  })

  describe('a subject in a folder not every member may read (ADR-0086, ADR-0087)', () => {
    const RESTRICTED = 'proj_abc_r0123456789ab'
    const ANSWER_ID = '0b7c6d2e-5f1a-5c3b-9d4e-8f7a6b5c4d3e'
    beforeEach(() => {
      vi.mocked(findConversationInOrg).mockResolvedValue({
        subjectResourceType: 'document',
        subjectResourceId: 'doc_1',
      } as never)
      vi.mocked(findDocumentInOrg).mockResolvedValue({ ...agentDocument, folderId: 'folder_vertraege' })
      vi.mocked(placementCollectionFor).mockResolvedValue(RESTRICTED)
    })

    it('admits the folder for the conversation before the bytes leave, and says so', async () => {
      vi.mocked(admitRestrictedUse).mockResolvedValue({ admitted: [RESTRICTED], refused: [], recorded: ['folder_vertraege'] })

      await expect(readVersionForService('ver_1', 'org_1', 'conv_1', { askerUserId: 'user_asker', answerMessageId: ANSWER_ID })).resolves.toMatchObject({
        content: '# Aktenvermerk',
        drewOnRestrictedFolder: true,
      })
      expect(admitRestrictedUse).toHaveBeenCalledWith(
        {
          organizationId: 'org_1',
          conversationId: 'conv_1',
          userId: 'user_asker',
          projectId: 'proj_1',
          // Marked in the admission's transaction, before the bytes leave (ADR-0091).
          answerMessageId: ANSWER_ID,
        },
        [RESTRICTED],
      )
    })

    it('reads as no subject when the admission is refused, or there is no asker to check', async () => {
      vi.mocked(admitRestrictedUse).mockResolvedValue({ admitted: [], refused: [RESTRICTED], recorded: [] })
      await expect(readVersionForService('ver_1', 'org_1', 'conv_1', { askerUserId: 'user_asker', answerMessageId: ANSWER_ID })).rejects.toMatchObject({
        status: 404,
      })
      await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({ status: 404 })
      expect(s3Client.send).not.toHaveBeenCalled()
    })
  })

  it('answers 404 across tenants, indistinguishably from an id that never existed', async () => {
    vi.mocked(findDocumentVersionInOrg).mockResolvedValue(null)
    await expect(readVersionForService('ver_1', 'org_other', 'conv_1')).rejects.toMatchObject({
      status: 404,
    })
    expect(s3Client.send).not.toHaveBeenCalled()
  })
})

describe('archiveDocument', () => {
  it('leaves the listings without deleting anything, and audits', async () => {
    const result = await archiveDocument(session, 'doc_1')
    expect(result).toEqual({ documentId: 'doc_1', lifecycle: 'archived' })
    expect(setDocumentLifecycle).toHaveBeenCalledWith('doc_1', 'org_1', 'archived')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.archived', targetId: 'doc_1' }),
    )
  })

  it('takes the passages with it, so an archived document stops answering', async () => {
    await archiveDocument(session, 'doc_1')

    expect(purgeIngestedChunks).toHaveBeenCalledWith(
      'http://backend:8000',
      expect.objectContaining({ filename: 'plan.pdf' }),
      expect.any(Number),
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ chunksPurged: true }) }),
    )
  })

  it('purges nothing for an agent draft, which owns no passages to purge', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(
      makeDocument({ ...agentDocument, publishedVersionId: null }),
    )

    await archiveDocument(session, 'doc_1')

    expect(purgeIngestedChunks).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      // `null` is "this row owns no chunks" and must not read as "the backend
      // refused", which is what `false` means.
      expect.objectContaining({ metadata: expect.objectContaining({ chunksPurged: null }) }),
    )
  })

  it('archives even when the backend refuses, and says so on the trail', async () => {
    vi.mocked(purgeIngestedChunks).mockResolvedValue(false)

    const result = await archiveDocument(session, 'doc_1')

    expect(result.lifecycle).toBe('archived')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ chunksPurged: false }) }),
    )
  })
})

describe('reading a version’s text, and the download log', () => {
  beforeEach(() => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    vi.mocked(s3Client.send).mockResolvedValue({ Body: { transformToString: async () => '# Aktenvermerk' } } as never)
  })

  it('records the hand-over to the person, naming the version they opened', async () => {
    await expect(readVersionContent(session, 'doc_1', 'ver_1')).resolves.toBe('# Aktenvermerk')

    expect(recordDocumentAccess).toHaveBeenCalledWith(session, document, 'version', { versionId: 'ver_1' })
  })

  it('records nothing for a version that does not exist', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(null)

    await expect(readVersionContent(session, 'doc_1', 'ver_9')).rejects.toMatchObject({ status: 404 })

    expect(recordDocumentAccess).not.toHaveBeenCalled()
  })

  it('does not hand the text over when the log refuses (a folder with its own list)', async () => {
    vi.mocked(recordDocumentAccess).mockRejectedValueOnce(Object.assign(new Error('not recorded'), { status: 503 }))

    await expect(readVersionContent(session, 'doc_1', 'ver_1')).rejects.toMatchObject({ status: 503 })
  })

  // A model reads this text, so a document whose screening has not passed
  // answers 404 to its reviewer too (ADR-0085): no held text in a task.
  it.each([
    ['quarantined', { status: 'quarantined', screeningOutcome: 'quarantined' as const }],
    ['still being screened', { status: 'processing', screeningOutcome: null }],
  ])('refuses the agent task a document that is %s, before reading a byte', async (_label, held) => {
    vi.mocked(getAccessibleDocument).mockResolvedValueOnce({ ...document, ...held })

    await expect(readVersionTextForTask(session, 'doc_1', 'ver_1')).rejects.toMatchObject({ status: 404 })
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('refuses the agent task an earlier upload whose bytes no verdict judged, before reading a byte', async () => {
    vi.mocked(getAccessibleDocument).mockResolvedValueOnce({
      ...document,
      contentHash: 'sha256:now',
      screenedHash: 'sha256:now',
      screeningOutcome: 'clean',
    })
    vi.mocked(findDocumentVersion).mockResolvedValueOnce(version({ state: 'superseded', contentHash: 'sha256:before' }))

    await expect(readVersionTextForTask(session, 'doc_1', 'ver_1')).rejects.toMatchObject({ status: 404 })
    expect(s3Client.send).not.toHaveBeenCalled()
  })

  it('does not record the read that feeds an agent task: the reviewer never receives those bytes', async () => {
    await expect(readVersionTextForTask(session, 'doc_1', 'ver_1')).resolves.toBe('# Aktenvermerk')

    expect(recordDocumentAccess).not.toHaveBeenCalled()
  })
})

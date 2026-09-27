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
vi.mock('@/lib/organizations/service', () => ({
  getOrganizationDisplayName: vi.fn().mockResolvedValue('Büro Nord ZT GmbH'),
}))
vi.mock('@/lib/storage/service', () => ({ assertWithinStorageQuota: vi.fn() }))
vi.mock('@/lib/storage/bucket', () => ({
  ensureTenantBucketChecked: vi.fn().mockResolvedValue('grid-org-1'),
  resolveDocumentBucket: () => 'grid-org-1',
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
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
import { getAccessibleDocument } from './access'
import { purgeIngestedChunks } from './collection-file-ref'
import { findDocumentInOrg } from './repository'
import {
  findDocumentVersionInOrg,
  setDocumentLifecycle,
  swapVersionContent,
} from './version-repository'
import { discardObject } from '@/lib/storage/discard'
import {
  admitVersionBytes,
  archiveDocument,
  newVersionWriteId,
  readVersionForService,
  renderVersionBytes,
  versionedStorageKey,
  versionMirrorsItem,
  versionWriteKey,
  writeVersionContent,
} from './version-content'
import { AI_PROVENANCE_PROPERTIES } from '@/lib/ai-provenance'

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

describe('versionedStorageKey', () => {
  it('leaves version 1 exactly where it is, so nothing that predates 0082 moves', () => {
    expect(versionedStorageKey('org/o/project/p/doc/d/plan.pdf', 1, 'a1b2c3d4e5f6')).toBe(
      'org/o/project/p/doc/d/plan.pdf',
    )
  })

  it('gives every later version a prefix of its own, and every WRITE a directory of its own', () => {
    expect(versionedStorageKey('org/o/project/p/Plaene/doc/d/plan.pdf', 3, 'a1b2c3d4e5f6')).toBe(
      'org/o/project/p/Plaene/doc/d/v3/a1b2c3d4e5f6/plan.pdf',
    )
  })

  it('never hands two overlapping re-uploads the same key, although both read the same number', () => {
    // Both uploads read `nextVersionNumber` = 3 before either recorded a row.
    // Without the write id they both PUT `…/v3/plan.pdf` and the second upload
    // silently replaced the first one's bytes while both rows described their
    // own.
    const base = 'org/o/project/p/doc/d/plan.pdf'
    const first = versionedStorageKey(base, 3, newVersionWriteId())
    const second = versionedStorageKey(base, 3, newVersionWriteId())
    expect(first).not.toBe(second)
    expect(first).toMatch(/\/doc\/d\/v3\/[0-9a-f]{12}\/plan\.pdf$/)
  })
})

describe('versionWriteKey', () => {
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

describe('admitVersionBytes', () => {
  it('charges the DELTA, because the version being replaced is already counted', async () => {
    await admitVersionBytes('org_1', version({ fileSize: 1_000 }), 1_600)
    expect(assertWithinStorageQuota).toHaveBeenCalledWith('org_1', 600)
  })

  it('asks nothing when the replacement is smaller', async () => {
    await admitVersionBytes('org_1', version({ fileSize: 1_000 }), 400)
    expect(assertWithinStorageQuota).not.toHaveBeenCalled()
  })

  it('lets a refusal through, so nothing is written or swapped', async () => {
    vi.mocked(assertWithinStorageQuota).mockRejectedValue(new Error('no room'))
    await expect(admitVersionBytes('org_1', version(), 10_000)).rejects.toThrow(/no room/)
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

  it('answers 404 for an ordinary chat, which is about nothing', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue({
      subjectResourceType: null,
      subjectResourceId: null,
    } as never)

    await expect(readVersionForService('ver_1', 'org_1', 'conv_1')).rejects.toMatchObject({
      status: 404,
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

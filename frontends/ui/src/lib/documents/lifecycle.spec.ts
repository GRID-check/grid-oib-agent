/**
 * @vitest-environment node
 */
/**
 * The document lifecycle (ADR-0054).
 *
 * Three things are being asserted, and they are different in kind:
 *
 *   - the TABLE is coherent — every row reachable, every effect registered,
 *     every audit action known, and the machine-reachable set derived rather
 *     than listed. These are properties of data and need no mocks;
 *   - the GUARDS a CHECK cannot see hold — a machine cannot approve, a
 *     submitter cannot approve their own version, a refusal carries words, a
 *     stale `If-Match` is a 409;
 *   - the EFFECTS run, and publish moves the pointer and supersedes.
 *
 * The compare-and-swap itself is the database's, and this suite asserts that
 * the service ASKS for it with the state it read — a repository double cannot
 * prove a race, and a spec that pretended to would be worse than none.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document, DocumentVersion } from '@/lib/db/schema'
import { makeDocument } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'
import { AUDIT_ACTIONS } from '@/lib/audit/schemas.mjs'

vi.mock('./access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('./version-repository', () => ({
  findDocumentVersion: vi.fn(),
  findOpenVersion: vi.fn(),
  findPreviousVersion: vi.fn().mockResolvedValue(null),
  findPublishedVersion: vi.fn(),
  insertDocumentVersion: vi.fn(),
  insertPublishedVersion: vi.fn(),
  listDocumentVersions: vi.fn(),
  nextVersionNumber: vi.fn().mockResolvedValue(2),
  compareAndSwapVersionState: vi.fn(),
  promoteVersionToPublished: vi.fn(),
  setDocumentLifecycle: vi.fn(),
  listDocumentVersionObjects: vi.fn().mockResolvedValue([]),
  listDocumentVersionSummaries: vi.fn().mockResolvedValue([]),
}))
vi.mock('./repository', () => ({
  findDocumentInOrg: vi.fn(),
  findFolderPathInProject: vi.fn().mockResolvedValue('Berichte'),
}))
/**
 * The dispatcher, doubled. `AgentAuthoredDocumentNotIndexableError` is a real
 * class here rather than a re-export of the production one: pulling the real
 * `./service` in would drag drizzle and every repository it imports into a
 * suite that doubles the repository, and the effect's `instanceof` reads the
 * SAME mocked class it is handed, so the branch under test is the real one.
 */
vi.mock('./service', () => ({
  dispatchDocument: vi.fn(),
  AgentAuthoredDocumentNotIndexableError: class AgentAuthoredDocumentNotIndexableError extends Error {},
}))
/**
 * The real `collectionFileRef` — it is pure, and it is half of what these
 * specs are about. Only the network call is doubled.
 */
vi.mock('./collection-file-ref', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./collection-file-ref')>()),
  purgeIngestedChunks: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))
vi.mock('@/lib/sharing/directory', () => ({ resolvePeople: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ publishToUsers: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(),
  resolveInboxItemsFor: vi.fn(),
}))
/**
 * The reviewer chain, doubled at ITS seam rather than at the directory and FGA
 * calls underneath it. `reviewers.spec.ts` owns the chain; what this suite is
 * about is that the transition ASKS it before the swap and carries the answer
 * into the effects.
 */
vi.mock('./reviewers', () => ({
  listReviewCandidates: vi.fn(),
  resolveReviewers: vi.fn(),
}))
/**
 * The revision effect's one outward call. Reached through a dynamic import in
 * `lifecycle.ts` (the cycle break), which `vi.mock` intercepts exactly as it
 * does a static one.
 */
vi.mock('@/lib/tasks/delegation', () => ({ delegateTask: vi.fn() }))
/**
 * The BYTE half of the lifecycle, doubled at its own seam.
 *
 * `version-content.spec.ts` owns what those functions do — the render, the
 * marking re-check, the quota admission, the mirror. What this suite is about
 * is the ORDER the transition puts them in, so the doubles record it and the
 * real object store, quota and S3 client stay out of a suite about states.
 */
vi.mock('./version-content', () => ({
  BACKEND_PURGE_TIMEOUT_MS: 10_000,
  admitVersionBytes: vi.fn(),
  readVersionContent: vi.fn().mockResolvedValue('# Aktenvermerk'),
  renderVersionBytes: vi.fn(),
  resolveVersionBucket: vi.fn().mockResolvedValue('grid-org-1'),
  storeVersionBytes: vi.fn(),
  versionStorageKey: (document: { storageKey: string }, versionNumber: number) =>
    versionNumber <= 1
      ? document.storageKey
      : document.storageKey.replace(/\/([^/]+)$/, `/v${versionNumber}/$1`),
}))
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: vi.fn() },
  bucketAdminS3Client: { send: vi.fn() },
}))

import { getAccessibleDocument } from './access'
import { purgeIngestedChunks } from './collection-file-ref'
import { dispatchDocument } from './service'
import { resolvePeople } from '@/lib/sharing/directory'
import { requireProjectAccess } from '@/lib/authz/projects'
import { recordAuditEvent } from '@/lib/audit/service'
import { publishToUsers } from '@/lib/events/bus'
import { emitInboxItems, resolveInboxItemsFor } from '@/lib/inbox/service'
import { listReviewCandidates, resolveReviewers } from './reviewers'
import { delegateTask } from '@/lib/tasks/delegation'
import {
  compareAndSwapVersionState,
  findDocumentVersion,
  findOpenVersion,
  findPreviousVersion,
  findPublishedVersion,
  insertDocumentVersion,
  insertPublishedVersion,
  listDocumentVersions,
  promoteVersionToPublished,
} from './version-repository'
import {
  admitVersionBytes,
  renderVersionBytes,
  storeVersionBytes,
} from './version-content'
import {
  createDocumentVersion,
  forkDraftVersion,
  replaceVersionContent,
  transitionDocumentVersion,
} from './lifecycle'
import {
  AGENT_REACHABLE_OPS,
  DOCUMENT_VERSION_EFFECTS,
  DOCUMENT_VERSION_OPS,
  DOCUMENT_VERSION_STATES,
  DOCUMENT_VERSION_TRANSITIONS,
  findDocumentVersionTransition,
  type DocumentVersionTransition,
} from './lifecycle-types'

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

function version(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: 'ver_1',
    organizationId: 'org_1',
    documentId: 'doc_1',
    projectId: 'proj_1',
    versionNumber: 2,
    state: 'in_review',
    storageKey: 'org/org_1/project/proj_1/doc/doc_1/v2/plan.md',
    storageBucket: 'grid-org-1',
    contentType: 'text/markdown',
    fileSize: 12,
    contentHash: 'sha256:abc',
    submittedBy: 'user_author',
    submittedAt: new Date('2026-09-01T00:00:00Z'),
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: 'user_author',
    originConversationId: null,
    submittedByActor: 'human',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  }
}

/**
 * A document Piloti wrote, under the namespace, with a published version.
 *
 * The three facts travel together on purpose: the filing path writes all three
 * at once (`fileGeneratedDocument` + the publish transition), and a fixture
 * that carried one without the others would describe a row the product cannot
 * produce.
 */
const agentDocument: Document = makeDocument({
  id: 'doc_1',
  projectId: 'proj_1',
  authoredBy: 'agent',
  authoredByProducer: 'agent_document',
  authoredByRef: 'conv_1-aktenvermerk',
  authoredByRefKind: 'answer_artifact',
  filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md',
  publishedVersionId: 'ver_1',
  folderId: 'folder_1',
  contentType: 'text/markdown',
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolvePeople).mockResolvedValue(
    new Map([
      ['user_approver', { userId: 'user_approver', email: null, name: 'Maria Huber', profilePictureUrl: null }],
    ]),
  )
  vi.mocked(getAccessibleDocument).mockResolvedValue(document)
  vi.mocked(listReviewCandidates).mockResolvedValue([
    { userId: 'user_other', name: 'Anna Berger', email: null },
  ])
  vi.mocked(resolveReviewers).mockImplementation(async (_session, _document, named) => ({
    reviewers: named && named.length > 0 ? [...named] : ['user_anna'],
    selfReview: false,
  }))
  vi.mocked(findPublishedVersion).mockResolvedValue(null)
  vi.mocked(findOpenVersion).mockResolvedValue(null)
  // `clearMocks` clears CALLS, not implementations, so a rejection set in one
  // test would leak into every later one.
  vi.mocked(admitVersionBytes).mockReset()
  vi.mocked(storeVersionBytes).mockReset()
  vi.mocked(renderVersionBytes).mockResolvedValue({
    bytes: Buffer.from('# Aktenvermerk', 'utf8'),
    contentType: 'text/markdown',
    contentHash: `sha256:${'a'.repeat(64)}`,
  })
})

describe('the transition table is coherent', () => {
  it('has at least one row per declared op', () => {
    for (const op of DOCUMENT_VERSION_OPS) {
      expect(
        DOCUMENT_VERSION_TRANSITIONS.some((row) => row.op === op),
        `op ${op} has no transition row`,
      ).toBe(true)
    }
  })

  it('names only declared states and declared effects', () => {
    for (const row of DOCUMENT_VERSION_TRANSITIONS) {
      if (row.from !== null) expect(DOCUMENT_VERSION_STATES).toContain(row.from)
      expect(DOCUMENT_VERSION_STATES).toContain(row.to)
      for (const effect of row.effects) expect(DOCUMENT_VERSION_EFFECTS).toContain(effect)
    }
  })

  it('names only audit actions the registry knows', () => {
    // An unregistered action is rejected by WorkOS exactly as a missing schema
    // is, and the version row would then say "approved" with no trail.
    for (const row of DOCUMENT_VERSION_TRANSITIONS) {
      expect(AUDIT_ACTIONS, `${row.op} emits an unregistered action`).toContain(row.auditAction)
    }
  })

  it('never lets a (from, op) pair mean two things', () => {
    const keys = DOCUMENT_VERSION_TRANSITIONS.map((row) => `${row.from}:${row.op}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('derives the machine-reachable ops from `actor`, and they are exactly three', () => {
    // The publish door, as data. If this list ever grows, it grew because
    // somebody changed an `actor`, which is the change a reviewer must see.
    expect([...AGENT_REACHABLE_OPS].sort()).toEqual(['create', 'submit', 'update'])
  })

  it('makes every decision that asserts content a person’s', () => {
    for (const op of ['approve', 'request_changes', 'reject', 'publish', 'upload'] as const) {
      for (const row of DOCUMENT_VERSION_TRANSITIONS.filter((entry) => entry.op === op)) {
        expect(row.actor, `${op} must be a human decision`).toBe('human')
      }
    }
  })

  it('marks the two submit rows as opening a round that has to reach somebody', () => {
    for (const row of DOCUMENT_VERSION_TRANSITIONS.filter((entry) => entry.op === 'submit')) {
      expect(row.requires.reviewer, `${row.from}:submit must resolve reviewers`).toBe(true)
    }
    // And nothing else does: resolving reviewers costs a directory read and an
    // FGA check per member, and a row that does not open a round must not pay
    // for one. Read through the interface, not through the literal type —
    // `satisfies` keeps the members literal, and an optional field is absent on
    // the rows that do not carry it.
    const rows: readonly DocumentVersionTransition[] = DOCUMENT_VERSION_TRANSITIONS
    const carrying = rows.filter((row) => row.requires.reviewer)
    expect(new Set(carrying.map((row) => row.op))).toEqual(new Set(['submit']))
  })

  it('requires a comment on both refusals and on neither approval', () => {
    expect(findDocumentVersionTransition('in_review', 'request_changes')?.requires.comment).toBe(true)
    expect(findDocumentVersionTransition('in_review', 'reject')?.requires.comment).toBe(true)
    expect(findDocumentVersionTransition('in_review', 'approve')?.requires.comment).toBeUndefined()
  })

  it('makes „darf freigeben“ project:edit and nothing else', () => {
    // The permission list is an ANY-OF, so every member of it is a WIDENING.
    // `project:documents:write` sat beside `project:edit` on the three review
    // decisions, which handed the office's assertion about a
    // Brandschutzkonzept to any role that may upload a file.
    for (const op of ['approve', 'request_changes', 'reject'] as const) {
      for (const row of DOCUMENT_VERSION_TRANSITIONS.filter((entry) => entry.op === op)) {
        expect([...row.permission], `${op} is reachable with more than project:edit`).toEqual([
          'project:edit',
        ])
      }
    }
  })

  it('asks for `project:documents:generate` exactly where a machine may write', () => {
    // Read through the interface, not through the literal type: `satisfies`
    // keeps the members literal, and an optional field is absent on the rows
    // that do not carry it.
    const rows: readonly DocumentVersionTransition[] = DOCUMENT_VERSION_TRANSITIONS
    for (const row of rows) {
      const machineWrite = row.actor === 'either' && (row.op === 'create' || row.op === 'update')
      expect(Boolean(row.alsoRequires), `${row.from}:${row.op}`).toBe(machineWrite)
    }
  })
})

describe('transitionDocumentVersion — guards', () => {
  it('refuses an op the version’s state has no row for, as a conflict', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'published' }))
    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve'),
    ).rejects.toMatchObject({ status: 409 })
    expect(compareAndSwapVersionState).not.toHaveBeenCalled()
  })

  it('refuses a human-only op for a machine caller, before any permission is read', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve', { actingHuman: false }),
    ).rejects.toMatchObject({ status: 403 })
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('refuses the submitter approving their own version', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(
      version({ submittedBy: session.userId, submittedByActor: 'human' }),
    )
    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve'),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('lets the commissioner approve a version a RUN submitted in their session', async () => {
    // `submitted_by` on an agent filing is the commissioning human, not the
    // author (migration 0085). Reading it as "they asserted this themselves"
    // refused the one person who had asked for the report the right to release
    // it.
    vi.mocked(findDocumentVersion).mockResolvedValue(
      version({ submittedBy: session.userId, submittedByActor: 'agent' }),
    )
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'approved' }))

    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve'),
    ).resolves.toMatchObject({ state: 'approved' })
  })

  it('waives the guard for a sole editor, and says so on the trail', async () => {
    // A one-person project has nobody else. „Freigabe" by the only person who
    // could ever give it is still a decision; it is simply not a second pair of
    // eyes, and that is what the audit event now records.
    vi.mocked(listReviewCandidates).mockResolvedValue([])
    vi.mocked(findDocumentVersion).mockResolvedValue(
      version({ submittedBy: session.userId, submittedByActor: 'human' }),
    )
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'approved' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve')

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ selfReview: true }) }),
    )
  })

  it('refuses a refusal with no words', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'reject', { comment: '   ' }),
    ).rejects.toMatchObject({ status: 422 })
  })

  it.each([[undefined], [null], ['']])(
    'treats a version with NO stored digest as having no If-Match to satisfy (%s)',
    async (ifMatch) => {
      // `content_hash` is nullable — a row backfilled by 0082 from a document
      // that predates 0078 carries null — and NO STRING equals null. The guard
      // was therefore unsatisfiable from one side and unreachable from the
      // other: the task outcome path sent `contentHash ?? ''` and got a 409 on
      // every revision of such a document, while `undefined` slipped past by
      // accident because `undefined ?? null` happens to be null. "Nothing to
      // match" is now the row's answer rather than a coincidence of coalescing.
      vi.mocked(findDocumentVersion).mockResolvedValue(
        version({ state: 'draft', contentHash: null }),
      )
      vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'draft' }))

      await expect(
        replaceVersionContent(session, 'doc_1', 'ver_1', 'neu', ifMatch),
      ).resolves.toMatchObject({ state: 'draft' })
    },
  )

  it('still refuses a stale digest when the row HAS one', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(
      version({ state: 'draft', contentHash: 'sha256:abc' }),
    )
    await expect(
      replaceVersionContent(session, 'doc_1', 'ver_1', 'neu', 'sha256:stale'),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('reports a lost compare-and-swap as a conflict rather than a lost update', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(null)
    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'reject', { comment: 'GK stimmt nicht' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('swaps on the state it read, which is what makes the race decidable', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'approved' }))
    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve')
    expect(compareAndSwapVersionState).toHaveBeenCalledWith(
      'ver_1',
      'org_1',
      'in_review',
      expect.objectContaining({ state: 'approved', approvedBy: session.userId }),
    )
  })
})

describe('transitionDocumentVersion — effects', () => {
  it('submit opens an actionable item for each named reviewer, anchored on the version', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a', 'user_b'],
    })

    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions.map((item) => item.recipientUserId)).toEqual(['user_a', 'user_b'])
    expect(emissions[0]).toMatchObject({
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ver_1',
    })
  })

  it('names the document in the inbox payload, so the row is not about "a file"', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a'],
    })

    // The generic inbox renderer interpolates `payload.subject` into „{actor}
    // bittet Sie um die Freigabe von {subject}". Without it the row named
    // nothing and the reader had to open the link to learn which file was
    // waiting — the one thing an inbox exists to save them.
    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions[0].payload).toMatchObject({
      versionId: 'ver_1',
      versionNumber: 2,
      subject: 'plan.pdf',
    })
  })

  it('falls back to the reviewer chain when no reviewer is named', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {})

    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].recipientUserId).toBe('user_anna')
  })

  it('resolves the round BEFORE the swap, not inside the effect', async () => {
    // The version was left durably `in_review` with nobody told about it when
    // the resolution ran after the state had moved — and every exit from that
    // state is a decision one of the people who were never told would have to
    // make.
    const order: string[] = []
    vi.mocked(resolveReviewers).mockImplementation(async () => {
      order.push('resolve')
      return { reviewers: ['user_anna'], selfReview: false }
    })
    vi.mocked(compareAndSwapVersionState).mockImplementation(async () => {
      order.push('swap')
      return version({ state: 'in_review' })
    })
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {})

    expect(order[0]).toBe('resolve')
    expect(order).toContain('swap')
  })

  it('submits an Unvergeben draft rather than refusing it', async () => {
    // A Piloti draft is unassigned by construction (ADR-0047), and the draft
    // card, the panel and `submit_draft` all submit without naming anybody.
    // Refusing that made the lifecycle unreachable for the documents it exists
    // for.
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await expect(
      transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {}),
    ).resolves.toMatchObject({ state: 'in_review' })
  })

  it('records the sole-editor waiver on the audit event', async () => {
    vi.mocked(resolveReviewers).mockResolvedValue({
      reviewers: [session.userId],
      selfReview: true,
    })
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {})

    // „freigegeben" and „freigegeben, weil es niemanden sonst gibt" are
    // different facts about the same signature.
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ selfReview: true }) }),
    )
  })

  it('stamps whose HAND submitted, from the same flag the publish door reads', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'in_review' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a'],
      actingHuman: false,
    })

    expect(compareAndSwapVersionState).toHaveBeenCalledWith(
      'ver_1',
      'org_1',
      'draft',
      expect.objectContaining({ submittedBy: session.userId, submittedByActor: 'agent' }),
    )
  })

  it('carries the order and Frist into the inbox payload and the audit event', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 2 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 2 }),
    )
    vi.mocked(findPreviousVersion).mockResolvedValue(null)

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a'],
      orderMessage: 'Bitte die Fluchtweglänge prüfen.',
      dueAt: '2026-09-20',
    })

    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions[0].payload).toMatchObject({
      versionId: 'ver_1',
      orderMessage: 'Bitte die Fluchtweglänge prüfen.',
      previousVersionId: null,
    })
    expect(emissions[0].payload).toHaveProperty('dueAt')
    expect(typeof (emissions[0].payload as { dueAt: unknown }).dueAt).toBe('string')
    expect((emissions[0].payload as { excerpt: unknown }).excerpt).toContain(
      'Bitte die Fluchtweglänge prüfen.',
    )
    expect((emissions[0].payload as { excerpt: unknown }).excerpt).toContain('2026-09-20')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          orderMessage: 'Bitte die Fluchtweglänge prüfen.',
        }),
      }),
    )
  })

  it('leaves the order absent when the caller states none', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 1 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 1 }),
    )
    vi.mocked(findPreviousVersion).mockResolvedValue(null)

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a'],
    })

    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions[0].payload).toMatchObject({
      orderMessage: null,
      dueAt: null,
      excerpt: null,
      previousVersionId: null,
    })
  })

  it('names the previous version for a real diff link', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 3 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 3 }),
    )
    vi.mocked(findPreviousVersion).mockResolvedValue(
      version({ id: 'ver_2', versionNumber: 2 }),
    )

    await transitionDocumentVersion(session, 'doc_1', 'ver_3', 'submit', {
      reviewerUserIds: ['user_a'],
    })

    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions[0].payload).toMatchObject({ previousVersionId: 'ver_2' })
    // Direct predecessor query — never the bounded list scanned in memory.
    expect(findPreviousVersion).toHaveBeenCalledWith('doc_1', 'org_1', 3)
    expect(listDocumentVersions).not.toHaveBeenCalled()
  })

  it('asks the direct predecessor query even past 200 versions', async () => {
    // The old asc-limited-200 scan no longer contained the predecessor at
    // all past 200 versions and named the wrong row. The repository now
    // answers `version_number < $n ORDER BY version_number DESC LIMIT 1`.
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 201 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 201 }),
    )
    vi.mocked(findPreviousVersion).mockResolvedValue(
      version({ id: 'ver_200', versionNumber: 200 }),
    )

    await transitionDocumentVersion(session, 'doc_1', 'ver_201', 'submit', {
      reviewerUserIds: ['user_a'],
    })

    expect(findPreviousVersion).toHaveBeenCalledWith('doc_1', 'org_1', 201)
    const emissions = vi.mocked(emitInboxItems).mock.calls[0][0]
    expect(emissions[0].payload).toMatchObject({ previousVersionId: 'ver_200' })
  })

  it('falls back to no previous version for a first version and on a query failure', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 1 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 1 }),
    )
    vi.mocked(findPreviousVersion).mockResolvedValue(null)

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'submit', {
      reviewerUserIds: ['user_a'],
    })
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].payload).toMatchObject({
      previousVersionId: null,
    })

    vi.clearAllMocks()
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft', versionNumber: 2 }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(
      version({ state: 'in_review', versionNumber: 2 }),
    )
    vi.mocked(findPreviousVersion).mockRejectedValue(new Error('database went away'))

    await transitionDocumentVersion(session, 'doc_1', 'ver_2', 'submit', {
      reviewerUserIds: ['user_a'],
    })
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0].payload).toMatchObject({
      previousVersionId: null,
    })
  })

  it('resolves the round for every reviewer, not only the one who decided', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'approved' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'approve', {
      reviewerUserIds: ['user_a', 'user_b'],
    })

    const targets = vi.mocked(resolveInboxItemsFor).mock.calls[0][0]
    expect(targets.map((target) => target.recipientUserId).sort()).toEqual([
      'user_a',
      'user_b',
      session.userId,
    ])
    expect(new Set(targets.map((target) => target.groupKey)).size).toBe(1)
  })

  it('audits with the row’s own action and publishes a hint', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version())
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'changes_requested' }))

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'request_changes', {
      comment: 'Der Atrium-Fall ist OIB 2.3',
    })

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'document.version.changes_requested',
        targetType: 'document',
        targetId: 'doc_1',
        metadata: expect.objectContaining({ versionId: 'ver_1', withComment: true }),
      }),
    )
    expect(publishToUsers).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ kind: 'document.version.changed', versionId: 'ver_1' }),
    )
  })

  it('publish moves the pointer and supersedes, in the one transaction that can', async () => {
    const published = version({ state: 'published' })
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'approved' }))
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: published,
      superseded: [version({ id: 'ver_0', state: 'superseded' })],
    })

    const result = await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    expect(result.state).toBe('published')
    expect(promoteVersionToPublished).toHaveBeenCalledWith(
      'ver_1',
      'doc_1',
      'org_1',
      'approved',
      expect.objectContaining({ state: 'published', publishedBy: session.userId }),
    )
    // The plain swap is NOT used for a promoting row: two published versions of
    // one document is a state the partial unique index refuses to hold.
    expect(compareAndSwapVersionState).not.toHaveBeenCalled()
  })

  it('dispatches nothing on publish for a document a PERSON wrote', async () => {
    const published = version({ state: 'published' })
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'approved' }))
    vi.mocked(promoteVersionToPublished).mockResolvedValue({ version: published, superseded: [] })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    // A human upload's bytes are dispatched by whatever stored them, on all
    // three shelves. Dispatching again from here would double-ingest every
    // re-upload — one job for the object and one for the version row.
    expect(dispatchDocument).not.toHaveBeenCalled()
  })
})

/**
 * The publish door, from the index's side (ADR-0054 § Indexing).
 *
 * The dispatcher's own guard is asserted in `dispatch.spec.ts`, version state by
 * version state. What is asserted here is the OTHER half: that the effect the
 * `publish` row names is the only thing in this module that reaches the
 * dispatcher, that it carries the four provenance keys, and that the version
 * being replaced loses its passages BEFORE the new ones are written.
 */
describe('ingestPublished — what publishing a Piloti document does to the index', () => {
  const approved = () =>
    version({ state: 'approved', approvedBy: 'user_approver', approvedAt: new Date('2026-09-01T10:00:00Z') })
  const publishedVersion = () =>
    version({
      state: 'published',
      approvedBy: 'user_approver',
      approvedAt: new Date('2026-09-01T10:00:00Z'),
      storageKey: 'org/org_1/project/proj_1/Berichte/doc/doc_1/v2/aktenvermerk-2026-09-01.md',
    })

  beforeEach(() => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(agentDocument)
    vi.mocked(findDocumentVersion).mockResolvedValue(approved())
  })

  it('dispatches the published version with the four provenance keys', async () => {
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    expect(dispatchDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'doc_1',
        // The item's name, which is the chunk join key — never the version's
        // storage key basename.
        filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md',
        // THIS version's bytes, not the item's mirrored columns.
        storageKey: 'org/org_1/project/proj_1/Berichte/doc/doc_1/v2/aktenvermerk-2026-09-01.md',
        // The half of the door the row cannot answer.
        versionId: 'ver_1',
        collectionName: 'proj_abc',
        folderPath: 'Berichte',
        provenance: {
          authored_by: 'agent',
          // The DISPLAY NAME, resolved the way every collaboration surface in
          // this tier resolves one — never the raw WorkOS id.
          approved_by: 'Maria Huber',
          approved_at: '2026-09-01T10:00:00.000Z',
          producer: 'agent_document',
        },
      }),
    )
  })

  it('leaves the doc_class alone: provenance is its own axis', async () => {
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    // `doc_class` is a closed norm-hierarchy vocabulary whose fail-open lane is
    // "Basisdokument". Inventing a value here would file authorship under the
    // hierarchy of authority; the retrieval side maps the provenance keys to
    // the `buero_piloti` lane instead.
    const [call] = vi.mocked(dispatchDocument).mock.calls
    expect(call[0]).not.toHaveProperty('docClass')
    expect(Object.keys(call[0].provenance ?? {})).toEqual([
      'authored_by',
      'approved_by',
      'approved_at',
      'producer',
    ])
  })

  it('purges the superseded version’s passages BEFORE the new bytes are sent', async () => {
    const order: string[] = []
    vi.mocked(purgeIngestedChunks).mockImplementation(async () => {
      order.push('purge')
      return true
    })
    vi.mocked(dispatchDocument).mockImplementation(async () => {
      order.push('dispatch')
      return { jobId: 'job-1', status: 'pending' as const }
    })
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [version({ id: 'ver_0', state: 'superseded' })],
    })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    // A version has no filename; the ITEM does. Both versions therefore address
    // the same chunks, and purging after the dispatch would delete the passages
    // that had just been written.
    expect(order).toEqual(['purge', 'dispatch'])
    expect(purgeIngestedChunks).toHaveBeenCalledWith(
      'http://backend:8000',
      expect.objectContaining({ filename: 'piloti/doc_1/aktenvermerk-2026-09-01.md' }),
      expect.any(Number),
    )
  })

  it('purges nothing on a FIRST publish, because there is nothing to replace', async () => {
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    expect(purgeIngestedChunks).not.toHaveBeenCalled()
    expect(dispatchDocument).toHaveBeenCalled()
  })

  it('refuses to index a row outside the piloti/ namespace, and still publishes it', async () => {
    // Reachable for a document filed before the namespace existed. Indexing it
    // would write chunks under `slug(model's title)-YYYY-MM-DD.ext` — a name
    // `collectionFileRef` answers `null` for, so nothing could ever purge them,
    // and a name a human upload can carry.
    vi.mocked(getAccessibleDocument).mockResolvedValue(
      makeDocument({ ...agentDocument, filename: 'aktenvermerk-2026-09-01.md' }),
    )
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [version({ id: 'ver_0', state: 'superseded' })],
    })

    const result = await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    expect(dispatchDocument).not.toHaveBeenCalled()
    expect(purgeIngestedChunks).not.toHaveBeenCalled()
    // The editorial act is what the person performed, and it is durable
    // whatever the index did with the bytes.
    expect(result.state).toBe('published')
  })

  it('degrades to no approver name rather than printing a WorkOS id', async () => {
    // A deactivated member, or a directory hiccup. The German label is built
    // from these fields and „freigegeben von user_01H…" is worse than a bare
    // „Piloti-Dokument".
    vi.mocked(resolvePeople).mockResolvedValue(new Map())
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')

    expect(vi.mocked(dispatchDocument).mock.calls[0][0].provenance).toMatchObject({
      approved_by: null,
      approved_at: '2026-09-01T10:00:00.000Z',
    })
  })

  it('does not fail the publish when the dispatcher refuses the document', async () => {
    const { AgentAuthoredDocumentNotIndexableError } = await import('./service')
    vi.mocked(dispatchDocument).mockRejectedValue(new AgentAuthoredDocumentNotIndexableError('doc_1'))
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await expect(transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')).resolves.toMatchObject({
      state: 'published',
    })
  })

  it('re-raises anything that is NOT that refusal', async () => {
    // A real fault — the object store, a bug — is not swallowed. „Never
    // swallow": catch the exception you can handle, re-raise the rest.
    vi.mocked(dispatchDocument).mockRejectedValue(new Error('object store unreachable'))
    vi.mocked(promoteVersionToPublished).mockResolvedValue({
      version: publishedVersion(),
      superseded: [],
    })

    await expect(transitionDocumentVersion(session, 'doc_1', 'ver_1', 'publish')).rejects.toThrow(
      /object store unreachable/,
    )
  })
})

describe('createDocumentVersion — a human upload', () => {
  const upload = () =>
    createDocumentVersion(session, {
      document,
      op: 'upload',
      storageKey: 'k',
      storageBucket: 'b',
      contentType: 'application/pdf',
      fileSize: 10,
      contentHash: 'sha256:x',
    })

  it('is born published AND born approved, so the CHECK is satisfied honestly', async () => {
    vi.mocked(insertPublishedVersion).mockImplementation(async (values) => ({
      version: version({ ...(values as Partial<DocumentVersion>), id: 'ver_new' }),
      superseded: [],
    }))

    await upload()

    expect(insertPublishedVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'published',
        approvedBy: session.userId,
        publishedBy: session.userId,
      }),
    )
  })

  it('inserts the published row INSIDE the supersede transaction, never beside it', async () => {
    // `uniq_document_versions_published_per_document` is a plain partial unique
    // index — checked per statement, not deferred — so an insert of version N+1
    // as `published` is refused while version N still is. Every re-upload went
    // through that path.
    vi.mocked(insertPublishedVersion).mockResolvedValue({
      version: version({ id: 'ver_new', state: 'published' }),
      superseded: [version({ id: 'ver_0', state: 'superseded' })],
    })

    await upload()

    expect(insertDocumentVersion).not.toHaveBeenCalled()
    expect(promoteVersionToPublished).not.toHaveBeenCalled()
  })

  it('refuses an upload claimed by a machine caller', async () => {
    await expect(
      createDocumentVersion(session, {
        document,
        op: 'upload',
        storageKey: 'k',
        storageBucket: null,
        contentType: null,
        fileSize: null,
        contentHash: null,
        actingHuman: false,
      }),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('forkDraftVersion', () => {
  it('refuses a second open version and names the one that exists', async () => {
    vi.mocked(findOpenVersion).mockResolvedValue(version({ id: 'ver_open', state: 'draft' }))
    await expect(forkDraftVersion(session, 'doc_1')).rejects.toMatchObject({
      status: 409,
      details: { versionId: 'ver_open', state: 'draft' },
    })
  })

  it('shares the published version’s key until the content is replaced', async () => {
    // A copy would charge the quota twice for a file nobody has changed yet.
    vi.mocked(findPublishedVersion).mockResolvedValue(version({ state: 'published' }))
    vi.mocked(insertDocumentVersion).mockImplementation(async (values) =>
      version({ ...(values as Partial<DocumentVersion>), id: 'ver_fork' }),
    )

    await forkDraftVersion(session, 'doc_1')

    expect(insertDocumentVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'draft',
        storageKey: 'org/org_1/project/proj_1/doc/doc_1/v2/plan.md',
      }),
    )
  })
})

describe('replaceVersionContent', () => {
  it('refuses a stale If-Match with a conflict, and stores nothing', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    await expect(
      replaceVersionContent(session, 'doc_1', 'ver_1', 'neu', 'sha256:stale'),
    ).rejects.toMatchObject({ status: 409 })
    const s3 = await import('@/lib/s3')
    expect(vi.mocked(s3.s3Client.send)).not.toHaveBeenCalled()
  })

  it('writes the draft’s own key and records the new digest', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'draft' }))

    await replaceVersionContent(session, 'doc_1', 'ver_1', '# Aktenvermerk', 'sha256:abc')

    expect(compareAndSwapVersionState).toHaveBeenCalledWith(
      'ver_1',
      'org_1',
      'draft',
      expect.objectContaining({
        state: 'draft',
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    )
  })

  it('renders through the producer, admits the bytes, swaps, and only THEN writes', async () => {
    // Four steps and the order is the whole of it: writing before the swap
    // meant a caller that LOST the race had already overwritten the winner's
    // object, because both were aiming at the same key.
    const order: string[] = []
    vi.mocked(renderVersionBytes).mockImplementation(async () => {
      order.push('render')
      return {
        bytes: Buffer.from('# gerendert', 'utf8'),
        contentType: 'text/markdown',
        contentHash: 'sha256:neu',
      }
    })
    vi.mocked(admitVersionBytes).mockImplementation(async () => {
      order.push('admit')
    })
    vi.mocked(compareAndSwapVersionState).mockImplementation(async () => {
      order.push('swap')
      return version({ state: 'draft' })
    })
    vi.mocked(storeVersionBytes).mockImplementation(async () => {
      order.push('store')
    })
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))

    await replaceVersionContent(session, 'doc_1', 'ver_1', '# Aktenvermerk', 'sha256:abc')

    expect(order).toEqual(['render', 'admit', 'swap', 'store'])
    // The RENDERED bytes are what the row records, never the caller's body.
    expect(compareAndSwapVersionState).toHaveBeenCalledWith(
      'ver_1',
      'org_1',
      'draft',
      expect.objectContaining({ contentHash: 'sha256:neu', fileSize: 11 }),
    )
  })

  it('writes nothing and swaps nothing when the quota refuses the delta', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(admitVersionBytes).mockRejectedValue(new Error('no room'))

    await expect(
      replaceVersionContent(session, 'doc_1', 'ver_1', 'sehr lang', 'sha256:abc'),
    ).rejects.toThrow(/no room/)
    expect(compareAndSwapVersionState).not.toHaveBeenCalled()
    expect(storeVersionBytes).not.toHaveBeenCalled()
  })

  it('carries the machine flag into the guards, so the door is one field', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(version({ state: 'draft' }))
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'draft' }))

    await replaceVersionContent(session, 'doc_1', 'ver_1', 'neu', 'sha256:abc', {
      actingHuman: false,
    })

    // `update` is an `either` row, so nothing is refused today — which is
    // exactly why the flag has to arrive: the door is the `actor` field, and a
    // caller that lies about who it is bypasses it the moment a row changes.
    expect(compareAndSwapVersionState).toHaveBeenCalled()
  })

  it('clears the reviewer’s words, because they were about the bytes just replaced', async () => {
    vi.mocked(findDocumentVersion).mockResolvedValue(
      version({ state: 'changes_requested', reviewComment: 'GK stimmt nicht' }),
    )
    vi.mocked(compareAndSwapVersionState).mockResolvedValue(version({ state: 'draft' }))

    await replaceVersionContent(session, 'doc_1', 'ver_1', 'korrigiert', 'sha256:abc')

    expect(compareAndSwapVersionState).toHaveBeenCalledWith(
      'ver_1',
      'org_1',
      'changes_requested',
      expect.objectContaining({ state: 'draft', reviewComment: null }),
    )
  })
})

// ---------------------------------------------------------------------------
// „Änderungen anfordern" reaches the agent — twice, and never both ways at once
// ---------------------------------------------------------------------------

/**
 * The `openRevisionTask` effect (ADR-0051, slice 6).
 *
 * The rule under test is a CONDITION, not a button: a version filed from a live
 * conversation reaches that conversation as a `REVIEW_DECISIONS v1` block and
 * opens no task, because the person is already there and the next sentence is
 * about to ask for the change. A version with nobody typing — a scheduled
 * report, an earlier revision's own output — needs the row or the comment
 * reaches nothing at all.
 */
describe('request_changes and the revision task', () => {
  const refuse = async (version: DocumentVersion, input: Record<string, unknown> = {}) => {
    vi.mocked(getAccessibleDocument).mockResolvedValue(document)
    vi.mocked(findDocumentVersion).mockResolvedValue(version)
    vi.mocked(compareAndSwapVersionState).mockResolvedValue({
      ...version,
      state: 'changes_requested',
      reviewComment: (input.comment as string) ?? 'Die Fluchtweglänge stimmt nicht',
    })
    return transitionDocumentVersion(session, 'doc_1', 'ver_1', 'request_changes', {
      comment: 'Die Fluchtweglänge stimmt nicht',
      ...input,
    })
  }

  beforeEach(() => {
    vi.mocked(delegateTask).mockResolvedValue({ id: 'task-1' } as never)
  })

  it('opens no task when the version came out of a live conversation', async () => {
    await refuse(version({ originConversationId: 'conv-1', createdBy: 'user_author' }))
    // The next turn of THAT conversation reads the comment instead; a task here
    // would queue a run for work somebody is about to ask for in one sentence.
    expect(delegateTask).not.toHaveBeenCalled()
  })

  it('opens a revision task when the version had no conversation behind it', async () => {
    await refuse(version({ originConversationId: null, createdBy: 'user_author' }))

    expect(delegateTask).toHaveBeenCalledTimes(1)
    expect(vi.mocked(delegateTask).mock.calls[0][1]).toMatchObject({
      projectId: 'proj_1',
      kind: 'revision',
      goal: 'Die Fluchtweglänge stimmt nicht',
      subject: {
        documentId: 'doc_1',
        versionId: 'ver_1',
        comment: 'Die Fluchtweglänge stimmt nicht',
      },
      // The re-filing carries the permissions the original filing carried.
      requester: { userId: 'user_author', email: null },
    })
  })

  it('opens one for a conversation-born version when the reviewer asked outright', async () => {
    // „Piloti überarbeiten lassen": the reviewer has said they do not want to
    // wait for somebody to type the next message.
    await refuse(version({ originConversationId: 'conv-1', createdBy: 'user_author' }), {
      delegateRevision: true,
    })
    expect(delegateTask).toHaveBeenCalledTimes(1)
  })

  it('still records the decision when the task cannot be opened', async () => {
    // A queue that will not take the run is not a reason to tell a
    // Ziviltechniker that their „Änderungen anfordern" did not go through.
    vi.mocked(delegateTask).mockRejectedValue(new Error('queue is down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const refused = await refuse(version({ originConversationId: null }))
    expect(refused.state).toBe('changes_requested')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.version.changes_requested' }),
    )
  })

  it('is the only transition that carries the effect', () => {
    // A property of the TABLE, so a future op cannot pick it up by accident.
    const carrying = DOCUMENT_VERSION_TRANSITIONS.filter((row) =>
      (row.effects as readonly string[]).includes('openRevisionTask'),
    )
    expect(carrying.map((row) => row.op)).toEqual(['request_changes'])
  })
})

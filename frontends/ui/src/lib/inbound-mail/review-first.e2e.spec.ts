/**
 * @vitest-environment node
 *
 * The dynamic ratchet of review-first (DECISION §10, ratchet 3, its no-follow
 * half), against a REAL Postgres with migration 0186 through the restricted
 * runtime role (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbound-mail/review-first.e2e.spec.ts
 *
 * The owner's sentence is „nothing is filed without a person's decision“. The
 * static ratchet (`review-first.spec.ts`) proves the receive side imports no
 * filing code; this one runs it. A perfect mail (a member's, DKIM-signed for
 * real, addressed to the project, with an attachment the office accepts) goes
 * through the real receive job and the real repository, and then the real
 * filing job:
 *
 * 1. Received, it waits: zero `documents` rows in the project, no object
 *    written outside its own `_inbound-mail/<mail>/`, no filing job queued.
 * 2. The filing job, run before anyone decided, files nothing.
 * 3. Once the person decides to file the attachment (and so dismisses the
 *    text), exactly that file becomes a document, uploaded as THAT person,
 *    and its staged bytes are erased; the text becomes nothing.
 *
 * Mocked are only what is outside this tier or the database: the object store
 * (in memory, every write recorded), the scanner, the Python reader, DNS (the
 * signature is real), the member directory, and the upload path's own
 * machinery past the decision (`uploadDocument`, which here records its call
 * and writes the row an upload would, as the session's tenant).
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const store = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  writes: [] as string[],
  erased: [] as string[],
  dns: null as unknown,
}))

vi.mock('./staging', () => ({
  RAW_MESSAGE_CONTENT_TYPE: 'message/rfc822',
  readStagedObject: vi.fn(async (_bucket: string, key: string) => {
    const bytes = store.objects.get(key)
    if (!bytes) throw new Error(`no object ${key}`)
    return bytes
  }),
  putStagedObject: vi.fn(async (_bucket: string, key: string, body: Uint8Array) => {
    store.writes.push(key)
    store.objects.set(key, body)
  }),
  eraseStagedObjects: vi.fn(async (_bucket: string, keys: readonly string[]) => {
    for (const key of keys) {
      store.erased.push(key)
      store.objects.delete(key)
    }
    return []
  }),
  stagedObjectUrlForBackend: vi.fn(
    async (_bucket: string, key: string) => `http://store.test/${key}`
  ),
}))
vi.mock('@/lib/malware-scan/client', () => ({
  scanForMalware: vi.fn(async () => ({
    status: 'clean',
    engine: {
      version: 'ClamAV 1.5.4',
      signatures: 28157,
      signaturesPublishedAt: new Date('2026-09-28'),
    },
  })),
}))
vi.mock('./read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./read-client')>()),
  readMail: vi.fn(),
}))
vi.mock('./sender-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sender-auth')>()
  return {
    ...actual,
    authenticateSender: vi.fn(
      (raw: Uint8Array, options: Parameters<typeof actual.authenticateSender>[1]) =>
        actual.authenticateSender(raw, {
          ...options,
          resolver: (store.dns as { resolver: never }).resolver,
        })
    ),
  }
})
vi.mock('@/lib/documents/accepted-types', () => ({
  acceptedTypesForOrganization: vi.fn(async () => ['.pdf', '.docx', '.txt', '.md']),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/upload-screening/service', async (importOriginal) => {
  const { SUGGESTED_SCREENING_POLICY } = await import('@/lib/upload-screening/policy')
  return {
    ...(await importOriginal<typeof import('@/lib/upload-screening/service')>()),
    gatePolicy: vi.fn(async () => SUGGESTED_SCREENING_POLICY),
  }
})
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: vi.fn(async () => null),
}))
vi.mock('./announce', () => ({ announceWaiting: vi.fn(async () => true) }))
vi.mock('./quiet-batch', () => ({
  openQuietBatch: vi.fn(async () => crypto.randomUUID()),
  sealQuietBatch: vi.fn(async () => undefined),
}))
vi.mock('@/lib/inbox/service', () => ({
  resolveInboxItemsAnchoredOn: vi.fn(async () => undefined),
}))
vi.mock('@/lib/documents/service', () => ({ uploadDocument: vi.fn() }))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_review_first_${STAMP}`
const MEMBER_ID = 'user_01J0REVIEWFIRST0000000000A'
const MEMBER_EMAIL = 'anna@buero-muster.at'
const TOKEN = (STAMP + 'rvfst')
  .replace(/[^a-z2-7]/g, 'a')
  .padEnd(12, 'q')
  .slice(-12)

describe.skipIf(!url)('review first: nothing is filed without a person’s decision', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let projectId: string
  let mailId: string
  const session = {
    userId: MEMBER_ID,
    email: MEMBER_EMAIL,
    organizationId: ORG,
    organizationMembershipId: 'om_review_first',
    role: 'member',
    permissions: ['project:documents:write'],
  } as unknown as import('@/lib/auth/types').AuthorizedSession

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: MEMBER_ID }, run)
  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return Array.from(await inTenant(() => db.execute(statement))) as T[]
  }
  const documentCount = async () =>
    Number(
      (
        await rows<{ count: string }>(
          sql`SELECT count(*) FROM documents WHERE project_id = ${projectId}::uuid`
        )
      )[0]!.count
    )
  const jobKinds = async () =>
    (
      Array.from(
        await withPlatformAccess('spec', () =>
          db.execute(sql`SELECT kind FROM bff_job_queue WHERE lane = ${ORG} ORDER BY kind`)
        )
      ) as Array<{ kind: string }>
    ).map((row) => row.kind)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti.at')
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    const hostile = await import('./__fixtures__/hostile')
    store.dns = hostile.fakeDns(hostile.keyFor(hostile.MEMBER_DOMAIN))
    const { loadOrganizationDirectory } = await import('@/lib/sharing/directory')
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(
      new Map([
        [
          MEMBER_ID,
          { userId: MEMBER_ID, email: MEMBER_EMAIL, name: 'Anna Muster', profilePictureUrl: null },
        ],
      ])
    )
    const { readMail } = await import('./read-client')
    vi.mocked(readMail).mockResolvedValue({
      readerVersion: 1,
      bodySource: 'plain',
      ownText: 'Hallo, anbei die Unterlagen.',
      ownTextTruncated: false,
      split: true,
      signatureRemoved: true,
      quoted: [],
      quotedTruncated: false,
      calendar: [],
      calendarTruncated: false,
      encrypted: false,
      unreadableReasons: [],
      unreadable: false,
    })

    projectId = (
      await rows<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Wohnbau Hietzing', ${MEMBER_ID}, ${`coll_review_first_${STAMP}`}) RETURNING id`)
    )[0]!.id
    const addressId = (
      await rows<{ id: string }>(sql`
        INSERT INTO inbound_mail_addresses (organization_id, project_id, token, slug, created_by)
        VALUES (${ORG}, ${projectId}::uuid, ${TOKEN}, 'wohnbau', ${MEMBER_ID}) RETURNING id`)
    )[0]!.id

    // A perfect mail: the member's, signed for real, to the project, with a PDF.
    const raw = await hostile.sign(
      hostile.message(
        hostile.multipart('mixed', [
          hostile.BODY,
          hostile.attachment('S-101_C.pdf', 'application/pdf', hostile.pdf('S-101 C')),
        ]),
        {
          To: `wohnbau.${TOKEN}@piloti.at`,
          Date: new Date(Date.now() - 60_000).toUTCString(),
        }
      )
    )
    mailId = crypto.randomUUID()
    const rawKey = `org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/raw.eml`
    store.objects.set(rawKey, hostile.bytes(raw))
    await rows(sql`
      INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, envelope_from, raw_size_bytes, staging_bucket, raw_storage_key, expires_at)
      VALUES (${mailId}::uuid, ${ORG}, ${projectId}::uuid, ${addressId}::uuid, 'received', ${'e'.repeat(64)}, ${MEMBER_EMAIL}, ${raw.length}, 'grid-org-test', ${rawKey}, now() + interval '30 days')`)
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    )
    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`DELETE FROM bff_job_queue WHERE lane = ${ORG}`)
    )
  })

  it('1. holds a perfect mail without a document, a write outside its staging, or a filing job', async () => {
    const { runInboundMailReceive } = await import('./receive-job')
    await inTenant(() => runInboundMailReceive(ORG, { mailId, projectId }, { last: false }))

    const [mail] = await rows<{ status: string; sender_trust: string }>(
      sql`SELECT status, sender_trust FROM inbound_mails WHERE id = ${mailId}::uuid`
    )
    expect(mail).toEqual({ status: 'waiting', sender_trust: 'member_verified' })
    expect(
      await rows(
        sql`SELECT kind, state FROM inbound_mail_parts WHERE mail_id = ${mailId}::uuid ORDER BY position`
      )
    ).toEqual([
      { kind: 'message', state: 'waiting' },
      { kind: 'attachment', state: 'waiting' },
    ])
    expect(await documentCount()).toBe(0)
    expect(store.writes.length).toBeGreaterThan(0)
    expect(
      store.writes.every((key) =>
        key.startsWith(`org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/`)
      )
    ).toBe(true)
    expect(await jobKinds()).not.toContain('inbound_mail_file')
    expect(await jobKinds()).not.toContain('inbound_mail_follow')
  })

  it('2. files nothing when the filing job runs before anyone decided', async () => {
    const { runInboundMailFiling } = await import('./file-job')
    const { uploadDocument } = await import('@/lib/documents/service')
    const requester = {
      userId: MEMBER_ID,
      email: MEMBER_EMAIL,
      organizationMembershipId: 'om_review_first',
      role: 'member',
      permissions: [],
    }
    expect(
      await inTenant(() =>
        runInboundMailFiling(session, { projectId, mailIds: [mailId], requester })
      )
    ).toMatchObject({ done: true })
    expect(uploadDocument).not.toHaveBeenCalled()
    expect(await documentCount()).toBe(0)
  })

  it('3. files exactly what the person decided, as that person, and the text becomes nothing', async () => {
    const repository = await import('./repository')
    const { runInboundMailFiling } = await import('./file-job')
    const { uploadDocument } = await import('@/lib/documents/service')
    vi.mocked(uploadDocument).mockImplementation(async (asWho, input) => {
      const [row] = Array.from(
        await db.execute(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
          VALUES (${asWho.organizationId}, ${asWho.userId}, ${input.file.name}, ${`k/${STAMP}/upload`}, ${`coll_review_first_${STAMP}`}, 'completed', 'project', ${input.projectId}::uuid, ${input.folderId}::uuid)
          RETURNING id`)
      ) as Array<{ id: string }>
      await db.execute(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
        VALUES (${asWho.organizationId}, ${row!.id}::uuid, ${input.projectId}::uuid, 1, 'superseded', ${`k/${STAMP}/upload/v1`}, ${asWho.userId}, ${asWho.userId}, now())`)
      return { documentId: row!.id, jobId: 'job', status: 'pending', filename: input.file.name }
    })

    const parts = await inTenant(() => repository.findMailParts([mailId]))
    const file = parts.find((part) => part.kind === 'attachment')!
    const decisionId = crypto.randomUUID()
    await inTenant(() =>
      repository.writeMailDecisions(
        [
          {
            mailId,
            ifMatch: 'read',
            files: [
              {
                id: decisionId,
                organizationId: ORG,
                projectId,
                mailId,
                partId: file.id,
                action: 'file',
                decidedBy: MEMBER_ID,
                via: 'app',
                proposalId: null,
                folderId: null,
                folderPath: '',
                fileName: 'S-101_C.pdf',
                documentType: null,
              },
            ],
          },
        ],
        { decidedBy: MEMBER_ID, via: 'app', proposalId: null },
        () => 'read',
        new Date(Date.now() + 300_000),
        null
      )
    )

    const requester = {
      userId: MEMBER_ID,
      email: MEMBER_EMAIL,
      organizationMembershipId: 'om_review_first',
      role: 'member',
      permissions: [],
    }
    await inTenant(() => runInboundMailFiling(session, { projectId, mailIds: [mailId], requester }))

    expect(uploadDocument).toHaveBeenCalledOnce()
    const [asWho, input] = vi.mocked(uploadDocument).mock.calls[0]!
    expect(asWho.userId).toBe(MEMBER_ID)
    expect(input.file.name).toBe('S-101_C.pdf')
    expect(await documentCount()).toBe(1)
    expect(
      await rows(
        sql`SELECT kind, state, storage_key IS NULL AS erased FROM inbound_mail_parts WHERE mail_id = ${mailId}::uuid ORDER BY position`
      )
    ).toEqual([
      { kind: 'message', state: 'dismissed', erased: true },
      { kind: 'attachment', state: 'filed', erased: true },
    ])
    expect(store.erased).toContain(file.storageKey)
    expect(
      (
        await rows<{ count: string }>(
          sql`SELECT count(*) FROM mail_thread_entries WHERE project_id = ${projectId}::uuid`
        )
      )[0]!.count
    ).toBe('0')
  })
})

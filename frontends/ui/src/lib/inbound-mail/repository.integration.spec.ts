/**
 * @vitest-environment node
 *
 * The receive side's SQL against a REAL Postgres with migration 0186, through
 * the restricted runtime role (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbound-mail/repository.integration.spec.ts
 *
 * The unit specs stand the repository in; these prove the statements keep the
 * migration's rules rather than meet a refusal in production: a token resolves
 * across tenants only while it is active and its project live; a reception
 * counts toward the byte caps from its insert; `received` and its job are one
 * transaction, and a second delivery of the same mail is a duplicate at the
 * unique key; a mail is never `waiting` unscanned (the CHECK refuses what the
 * code would never write); a dropped mail is scrubbed; the thread and
 * Message-ID lookups find what the matching ladder asks for and no more; and a
 * held document is never a duplicate or revision candidate.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_inbound_repo_${STAMP}`
const OTHER_ORG = `org_inbound_repo_other_${STAMP}`
const USER = 'user_01J0REPOSPEC0000000000000A'
/** A fresh 12-letter base32 token per run, so reruns never meet the global unique index. */
const token = (seed: string) => (STAMP + seed).replace(/[^a-z2-7]/g, 'a').padEnd(12, 'q').slice(-12)

describe.skipIf(!url)('the E-Mail-Eingang’s receive SQL against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let projectId: string
  let otherProjectId: string
  let addressId: string
  const activeToken = token('activ')
  const revokedToken = token('revok')

  const inTenant = <T>(run: () => Promise<T>, organizationId = ORG): Promise<T> =>
    withTenant({ organizationId, userId: USER }, run)

  async function one<T>(statement: ReturnType<typeof sql>, organizationId = ORG): Promise<T> {
    const rows = await inTenant(() => db.execute(statement), organizationId)
    return Array.from(rows)[0] as T
  }

  const keyOf = (mailId: string, name = 'raw.eml') => `org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/${name}`

  async function reception(mailId: string, bytes = 1000): Promise<void> {
    await inTenant(() =>
      repo.insertReception({
        id: mailId,
        organizationId: ORG,
        projectId,
        addressId,
        envelopeFrom: 'sender@example.org',
        rawSizeBytes: bytes,
        stagingBucket: 'grid-org-test',
        rawStorageKey: keyOf(mailId),
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      }),
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')

    projectId = (
      await one<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Wohnbau Hietzing', ${USER}, ${`coll_inbound_${STAMP}`}) RETURNING id`)
    ).id
    otherProjectId = (
      await one<{ id: string }>(
        sql`INSERT INTO projects (organization_id, name, created_by, collection_name)
            VALUES (${OTHER_ORG}, 'Nachbar', ${USER}, ${`coll_inbound_other_${STAMP}`}) RETURNING id`,
        OTHER_ORG,
      )
    ).id
    addressId = (
      await one<{ id: string }>(sql`
        INSERT INTO inbound_mail_addresses (organization_id, project_id, token, slug, created_by)
        VALUES (${ORG}, ${projectId}::uuid, ${activeToken}, 'wohnbau', ${USER}) RETURNING id`)
    ).id
    await one(
      sql`INSERT INTO inbound_mail_addresses (organization_id, project_id, token, created_by, revoked_at, revoked_by, revoked_reason)
          VALUES (${OTHER_ORG}, ${otherProjectId}::uuid, ${revokedToken}, ${USER}, now(), ${USER}, 'rotated') RETURNING id`,
      OTHER_ORG,
    )
  })

  afterAll(async () => {
    // Projects cascade to every row this spec wrote; the purge path is the platform's.
    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`DELETE FROM projects WHERE organization_id IN (${ORG}, ${OTHER_ORG})`),
    )
    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`DELETE FROM bff_job_queue WHERE lane IN (${ORG}, ${OTHER_ORG})`),
    )
  })

  describe('the token lookup', () => {
    it('resolves an active token across tenants to ids only, under the platform bypass', async () => {
      const found = await withPlatformAccess('spec', () => repo.findActiveAddressByToken(activeToken))
      expect(found).toEqual({ addressId, organizationId: ORG, projectId })
    })

    it('answers a revoked token, an unknown one and a deleted project’s exactly alike: nothing', async () => {
      expect(await withPlatformAccess('spec', () => repo.findActiveAddressByToken(revokedToken))).toBeNull()
      expect(await withPlatformAccess('spec', () => repo.findActiveAddressByToken('zzzzzzzzzzzz'))).toBeNull()

      const deletedProject = (
        await one<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name, deleted_at)
          VALUES (${ORG}, 'Gelöscht', ${USER}, ${`coll_inbound_deleted_${STAMP}`}, now()) RETURNING id`)
      ).id
      const deletedToken = token('delet')
      await one(sql`INSERT INTO inbound_mail_addresses (organization_id, project_id, token, created_by)
                    VALUES (${ORG}, ${deletedProject}::uuid, ${deletedToken}, ${USER}) RETURNING id`)
      expect(await withPlatformAccess('spec', () => repo.findActiveAddressByToken(deletedToken))).toBeNull()
    })
  })

  describe('a reception', () => {
    it('counts toward the byte caps from its insert, and stops when its object is forgotten', async () => {
      const before = await inTenant(() => repo.stagedBytes(ORG, addressId))
      const mailId = crypto.randomUUID()
      await reception(mailId, 5000)

      const during = await inTenant(() => repo.stagedBytes(ORG, addressId))
      expect(during.address - before.address).toBe(5000)
      expect(during.organization - before.organization).toBe(5000)

      await inTenant(() => repo.forgetReceptionObject(mailId))
      expect(await inTenant(() => repo.stagedBytes(ORG, addressId))).toEqual(before)
    })

    it('becomes received with its job in one transaction, and a second delivery is a duplicate', async () => {
      const first = crypto.randomUUID()
      const second = crypto.randomUUID()
      const deliveryKey = 'f'.repeat(48) + STAMP.padStart(16, '0').slice(-16).replace(/[^0-9a-f]/g, '0')
      await reception(first)
      await reception(second)

      const owner = { organizationId: ORG, projectId, deliveryKey, rawSizeBytes: 1000 }
      expect(await inTenant(() => repo.completeReception({ mailId: first, ...owner }))).toBe('received')
      expect(await inTenant(() => repo.findMailIdByDeliveryKey(addressId, deliveryKey))).toBe(first)
      expect(await inTenant(() => repo.completeReception({ mailId: second, ...owner }))).toBe('duplicate')

      const job = await one<{ kind: string; payload: { mailId: string } } | undefined>(
        sql`SELECT kind, payload FROM bff_job_queue WHERE job_id = ${first}::uuid`,
      )
      expect(job).toMatchObject({ kind: 'inbound_mail_receive', payload: { mailId: first, projectId } })
      expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM bff_job_queue WHERE job_id = ${second}::uuid`)).toEqual({ n: 0 })
      expect((await inTenant(() => repo.findMailForReceive(second)))?.status).toBe('receiving')
    })
  })

  describe('holding a mail', () => {
    async function received(): Promise<string> {
      const mailId = crypto.randomUUID()
      await reception(mailId)
      const deliveryKey = (mailId.replace(/-/g, '') + mailId.replace(/-/g, '')).slice(0, 64)
      await inTenant(() => repo.completeReception({ mailId, organizationId: ORG, projectId, deliveryKey, rawSizeBytes: 1000 }))
      return mailId
    }

    const fields = (mailId: string) =>
      ({
        readStorageKey: keyOf(mailId, 'read.json'),
        messageId: `m-${mailId}@example.org`,
        inReplyTo: [],
        referenceIds: [],
        threadIndexGuid: null,
        baseSubject: 'statik dach',
        threadMatch: [],
        senderAddress: 'huber@statik.example',
        senderName: 'Huber',
        subject: 'AW: Statik Dach',
        participants: [{ role: 'from' as const, name: 'Huber', address: 'huber@statik.example' }],
        participantDomains: ['statik.example'],
        recipientCount: 1,
        senderTrust: 'external_verified' as const,
        senderUserId: null,
        senderReason: 'dkim_pass' as const,
        signerDomain: 'statik.example',
        signedHeaders: ['from', 'to', 'subject', 'date', 'message-id'],
        senderFlags: [],
        authenticationResults: 'piloti.at; dkim=pass header.d=statik.example; dmarc=pass header.from=statik.example',
        automatic: false,
        sentAt: new Date(),
        sentAtHeader: new Date(),
        notStaged: [],
        ignored: {},
      }) satisfies import('./repository').HeldMailFields

    const textPart = (mailId: string) => ({
      organizationId: ORG,
      projectId,
      mailId,
      position: 0,
      kind: 'message' as const,
      contentType: 'text/plain; charset=utf-8',
      sizeBytes: 5,
      sha256: 'a'.repeat(64),
      scanStatus: 'not_applicable' as const,
    })

    it('refuses to hold a mail whose raw message was not scanned (the database, not the code)', async () => {
      const mailId = await received()
      await expect(inTenant(() => repo.holdMail(mailId, fields(mailId), [textPart(mailId)]))).rejects.toThrow()
      expect((await inTenant(() => repo.findMailForReceive(mailId)))?.status).toBe('received')
    })

    it('holds a scanned mail with its parts, once', async () => {
      const mailId = await received()
      await inTenant(() => repo.recordRawScan(mailId, { status: 'clean', engine: 'ClamAV 1.5.4/28157', signature: null, scannedAt: new Date() }))
      const attachment = {
        ...textPart(mailId),
        position: 1,
        kind: 'attachment' as const,
        filename: 'S-101.pdf',
        contentType: 'application/pdf',
        storageKey: keyOf(mailId, '1'),
        scanStatus: 'clean' as const,
        scanEngine: 'ClamAV 1.5.4/28157',
        scannedAt: new Date(),
        riskFlags: ['name_stop' as const],
        nameStopTerms: ['Honorar'],
      }

      expect(await inTenant(() => repo.holdMail(mailId, fields(mailId), [textPart(mailId), attachment]))).toBe(true)
      expect(await inTenant(() => repo.holdMail(mailId, fields(mailId), [textPart(mailId)]))).toBe(false)

      const held = await inTenant(() => repo.findMailForReceive(mailId))
      expect(held).toMatchObject({ status: 'waiting', rawScanStatus: 'clean', rawScanAttempts: 1, senderTrust: 'external_verified' })
      expect(await inTenant(() => repo.findPartSummaries(mailId))).toEqual([
        { kind: 'message', riskFlags: [], contentFindings: [] },
        { kind: 'attachment', riskFlags: ['name_stop'], contentFindings: [] },
      ])
      await inTenant(() => repo.markNotified(mailId))
      expect((await inTenant(() => repo.findMailForReceive(mailId)))?.notifiedAt).not.toBeNull()
    })

    it('drops an automatic mail scrubbed, its raw key kept only under a deferred erasure', async () => {
      const erased = await received()
      expect(await inTenant(() => repo.dropMail(erased, { reason: 'auto_reply', erasureDeferred: false }))).toBe(true)
      expect(await inTenant(() => repo.findMailForReceive(erased))).toMatchObject({
        status: 'dropped',
        droppedReason: 'auto_reply',
        rawStorageKey: null,
        envelopeFrom: null,
      })

      const deferred = await received()
      await inTenant(() => repo.dropMail(deferred, { reason: 'delivery_report', erasureDeferred: true }))
      const row = await inTenant(() => repo.findMailForReceive(deferred))
      expect(row).toMatchObject({ status: 'dropped', rawStorageKey: keyOf(deferred) })
      expect(row?.erasureDeferredAt).not.toBeNull()
    })
  })

  describe('what the matching ladder and the parts are told', () => {
    let threadId: string
    let entryId: string
    let documentId: string

    beforeAll(async () => {
      documentId = (
        await one<{ id: string }>(sql`
          INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
                                 content_hash, screened_hash, screening_outcome)
          VALUES (${ORG}, ${USER}, 'S-101_B.pdf', ${`k/inbound/${STAMP}/b`}, ${`coll_inbound_${STAMP}`}, 'completed', 'project',
                  ${projectId}::uuid, ${'b'.repeat(64)}, ${'b'.repeat(64)}, 'clean') RETURNING id`)
      ).id
      // The same bytes, held by the content gate: never a candidate.
      await one(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash)
        VALUES (${ORG}, ${USER}, 'Gehalten.pdf', ${`k/inbound/${STAMP}/h`}, ${`coll_inbound_${STAMP}`}, 'quarantined', 'project',
                ${projectId}::uuid, ${'c'.repeat(64)}) RETURNING id`)
      threadId = (
        await one<{ id: string }>(sql`
          INSERT INTO mail_threads (organization_id, project_id, document_id, base_subject, participant_domains, locale, created_by, last_entry_at)
          VALUES (${ORG}, ${projectId}::uuid, ${documentId}::uuid, 'statik dach', '{statik.example}', 'de', ${USER}, now()) RETURNING id`)
      ).id
      entryId = (
        await one<{ id: string }>(sql`
          INSERT INTO mail_thread_entries (organization_id, project_id, thread_id, source, inbound_mail_id, message_id, sent_at, received_at,
                                           heading, sender_trust, sender_address, participants, own_text, filed_by, filed_via)
          VALUES (${ORG}, ${projectId}::uuid, ${threadId}::uuid, 'inbound', gen_random_uuid(), 'm1@statik.example', now(), now(),
                  '21.10.2026 09:00 · Huber (statik.example)', 'external_verified', 'huber@statik.example',
                  '[{"role":"to","name":null,"address":"Planung@Buero.example"}]'::jsonb, 'Die Bewehrung passt.', ${USER}, 'app') RETURNING id`)
      ).id
      await one(sql`
        INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id) VALUES
          (${ORG}, ${projectId}::uuid, ${threadId}::uuid, 'm1@statik.example', 'received', ${entryId}::uuid),
          (${ORG}, ${projectId}::uuid, ${threadId}::uuid, 'm0@statik.example', 'referenced', ${entryId}::uuid)
        RETURNING id`)
      await one(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at)
        VALUES (${ORG}, ${projectId}::uuid, ${threadId}::uuid, ${USER}, now() + interval '60 days') RETURNING id`)
    })

    it('finds a thread by a cited id, its GUID or its subject, with only what the mail shares', async () => {
      const [byReference] = await inTenant(() =>
        repo.findThreadCandidates(projectId, {
          messageIds: ['m1@statik.example', 'unrelated@x'],
          threadIndexGuid: null,
          baseSubject: 'anderes thema',
          participants: ['planung@buero.example', 'someone@else.example'],
        }),
      )
      expect(byReference).toMatchObject({
        threadId,
        baseSubject: 'statik dach',
        receivedIds: ['m1@statik.example'],
        referencedIds: [],
        participants: ['planung@buero.example'],
      })

      const bySubject = await inTenant(() =>
        repo.findThreadCandidates(projectId, { messageIds: [], threadIndexGuid: null, baseSubject: 'statik dach', participants: [] }),
      )
      expect(bySubject.map((candidate) => candidate.threadId)).toEqual([threadId])
      const none = await inTenant(() =>
        repo.findThreadCandidates(projectId, { messageIds: [], threadIndexGuid: null, baseSubject: '', participants: [] }),
      )
      expect(none).toEqual([])
    })

    it('finds the filed messages of a Message-ID with the hash of their own text', async () => {
      const [filed] = await inTenant(() => repo.findFiledMessages(projectId, 'm1@statik.example'))
      const { createHash } = await import('node:crypto')
      expect(filed).toEqual({
        entryId,
        threadId,
        source: 'inbound',
        ownTextSha256: createHash('sha256').update('Die Bewehrung passt.').digest('hex'),
      })
      expect(await inTenant(() => repo.findFiledMessages(projectId, 'm0@statik.example'))).toEqual([])
    })

    it('names a screened duplicate and namesake by id, and never a held document', async () => {
      expect(await inTenant(() => repo.findScreenedDuplicates(projectId, ['b'.repeat(64), 'c'.repeat(64)]))).toEqual(
        new Map([['b'.repeat(64), documentId]]),
      )
      expect(await inTenant(() => repo.findScreenedNamesakes(projectId, ['S-101_B.pdf', 'Gehalten.pdf']))).toEqual(
        new Map([['S-101_B.pdf', documentId]]),
      )
    })

    it('reads a thread’s follows for the follow check, and nothing of another project', async () => {
      const context = await inTenant(() => repo.findThreadFollowContext(projectId, threadId))
      expect(context).toMatchObject({ threadId, participantDomains: ['statik.example'] })
      expect(context?.follows).toHaveLength(1)
      expect(context?.follows[0]).toMatchObject({ userId: USER, endedAt: null })
      expect(await inTenant(() => repo.findThreadFollowContext(otherProjectId, threadId))).toBeNull()
    })
  })

  describe('the review: the address, decisions, dismissal and restore (D8)', () => {
    const PERSON = USER
    const OTHER_PERSON = 'user_01J0REPOSPEC0000000000000B'
    const etag = (mail: { updatedAt: Date }, parts: ReadonlyArray<{ id: string; state: string }>) =>
      `${new Date(mail.updatedAt).toISOString()}|${parts.map((part) => `${part.id}:${part.state}`).join(',')}`
    const actor = { decidedBy: PERSON, via: 'app' as const, proposalId: null }

    /** A mail held with its text and one clean attachment, through the receive side's own statements. */
    async function heldMail(): Promise<{ mailId: string; textId: string; fileId: string }> {
      const mailId = crypto.randomUUID()
      await reception(mailId)
      const deliveryKey = (mailId.replace(/-/g, '') + mailId.replace(/-/g, '')).slice(0, 64)
      await inTenant(() => repo.completeReception({ mailId, organizationId: ORG, projectId, deliveryKey, rawSizeBytes: 1000 }))
      await inTenant(() => repo.recordRawScan(mailId, { status: 'clean', engine: 'ClamAV 1.5.4/28157', signature: null, scannedAt: new Date() }))
      const base = { organizationId: ORG, projectId, mailId, contentType: 'text/plain', sizeBytes: 5, sha256: 'a'.repeat(64) }
      await inTenant(() =>
        repo.holdMail(
          mailId,
          {
            readStorageKey: keyOf(mailId, 'read.json'),
            messageId: `<m-${mailId}@example.org>`,
            inReplyTo: [],
            referenceIds: [],
            threadIndexGuid: null,
            baseSubject: 'statik dach',
            threadMatch: [],
            senderAddress: 'huber@statik.example',
            senderName: 'Huber',
            subject: 'AW: Statik Dach',
            participants: [],
            participantDomains: ['statik.example'],
            recipientCount: 1,
            senderTrust: 'external_verified',
            senderUserId: null,
            senderReason: 'dkim_pass',
            signerDomain: 'statik.example',
            signedHeaders: ['from', 'subject', 'date', 'message-id'],
            senderFlags: [],
            authenticationResults: null,
            automatic: false,
            sentAt: new Date(),
            sentAtHeader: new Date(),
            notStaged: [],
            ignored: {},
          },
          [
            { ...base, position: 0, kind: 'message', scanStatus: 'not_applicable' },
            {
              ...base,
              position: 1,
              kind: 'attachment',
              filename: 'S-101.pdf',
              contentType: 'application/pdf',
              storageKey: keyOf(mailId, '1'),
              scanStatus: 'clean',
              scanEngine: 'ClamAV 1.5.4/28157',
              scannedAt: new Date(),
            },
          ],
        ),
      )
      const parts = await inTenant(() => repo.findMailParts([mailId]))
      return { mailId, textId: parts[0]!.id, fileId: parts[1]!.id }
    }

    async function currentEtag(mailId: string): Promise<string> {
      const mail = await inTenant(() => repo.findProjectMail(projectId, mailId))
      return etag(mail!, await inTenant(() => repo.findMailParts([mailId])))
    }

    const fileRow = (mailId: string, partId: string, overrides: Record<string, unknown> = {}) => ({
      id: crypto.randomUUID(),
      organizationId: ORG,
      projectId,
      mailId,
      partId,
      action: 'file' as const,
      decidedBy: PERSON,
      via: 'app' as const,
      proposalId: null,
      folderId: null,
      folderPath: 'Tragwerk',
      fileName: 'S-101.pdf',
      ...overrides,
    })

    it('gives a project one active address, and replacing it revokes the old one and ends the project’s follows', async () => {
      const own = (await one<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Adressprojekt', ${USER}, ${`coll_inbound_addr_${STAMP}`}) RETURNING id`)).id
      const first = await inTenant(() => repo.insertAddress({ organizationId: ORG, projectId: own, token: token('first'), slug: 'haus', createdBy: PERSON }))
      expect(first.ok).toBe(true)
      expect(await inTenant(() => repo.insertAddress({ organizationId: ORG, projectId: own, token: token('secnd'), slug: 'haus', createdBy: PERSON }))).toEqual({
        ok: false,
        conflict: 'active',
      })
      const thread = (await one<{ id: string }>(sql`
        INSERT INTO mail_threads (organization_id, project_id, base_subject, locale, created_by)
        VALUES (${ORG}, ${own}::uuid, 'statik', 'de', ${PERSON}) RETURNING id`)).id
      await one(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at)
        VALUES (${ORG}, ${own}::uuid, ${thread}::uuid, ${OTHER_PERSON}, now() + interval '60 days') RETURNING id`)

      const replaced = await inTenant(() => repo.replaceAddress({ organizationId: ORG, projectId: own, token: token('third'), slug: 'haus', createdBy: PERSON }))
      expect(replaced.ok && replaced.value.previousAddressId).toBe(first.ok ? first.value.id : null)
      expect(replaced.ok && replaced.value.followsEnded).toEqual([expect.objectContaining({ threadId: thread, userId: OTHER_PERSON })])
      expect(await one(sql`SELECT revoked_reason, revoked_by FROM inbound_mail_addresses WHERE id = ${first.ok ? first.value.id : ''}::uuid`)).toEqual({
        revoked_reason: 'rotated',
        revoked_by: PERSON,
      })
      expect(await one(sql`SELECT ended_reason, ended_by FROM mail_thread_follows WHERE thread_id = ${thread}::uuid`)).toEqual({
        ended_reason: 'address_rotated',
        ended_by: PERSON,
      })
      expect(await inTenant(() => repo.switchOffAddress(own, PERSON))).toMatchObject({ followsEnded: [] })
      expect(await inTenant(() => repo.findActiveAddress(own))).toBeNull()
      expect(await inTenant(() => repo.switchOffAddress(own, PERSON))).toBeNull()
    })

    it('writes a decision with its claim, dismisses the rest and queues the job, all at once', async () => {
      const { mailId, textId, fileId } = await heldMail()
      const jobId = crypto.randomUUID()
      const written = await inTenant(() =>
        repo.writeMailDecisions([{ mailId, ifMatch: 'x', files: [fileRow(mailId, fileId)] }], actor, () => 'x', new Date(Date.now() + 300_000), {
          jobId,
          organizationId: ORG,
          payload: { projectId, mailIds: [mailId], requester: { userId: PERSON } },
        }),
      )
      expect(written.decisions.map((row) => [row.partId, row.action])).toEqual([
        [fileId, 'file'],
        [textId, 'dismiss'],
      ])
      const parts = await inTenant(() => repo.findMailParts([mailId]))
      expect(parts.map((part) => part.state)).toEqual(['dismissed', 'filing'])
      expect(parts[1]?.decisionId).toBe(written.decisions[0]?.id)
      expect(await one(sql`SELECT kind FROM bff_job_queue WHERE job_id = ${jobId}::uuid`)).toEqual({ kind: 'inbound_mail_file' })

      const listed = await inTenant(() => repo.listProjectMails(projectId, { status: 'waiting', limit: 50 }, null))
      expect(listed.map((row) => row.mail.id)).toContain(mailId)
    })

    it('lets exactly one of two decisions on the same mail win (compare-and-set)', async () => {
      const { mailId, fileId } = await heldMail()
      const ifMatch = await currentEtag(mailId)
      const attempt = () =>
        inTenant(() => repo.writeMailDecisions([{ mailId, ifMatch, files: [fileRow(mailId, fileId)] }], actor, etag, new Date(Date.now() + 300_000), null))
      const results = await Promise.allSettled([attempt(), attempt()])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const [refused] = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(refused?.reason).toBeInstanceOf(repo.MailChangedError)
      expect(await one(sql`SELECT count(*)::int AS n FROM inbound_mail_decisions WHERE mail_id = ${mailId}::uuid AND action = 'file'`)).toEqual({ n: 1 })
    })

    it('refuses a Piloti card carrying an acknowledgement, in the database (RT-S5)', async () => {
      const { mailId, fileId } = await heldMail()
      const card = { decidedBy: PERSON, via: 'piloti_proposal' as const, proposalId: crypto.randomUUID() }
      await expect(
        inTenant(() =>
          repo.writeMailDecisions(
            [{ mailId, ifMatch: 'x', files: [fileRow(mailId, fileId, { via: 'piloti_proposal', proposalId: card.proposalId, acknowledgedRisk: true })] }],
            card,
            () => 'x',
            new Date(Date.now() + 300_000),
            null,
          ),
        ),
      ).rejects.toSatisfy((error: unknown) => {
        const cause = (error as { cause?: { constraint_name?: string } }).cause
        return cause?.constraint_name === 'inbound_mail_decisions_piloti_cards_file_clean'
      })
      expect((await inTenant(() => repo.findMailParts([mailId]))).map((part) => part.state)).toEqual(['waiting', 'waiting'])
    })

    it('dismisses and restores within the window, each act a decision, and a second restore finds nothing', async () => {
      const { mailId } = await heldMail()
      const dismissed = await inTenant(() => repo.dismissMails(projectId, [mailId], actor))
      expect(dismissed.decisions.map((row) => row.action)).toEqual(['dismiss', 'dismiss'])
      expect(await inTenant(() => repo.hasOpenParts(mailId))).toBe(false)
      expect(await inTenant(() => repo.dismissMails(projectId, [mailId], actor))).toEqual({ decisions: [] })
      const handled = await inTenant(() => repo.listProjectMails(projectId, { status: 'handled', outcome: 'dismissed', limit: 50 }, null))
      expect(handled.map((row) => row.mail.id)).toContain(mailId)

      const later = new Date(Date.now() + 7 * 86_400_000)
      const restored = await inTenant(() => repo.restoreMailParts(projectId, mailId, actor, new Date(Date.now() - 7 * 86_400_000), later))
      expect(restored.decisions.map((row) => row.action)).toEqual(['restore', 'restore'])
      expect((await inTenant(() => repo.findMailParts([mailId]))).map((part) => part.state)).toEqual(['waiting', 'waiting'])
      expect(await inTenant(() => repo.restoreMailParts(projectId, mailId, actor, new Date(0), later))).toEqual({ decisions: [] })

      await inTenant(() => repo.markDecisionsAudited(restored.decisions.map((row) => row.id)))
      expect(await one(sql`SELECT count(*)::int AS n FROM inbound_mail_decisions WHERE mail_id = ${mailId}::uuid AND audited_at IS NOT NULL`)).toEqual({ n: 2 })
    })
  })
})

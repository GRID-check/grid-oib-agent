/**
 * @vitest-environment node
 *
 * The SQL that writes an E-Mail-Verlauf, against a REAL Postgres with migration
 * 0186, through the restricted runtime role (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/mail-thread/append.integration.spec.ts
 *
 * The unit specs stand the repository in; these prove its statements keep the
 * migration's rules rather than meet a refusal in production: one writer per
 * thread (the render lease's compare-and-set); a filed message recorded all at
 * once, and a retried commit changing nothing; what came with it linked to its
 * Fassung and frozen, a waiting attachment filed later linked once (D36); a
 * thread whose document is archived or binned is no target; the original's
 * columns under the entry's own key, and the raw forgotten; a detach that
 * MOVES the row (no DELETE grant) with its Message-IDs and ends the follows;
 * which mail brought a document, only through a thread the reader may read;
 * and the filing job's claim, outcomes and settle as compare-and-sets.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_mail_append_${STAMP}`
const USER = 'user_01J0APPENDSPEC00000000000A'
const OTHER_USER = 'user_01J0APPENDSPEC00000000000B'
const token = (seed: string) =>
  (STAMP + seed)
    .replace(/[^a-z2-7]/g, 'a')
    .padEnd(12, 'q')
    .slice(-12)

describe.skipIf(!url)('writing an E-Mail-Verlauf against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let write: typeof import('./write-repository')
  let read: typeof import('./repository')
  let filing: typeof import('@/lib/inbound-mail/filing-repository')
  let reader: typeof import('@/lib/documents/document-reader')
  let projectId: string
  let addressId: string
  /** A folder the reader in the origins case may not open (passed as hidden, as `getHiddenFolderIds` would). */
  let restrictedFolder: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)
  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return Array.from(await inTenant(() => db.execute(statement))) as T[]
  }
  const one = async <T>(statement: ReturnType<typeof sql>): Promise<T> =>
    (await rows<T>(statement))[0] as T

  const stagingKey = (mailId: string, name: string) =>
    `org/${ORG}/project/${projectId}/_inbound-mail/${mailId}/${name}`

  /** A document of the project, screened (`completed` with no verdict), with one Fassung. */
  async function document(
    filename: string,
    folderId: string | null = null
  ): Promise<{ id: string; versionId: string }> {
    const { id } = await one<{ id: string }>(sql`
      INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
      VALUES (${ORG}, ${USER}, ${filename}, ${`k/${STAMP}/${filename}`}, ${`coll_append_${STAMP}`}, 'completed', 'project', ${projectId}::uuid, ${folderId}::uuid)
      RETURNING id`)
    const version = await one<{ id: string }>(sql`
      INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
      VALUES (${ORG}, ${id}::uuid, ${projectId}::uuid, 1, 'superseded', ${`k/${STAMP}/${filename}/v1`}, ${USER}, ${USER}, now()) RETURNING id`)
    return { id, versionId: version.id }
  }

  /** A waiting mail with its text and one attachment, each claimed on a `file` decision of the person's. */
  async function heldMail(): Promise<{
    mailId: string
    textPart: string
    filePart: string
    textDecision: string
    fileDecision: string
  }> {
    const mailId = crypto.randomUUID()
    await rows(sql`
      INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, raw_size_bytes, staging_bucket,
        raw_storage_key, read_storage_key, raw_scan_status, raw_scanned_at, sender_address, sender_name, subject, base_subject,
        sender_trust, sender_reason, signer_domain, message_id, in_reply_to, participants, participant_domains, sent_at, expires_at)
      VALUES (${mailId}::uuid, ${ORG}, ${projectId}::uuid, ${addressId}::uuid, 'waiting', ${mailId.replace(/-/g, '').padEnd(64, 'a')}, 2048, 'grid-org-test',
        ${stagingKey(mailId, 'raw.eml')}, ${stagingKey(mailId, 'read.json')}, 'clean', now(), 'p.weber@statik-weber.at', 'DI Petra Weber',
        'Statik', 'statik', 'external_verified', 'dkim_pass', 'statik-weber.at', ${`<${mailId}@statik-weber.at>`}, '{"<first@piloti.test>"}',
        '[]'::jsonb, '{statik-weber.at}', now() - interval '1 hour', now() + interval '30 days')
      RETURNING id`)
    const text = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_parts (organization_id, project_id, mail_id, position, kind, content_type, size_bytes, sha256, scan_status)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, 0, 'message', 'text/plain', 12, ${'a'.repeat(64)}, 'not_applicable') RETURNING id`)
    const file = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_parts (organization_id, project_id, mail_id, position, kind, filename, content_type, size_bytes, sha256, storage_key, scan_status, scanned_at)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, 1, 'attachment', 'S-101_C.pdf', 'application/pdf', 100, ${'b'.repeat(64)}, ${stagingKey(mailId, '1')}, 'clean', now())
      RETURNING id`)
    const textDecision = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, folder_path, file_name, thread_action, message_text, document_type)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, ${text.id}::uuid, 'file', ${USER}, '', 'Statik', 'create', 'full', 'correspondence') RETURNING id`)
    const fileDecision = await one<{ id: string }>(sql`
      INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, folder_path, file_name, document_type)
      VALUES (${ORG}, ${projectId}::uuid, ${mailId}::uuid, ${file.id}::uuid, 'file', ${USER}, '', 'S-101_C.pdf', 'Norm/Richtlinie') RETURNING id`)
    await rows(
      sql`UPDATE inbound_mail_parts SET state = 'filing', decision_id = ${textDecision.id}::uuid, claim_expires_at = now() + interval '5 minutes' WHERE id = ${text.id}::uuid`
    )
    await rows(
      sql`UPDATE inbound_mail_parts SET state = 'filing', decision_id = ${fileDecision.id}::uuid, claim_expires_at = now() + interval '5 minutes' WHERE id = ${file.id}::uuid`
    )
    return {
      mailId,
      textPart: text.id,
      filePart: file.id,
      textDecision: textDecision.id,
      fileDecision: fileDecision.id,
    }
  }

  type Commit = import('./write-repository').AppendCommit
  /** A commit as `append.ts` builds it: a new thread, its first entry, what came with it. */
  function newThreadCommit(
    mail: Awaited<ReturnType<typeof heldMail>>,
    thread: { id: string; documentId: string; versionId: string },
    attachment: { documentId: string | null; versionId: string | null }
  ): Commit {
    const entryId = crypto.randomUUID()
    const sentAt = new Date(Date.now() - 3_600_000)
    return {
      threadId: thread.id,
      newThread: {
        id: thread.id,
        organizationId: ORG,
        projectId,
        documentId: thread.documentId,
        baseSubject: 'statik',
        locale: 'de',
        createdBy: USER,
      },
      threadUpdate: {
        documentId: thread.documentId,
        entryCount: 1,
        renderedBytes: 420,
        lastEntryAt: sentAt,
        participantDomains: ['statik-weber.at'],
      },
      entry: {
        id: entryId,
        organizationId: ORG,
        projectId,
        threadId: thread.id,
        source: 'inbound',
        inboundMailId: mail.mailId,
        messageId: `<${mail.mailId}@statik-weber.at>`,
        sentAt,
        receivedAt: sentAt,
        heading: `21.10.2026 10:14 · DI Petra Weber (statik-weber.at) ${entryId.slice(0, 4)}`,
        senderTrust: 'external_verified',
        senderDomain: 'statik-weber.at',
        signerDomain: 'statik-weber.at',
        ownText: 'Freigegeben.',
        firstVersionId: thread.versionId,
        filedBy: USER,
        filedVia: 'app',
        filedAt: sentAt,
      },
      messageIds: {
        received: `<${mail.mailId}@statik-weber.at>`,
        referenced: ['<first@piloti.test>'],
      },
      attachments: [
        {
          organizationId: ORG,
          projectId,
          entryId,
          position: 1,
          filename: 'S-101_C.pdf',
          disposition: attachment.documentId ? 'filed' : 'not_filed',
          notFiledReason: attachment.documentId ? null : 'pending',
          documentId: attachment.documentId,
          documentVersionId: attachment.versionId,
          sectionName: attachment.documentId ? 'S-101_C.pdf' : null,
          sectionFolderPath: null,
        },
      ],
      part: { id: mail.textPart, documentId: thread.documentId, versionId: thread.versionId },
      mailId: mail.mailId,
      movesOriginal: true,
    }
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    write = await import('./write-repository')
    read = await import('./repository')
    filing = await import('@/lib/inbound-mail/filing-repository')
    reader = await import('@/lib/documents/document-reader')

    projectId = (
      await one<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Wohnbau Hietzing', ${USER}, ${`coll_append_${STAMP}`}) RETURNING id`)
    ).id
    addressId = (
      await one<{ id: string }>(sql`
        INSERT INTO inbound_mail_addresses (organization_id, project_id, token, slug, created_by)
        VALUES (${ORG}, ${projectId}::uuid, ${token('apnd')}, 'wohnbau', ${USER}) RETURNING id`)
    ).id
    restrictedFolder = (
      await one<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path)
        VALUES (${ORG}, ${projectId}::uuid, 'Intern', 'Intern') RETURNING id`)
    ).id
  })

  afterAll(async () => {
    // The project cascades to every row this spec wrote; the purge path is the platform's.
    await withPlatformAccess('test cleanup', () =>
      db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    )
  })

  describe('the render lease', () => {
    it('lets one writer hold a thread at a time, the same one again, and anyone once it ran out', async () => {
      const thread = await document('Lease.md')
      const threadId = crypto.randomUUID()
      await rows(sql`INSERT INTO mail_threads (id, organization_id, project_id, document_id, base_subject, locale, created_by)
                     VALUES (${threadId}::uuid, ${ORG}, ${projectId}::uuid, ${thread.id}::uuid, 'lease', 'de', ${USER})`)
      const [a, b] = [crypto.randomUUID(), crypto.randomUUID()]
      const soon = new Date(Date.now() + 60_000)
      expect(await inTenant(() => write.acquireRenderLease(threadId, a, soon))).toBe(true)
      expect(await inTenant(() => write.acquireRenderLease(threadId, b, soon))).toBe(false)
      expect(await inTenant(() => write.acquireRenderLease(threadId, a, soon))).toBe(true)
      await inTenant(() => write.releaseRenderLease(threadId, b))
      expect(await inTenant(() => write.acquireRenderLease(threadId, b, soon))).toBe(false)
      await inTenant(() => write.releaseRenderLease(threadId, a))
      expect(
        await inTenant(() => write.acquireRenderLease(threadId, b, new Date(Date.now() - 1)))
      ).toBe(true)
      expect(await inTenant(() => write.acquireRenderLease(threadId, a, soon))).toBe(true)
    })

    it('races: of many writers at once, exactly one holds the thread', async () => {
      const thread = await document('Race.md')
      const threadId = crypto.randomUUID()
      await rows(sql`INSERT INTO mail_threads (id, organization_id, project_id, document_id, base_subject, locale, created_by)
                     VALUES (${threadId}::uuid, ${ORG}, ${projectId}::uuid, ${thread.id}::uuid, 'race', 'de', ${USER})`)
      const until = new Date(Date.now() + 60_000)
      const won = await Promise.all(
        Array.from({ length: 8 }, () =>
          inTenant(() => write.acquireRenderLease(threadId, crypto.randomUUID(), until))
        )
      )
      expect(won.filter(Boolean)).toHaveLength(1)
    })
  })

  describe('a filed message', () => {
    it('is recorded all at once, and a retried commit changes nothing', async () => {
      const mail = await heldMail()
      const thread = await document('Statik.md')
      const attachmentDoc = await document('S-101_C.pdf')
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: thread.id, versionId: thread.versionId },
        { documentId: attachmentDoc.id, versionId: attachmentDoc.versionId }
      )

      expect(await inTenant(() => write.commitAppend(commit))).toBe('committed')
      expect(await inTenant(() => write.commitAppend(commit))).toBe('already')

      const part = await one<{
        state: string
        document_id: string
        document_version_id: string
        mail_thread_entry_id: string
        claim_expires_at: Date | null
      }>(
        sql`SELECT state, document_id, document_version_id, mail_thread_entry_id, claim_expires_at FROM inbound_mail_parts WHERE id = ${mail.textPart}::uuid`
      )
      expect(part).toMatchObject({
        state: 'filed',
        document_id: thread.id,
        document_version_id: thread.versionId,
        mail_thread_entry_id: commit.entry.id,
        claim_expires_at: null,
      })
      expect(
        await rows(
          sql`SELECT state, message_id FROM mail_thread_message_ids WHERE entry_id = ${commit.entry.id!}::uuid ORDER BY state`
        )
      ).toEqual([
        { state: 'received', message_id: `<${mail.mailId}@statik-weber.at>` },
        { state: 'referenced', message_id: '<first@piloti.test>' },
      ])
      expect(
        (
          await one<{ moving: boolean }>(
            sql`SELECT original_move_pending_at IS NOT NULL AS moving FROM inbound_mails WHERE id = ${mail.mailId}::uuid`
          )
        ).moving
      ).toBe(true)
      expect(
        (
          await one<{ count: string }>(
            sql`SELECT count(*) FROM mail_threads WHERE id = ${commit.threadId}::uuid`
          )
        ).count
      ).toBe('1')
      expect(await inTenant(() => write.findEntryOfMail(projectId, mail.mailId))).toMatchObject({
        id: commit.entry.id,
        threadId: commit.threadId,
      })
    })

    it('links what came with it, freezes what the section prints, and links a waiting attachment filed later once (D36)', async () => {
      const mail = await heldMail()
      const thread = await document('Pending.md')
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: thread.id, versionId: thread.versionId },
        { documentId: null, versionId: null }
      )
      await inTenant(() => write.commitAppend(commit))
      const later = await document('S-101_C later.pdf')

      await inTenant(() =>
        write.decidePendingAttachment(commit.entry.id!, 1, {
          disposition: 'filed',
          documentId: later.id,
          versionId: later.versionId,
        })
      )
      await inTenant(() =>
        write.decidePendingAttachment(commit.entry.id!, 1, {
          disposition: 'not_filed',
          reason: 'dismissed',
        })
      )

      const [row] =
        (await inTenant(() => write.findEntryAttachmentRows([commit.entry.id!]))).get(
          commit.entry.id!
        ) ?? []
      expect(row).toMatchObject({
        disposition: 'filed',
        notFiledReason: null,
        documentId: later.id,
        documentVersionId: later.versionId,
        sectionName: null,
      })
      await expect(
        rows(
          sql`UPDATE mail_thread_entry_attachments SET section_name = 'S-101_C.pdf' WHERE entry_id = ${commit.entry.id!}::uuid`
        )
      ).rejects.toThrow()
    })
  })

  describe('the thread a filing writes to', () => {
    it('is no target once its document is archived, or its folder is in the bin', async () => {
      const archived = await document('Archived.md')
      const binnedFolder = await one<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path) VALUES (${ORG}, ${projectId}::uuid, 'Alt', 'Alt') RETURNING id`)
      const binned = await document('Binned.md', binnedFolder.id)
      await rows(
        sql`UPDATE project_folders SET deleted_at = now(), deleted_by = ${USER} WHERE id = ${binnedFolder.id}::uuid`
      )
      const live = await document('Live.md')
      const ids = {
        archived: crypto.randomUUID(),
        binned: crypto.randomUUID(),
        live: crypto.randomUUID(),
      }
      for (const [key, doc] of [
        ['archived', archived],
        ['binned', binned],
        ['live', live],
      ] as const) {
        await rows(sql`INSERT INTO mail_threads (id, organization_id, project_id, document_id, base_subject, locale, created_by)
                       VALUES (${ids[key]}::uuid, ${ORG}, ${projectId}::uuid, ${doc.id}::uuid, ${key}, 'de', ${USER})`)
      }
      await rows(sql`UPDATE documents SET lifecycle = 'archived' WHERE id = ${archived.id}::uuid`)
      const person = reader.memberReader(USER)
      expect(
        await inTenant(() => write.findWritableThread(projectId, ids.archived, person))
      ).toBeNull()
      expect(
        await inTenant(() => write.findWritableThread(projectId, ids.binned, person))
      ).toBeNull()
      expect(
        await inTenant(() => write.findWritableThread(projectId, ids.live, person))
      ).toMatchObject({ document: { id: live.id, filename: 'Live.md' } })
    })
  })

  describe('the original', () => {
    it('is recorded under the entry’s own key once, and the mail forgets its raw message', async () => {
      const mail = await heldMail()
      const thread = await document('Original.md')
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: thread.id, versionId: thread.versionId },
        { documentId: null, versionId: null }
      )
      await inTenant(() => write.commitAppend(commit))
      const key = `org/${ORG}/project/${projectId}/_mail-originals/${commit.entry.id}.eml`
      const original = {
        originalBucket: 'grid-org-test',
        originalStorageKey: key,
        originalSha256: 'c'.repeat(64),
        originalBytes: 2048,
        originalScanStatus: 'clean' as const,
        originalScannedAt: new Date(),
      }
      await inTenant(() => write.recordEntryOriginal(commit.entry.id!, original))
      await inTenant(() =>
        write.recordEntryOriginal(commit.entry.id!, { ...original, originalSha256: 'd'.repeat(64) })
      )
      await inTenant(() => write.forgetMovedRaw(mail.mailId))
      expect(await inTenant(() => write.findEntry(projectId, commit.entry.id!))).toMatchObject({
        originalStorageKey: key,
        originalSha256: 'c'.repeat(64),
      })
      expect(
        await one(
          sql`SELECT raw_storage_key, original_move_pending_at FROM inbound_mails WHERE id = ${mail.mailId}::uuid`
        )
      ).toEqual({ raw_storage_key: null, original_move_pending_at: null })
    })
  })

  describe('detach', () => {
    it('moves the entry with its ids and what came with it, ends the follows, and the runtime role cannot delete it', async () => {
      const mail = await heldMail()
      const source = await document('Source.md')
      const target = await document('Target.md')
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: source.id, versionId: source.versionId },
        { documentId: null, versionId: null }
      )
      await inTenant(() => write.commitAppend(commit))
      const follow = await one<{ id: string }>(sql`
        INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at)
        VALUES (${ORG}, ${projectId}::uuid, ${commit.threadId}::uuid, ${OTHER_USER}, now() + interval '60 days') RETURNING id`)
      const toThreadId = crypto.randomUUID()
      const movedAt = new Date()

      const ended = await inTenant(() =>
        write.commitDetach({
          entryId: commit.entry.id!,
          fromThreadId: commit.threadId,
          toThreadId,
          newThread: {
            id: toThreadId,
            organizationId: ORG,
            projectId,
            documentId: target.id,
            baseSubject: 'statik',
            locale: 'de',
            createdBy: USER,
          },
          heading: commit.entry.heading,
          fromThreadUpdate: { entryCount: 0, renderedBytes: 10, lastEntryAt: null },
          toThreadUpdate: {
            documentId: target.id,
            entryCount: 1,
            renderedBytes: 420,
            lastEntryAt: movedAt,
            participantDomains: ['statik-weber.at'],
          },
          firstVersionId: target.versionId,
          movedAt,
        })
      )

      expect(ended).toEqual([{ id: follow.id, userId: OTHER_USER }])
      expect(
        await one(
          sql`SELECT ended_reason, ended_by FROM mail_thread_follows WHERE id = ${follow.id}::uuid`
        )
      ).toEqual({ ended_reason: 'detached', ended_by: null })
      expect(
        await one(
          sql`SELECT thread_id, first_version_id FROM mail_thread_entries WHERE id = ${commit.entry.id!}::uuid`
        )
      ).toEqual({ thread_id: toThreadId, first_version_id: target.versionId })
      expect(
        await rows(
          sql`SELECT DISTINCT thread_id FROM mail_thread_message_ids WHERE entry_id = ${commit.entry.id!}::uuid`
        )
      ).toEqual([{ thread_id: toThreadId }])
      expect(
        (
          await one<{ count: string }>(
            sql`SELECT count(*) FROM mail_thread_entry_attachments WHERE entry_id = ${commit.entry.id!}::uuid`
          )
        ).count
      ).toBe('1')
      const refused = await rows(
        sql`DELETE FROM mail_thread_entries WHERE id = ${commit.entry.id!}::uuid`
      ).catch((error: unknown) => error)
      expect(String((refused as { cause?: unknown }).cause)).toMatch(/permission denied/)
    })
  })

  describe('which mail brought a document (D36)', () => {
    it('names the mail through a thread the reader may read, and nothing through one in a folder they may not open', async () => {
      const mail = await heldMail()
      const thread = await document('Origins.md')
      const attachmentDoc = await document('Bescheid.pdf')
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: thread.id, versionId: thread.versionId },
        { documentId: attachmentDoc.id, versionId: attachmentDoc.versionId }
      )
      await inTenant(() => write.commitAppend(commit))

      const origins = await inTenant(() => read.findMailOrigins(projectId, attachmentDoc.id, []))
      expect(origins).toEqual([
        expect.objectContaining({
          documentVersionId: attachmentDoc.versionId,
          threadId: commit.threadId,
          entryId: commit.entry.id,
          senderName: null,
          signerDomain: 'statik-weber.at',
          senderTrust: 'external_verified',
        }),
      ])
      const listed = await inTenant(() =>
        read.entryAttachments([
          { id: commit.entry.id! } as import('@/lib/db/schema').MailThreadEntryRow,
        ])
      )
      expect(listed).toEqual([
        expect.objectContaining({
          position: 1,
          disposition: 'filed',
          documentId: attachmentDoc.id,
          document: { folderId: null },
        }),
      ])

      await rows(
        sql`UPDATE documents SET folder_id = ${restrictedFolder}::uuid WHERE id = ${thread.id}::uuid`
      )
      expect(
        await inTenant(() => read.findMailOrigins(projectId, attachmentDoc.id, [restrictedFolder]))
      ).toEqual([])
    })
  })

  describe('the filing job’s claim, outcomes and settle', () => {
    it('files an attachment only on its own live claim, and a part waits again with its failure', async () => {
      const mail = await heldMail()
      const doc = await document('Claimed.pdf')
      expect(
        await inTenant(() =>
          filing.renewClaim(mail.filePart, mail.textDecision, new Date(Date.now() + 60_000))
        )
      ).toBe(false)
      expect(
        await inTenant(() =>
          filing.renewClaim(mail.filePart, mail.fileDecision, new Date(Date.now() + 60_000))
        )
      ).toBe(true)
      expect(
        await inTenant(() =>
          filing.markAttachmentFiled(mail.filePart, mail.textDecision, {
            documentId: doc.id,
            versionId: doc.versionId,
            erasureDeferred: false,
          })
        )
      ).toBe(false)
      expect(
        await inTenant(() =>
          filing.markAttachmentFiled(mail.filePart, mail.fileDecision, {
            documentId: doc.id,
            versionId: doc.versionId,
            erasureDeferred: false,
          })
        )
      ).toBe(true)
      expect(
        await one(
          sql`SELECT state, storage_key, filename, document_id FROM inbound_mail_parts WHERE id = ${mail.filePart}::uuid`
        )
      ).toEqual({
        state: 'filed',
        storage_key: null,
        filename: null,
        document_id: doc.id,
      })
      expect(
        await inTenant(() => filing.returnPartToWaiting(mail.textPart, mail.textDecision, 'quota'))
      ).toBe(true)
      expect(
        await one(
          sql`SELECT state, decision_id, last_failure FROM inbound_mail_parts WHERE id = ${mail.textPart}::uuid`
        )
      ).toEqual({ state: 'waiting', decision_id: null, last_failure: 'quota' })
    })

    it('settles a mail only once every part is filed, scrubbed to ids', async () => {
      const mail = await heldMail()
      const [work] = await inTenant(() => filing.findFilingWork(projectId, [mail.mailId]))
      expect(work!.decisions.size).toBe(2)
      expect(await inTenant(() => filing.settleFiledMail(work!.mail, false))).toBe(false)

      const thread = await document('Settle.md')
      const doc = await document('Settle.pdf')
      await inTenant(() =>
        filing.markAttachmentFiled(mail.filePart, mail.fileDecision, {
          documentId: doc.id,
          versionId: doc.versionId,
          erasureDeferred: false,
        })
      )
      const commit = newThreadCommit(
        mail,
        { id: crypto.randomUUID(), documentId: thread.id, versionId: thread.versionId },
        { documentId: doc.id, versionId: doc.versionId }
      )
      await inTenant(() => write.commitAppend(commit))
      await inTenant(() => write.forgetMovedRaw(mail.mailId))
      const [fresh] = await inTenant(() => filing.findFilingWork(projectId, [mail.mailId]))

      expect(await inTenant(() => filing.settleFiledMail(fresh!.mail, false))).toBe(true)
      expect(
        await one(
          sql`SELECT status, sender_address, subject, raw_storage_key, read_storage_key FROM inbound_mails WHERE id = ${mail.mailId}::uuid`
        )
      ).toEqual({
        status: 'settled',
        sender_address: null,
        subject: null,
        raw_storage_key: null,
        read_storage_key: null,
      })
      expect(await inTenant(() => filing.projectIsHeld(projectId, ORG))).toBe(false)
    })
  })

  describe('the newest Fassung the filer may read', () => {
    it('answers each document’s newest version and when it was made, and nothing of a document held from them', async () => {
      const doc = await document('Versions.pdf')
      const second = await one<{ id: string }>(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
        VALUES (${ORG}, ${doc.id}::uuid, ${projectId}::uuid, 2, 'superseded', ${`k/${STAMP}/v2`}, ${USER}, ${USER}, now()) RETURNING id`)
      const held = await document('Held.pdf')
      await rows(
        sql`UPDATE documents SET status = 'quarantined', created_by = ${OTHER_USER} WHERE id = ${held.id}::uuid`
      )
      const versions = await inTenant(() =>
        write.findCurrentVersions([doc.id, held.id], reader.memberReader(USER))
      )
      expect(versions.get(doc.id)).toMatchObject({ versionId: second.id })
      expect(versions.has(held.id)).toBe(false)
      expect(
        (
          await inTenant(() =>
            write.findVersionTimes([doc.versionId, held.versionId], reader.memberReader(USER))
          )
        ).size
      ).toBe(1)
    })
  })
})

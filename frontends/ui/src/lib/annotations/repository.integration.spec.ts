/**
 * @vitest-environment node
 *
 * Anmerkungen rows (migration 0138) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/annotations/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - numbers run per document, and ten writers at once get ten numbers; a
 *     batch of proposals takes consecutive numbers;
 *   - a person's mark is born open and Piloti's proposed, and the database
 *     refuses Piloti's mark as open without a person who took it over; a
 *     mark the asker asked Piloti for is born open with the asker behind it;
 *   - the Fassung a mark was set on comes back by number, and a discarded
 *     version leaves the mark standing;
 *   - a status move is compare-and-swap: the second of two moves from the same
 *     state finds nothing to move;
 *   - a thread comes back in order and goes with its mark;
 *   - one reply is deleted alone, and only while it still says what the caller
 *     read (undo's compare-and-swap); another mark's reply with the same id is
 *     not touched;
 *   - another organization reads none of them and cannot plant one on this
 *     organization's document;
 *   - a wake of Piloti (migration 0139, ADR-0106) is recorded and queued in
 *     the reply's transaction, and a reply that rolls back leaves neither; the
 *     caps count the recorded wakes; a delegation is both columns or neither,
 *     only on an open mark, and Piloti's reply leaves it alone.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_annotations_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_annotations_${STAMP}`

describe('the Anmerkungen suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Anmerkungen against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let wake: typeof import('./wake')
  let wakeIds: typeof import('./wake-ids')
  let takeBack: typeof import('./take-back')
  const ids = { project: '', document: '', second: '', v1: '', v2: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_ann_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(projectId: string, filename: string): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_ann_${projectId}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  async function version(documentId: string, number: number, state: 'published' | 'superseded'): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${documentId}::uuid, ${ids.project}::uuid, ${number}, ${state}, ${`k/${STAMP}/v${number}`},
                  ${`sha256:${STAMP}${number}`}, ${USER}, ${USER}, now()) returning id`)
      )
    )
  }

  const mark = (extra: Partial<import('./repository').NewAnnotationValues> = {}) => ({
    page: 1,
    shape: 'point' as const,
    x: 0.5,
    y: 0.5,
    w: null,
    h: null,
    kind: 'hint' as const,
    body: 'Stiegenbreite prüfen',
    basis: null,
    assigneeUserId: null,
    dueOn: null,
    ...extra,
  })

  const insert = (
    documentId: string,
    marks = [mark()],
    extra: Partial<import('./repository').NewAnnotationsInput> = {}
  ) =>
    inOrg(extra.organizationId ?? ORG, () =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId,
        versionId: null,
        authorKind: 'person',
        createdBy: USER,
        marks,
        ...extra,
      })
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    wake = await import('./wake')
    wakeIds = await import('./wake-ids')
    takeBack = await import('./take-back')
    ids.project = await project(ORG, 'Wohnbau')
    await project(OTHER_ORG, 'Fremd')
    ids.document = await document(ids.project, 'EG_Grundriss.pdf')
    ids.second = await document(ids.project, 'OG_Grundriss.pdf')
    ids.v1 = await version(ids.document, 1, 'superseded')
    ids.v2 = await version(ids.document, 2, 'published')
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from bff_job_queue where lane = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('numbers per document, ten writers at once get ten numbers, and a batch takes consecutive ones', async () => {
    await insert(ids.second)
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, index) => insert(ids.document, [mark({ body: `Mark ${index}` })]))
    )
    expect(
      rows
        .flat()
        .map((row) => row.number)
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const batch = await insert(ids.document, [mark({ body: 'a' }), mark({ body: 'b' }), mark({ body: 'c' })], {
      authorKind: 'piloti',
    })
    expect(batch.map((row) => [row.number, row.status, row.authorKind])).toEqual([
      [11, 'proposed', 'piloti'],
      [12, 'proposed', 'piloti'],
      [13, 'proposed', 'piloti'],
    ])
    const second = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, ids.second))
    expect(second.map((row) => [row.number, row.status])).toEqual([[1, 'open']])
  })

  it('stores a region, and refuses one off its page', async () => {
    const [region] = await insert(ids.document, [mark({ shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })])
    expect(region).toMatchObject({ shape: 'region', w: 0.3, h: 0.4 })
    await expect(insert(ids.document, [mark({ shape: 'region', x: 0.8, y: 0.2, w: 0.3, h: 0.4 })])).rejects.toThrow()
  })

  it("refuses Piloti's mark as the office's own until a person took it over", async () => {
    const [proposal] = await insert(ids.document, [mark()], { authorKind: 'piloti' })
    await expect(
      inOrg(ORG, () => db.execute(sql`update document_annotations set status = 'open' where id = ${proposal.id}::uuid`))
    ).rejects.toThrow()

    const taken = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, proposal.id, 'proposed', {
        transition: { status: 'open', acceptedBy: USER, acceptedAt: new Date(), closedBy: null, closedAt: null },
      })
    )
    expect(taken).toMatchObject({ status: 'open', acceptedBy: USER })
  })

  it('sets a mark the asker asked Piloti for open, with the asker behind it, and closes it in their name', async () => {
    const [row] = await insert(ids.document, [mark()], { authorKind: 'piloti', acceptedBy: USER })
    expect(row).toMatchObject({ status: 'open', authorKind: 'piloti', createdBy: USER, acceptedBy: USER })
    expect(row.acceptedAt).toBeInstanceOf(Date)

    const resolved = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
        transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
      })
    )
    expect(resolved).toMatchObject({ status: 'resolved', closedBy: USER, acceptedBy: USER })

    // The CHECK is untouched: Piloti's open mark with nobody behind it is still refused.
    await expect(
      inOrg(ORG, () =>
        db.execute(sql`
          update document_annotations
          set status = 'open', closed_by = null, closed_at = null, accepted_by = null, accepted_at = null
          where id = ${row.id}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('moves a status by compare and swap: the second move from the same state finds nothing', async () => {
    const [row] = await insert(ids.document)
    const resolve = () =>
      inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
          transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
        })
      )
    expect(await resolve()).toMatchObject({ status: 'resolved' })
    expect(await resolve()).toBeNull()
    await expect(
      inOrg(ORG, () =>
        db.execute(sql`update document_annotations set closed_by = null, closed_at = null where id = ${row.id}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('reads the Fassung number it was set on, and keeps the mark when that version goes', async () => {
    const [onOld] = await insert(ids.document, [mark()], { versionId: ids.v1 })
    const [onNew] = await insert(ids.document, [mark()], { versionId: ids.v2 })
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id)))?.fassungNumber).toBe(1)
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onNew.id)))?.fassungNumber).toBe(2)

    await inOrg(ORG, () => db.execute(sql`delete from document_versions where id = ${ids.v1}::uuid`))
    const after = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id))
    expect(after).toMatchObject({ versionId: null, fassungNumber: null })
  })

  it('keeps a thread in order, touches the mark, and lets the thread go with its mark', async () => {
    const [row] = await insert(ids.document)
    for (const body of ['Erste', 'Zweite', 'Dritte']) {
      await inOrg(ORG, () =>
        repo.insertAnnotationReply({ organizationId: ORG, annotationId: row.id, authorKind: 'person', body, createdBy: USER })
      )
    }
    const found = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
    expect(found?.replies.map((reply) => reply.body)).toEqual(['Erste', 'Zweite', 'Dritte'])
    expect(found!.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime())

    await inOrg(ORG, () => repo.deleteDocumentAnnotation(ORG, ids.document, row.id))
    const left = await inOrg(ORG, () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from document_annotation_replies where annotation_id = ${row.id}::uuid`
      )
    )
    expect(Number(Array.from(left)[0]?.n)).toBe(0)
  })

  it('deletes one reply alone, and only while its body is what the caller read', async () => {
    const [row] = await insert(ids.document)
    const [other] = await insert(ids.document)
    const post = (annotationId: string, body: string) =>
      inOrg(ORG, () =>
        repo.insertAnnotationReply({ organizationId: ORG, annotationId, authorKind: 'piloti', body, createdBy: USER })
      )
    const keep = await post(row.id, 'Bleibt')
    const gone = await post(row.id, 'Geht')
    const elsewhere = await post(other.id, 'Anderswo')
    const bodies = async (annotationId: string) =>
      (await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, annotationId)))?.replies.map((reply) => reply.body)

    // The body moved since the caller read it: nothing goes.
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id, 'Anders'))).toBe(false)
    // The reply of another mark is not this mark's.
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, elsewhere.id))).toBe(false)
    // Another organization finds nothing.
    expect(await inOrg(OTHER_ORG, () => repo.deleteAnnotationReply(OTHER_ORG, row.id, gone.id))).toBe(false)
    expect(await bodies(row.id)).toEqual(['Bleibt', 'Geht'])

    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id, 'Geht'))).toBe(true)
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id))).toBe(false)
    expect(await bodies(row.id)).toEqual(['Bleibt'])
    expect(await bodies(other.id)).toEqual(['Anderswo'])
    expect(keep.id).not.toBe(gone.id)
  })

  it('shows another organization none of them, and refuses one planted on this document', async () => {
    expect(await inOrg(OTHER_ORG, () => repo.listDocumentAnnotations(OTHER_ORG, ids.document))).toEqual([])
    const leaked = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(
        sql`select (select count(*) from document_annotations) + (select count(*) from document_annotation_replies) as n`
      )
    )
    expect(Number(Array.from(leaked)[0]?.n)).toBe(0)

    await expect(insert(ids.document, [mark()], { organizationId: OTHER_ORG })).rejects.toThrow()
  })

  it('tallies the live marks of a listing page in one query, what is the reader’s, and nothing of a held upload', async () => {
    const { memberReader, REVIEWER_READER } = await import('@/lib/documents/visibility')
    const UPLOADER = `${USER}_uploader`
    const clean = await document(ids.project, 'Tally_Schnitt.pdf')
    const held = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.project}::uuid, 'project', 'Tally_gehalten.pdf', ${`k/${STAMP}/held`},
                  ${`proj_ann_${ids.project}`}, ${UPLOADER}, 'quarantined', 'quarantined') returning id`)
      )
    )
    await insert(clean, [mark(), mark({ assigneeUserId: USER })])
    await insert(clean, [mark({ assigneeUserId: USER })], { authorKind: 'piloti' })
    const closed = await insert(clean, [mark({ assigneeUserId: USER }), mark()])
    for (const [row, status] of [
      [closed[0], 'resolved'],
      [closed[1], 'dismissed'],
    ] as const) {
      await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, clean, row.id, 'open', {
          transition: { status, closedBy: USER, closedAt: new Date() },
        })
      )
    }
    await insert(held, [mark({ assigneeUserId: USER })], { createdBy: UPLOADER })

    const tally = (reader: Parameters<typeof repo.tallyLiveMarks>[2], organizationId = ORG) =>
      inOrg(organizationId, () => repo.tallyLiveMarks(organizationId, [clean, held, ids.second], reader, USER))

    // Two open and one proposal are live; only the open one assigned to USER is theirs (the proposal naming them is not yet).
    const member = await tally(memberReader(USER))
    expect(member.get(clean)).toEqual({ live: 3, forYou: 1 })
    expect(member.has(held)).toBe(false)
    expect(member.get(ids.second)?.live).toBeGreaterThan(0)
    // The uploader and the reviewers see the held upload's marks, as they see the upload.
    expect((await tally(memberReader(UPLOADER))).get(held)).toEqual({ live: 1, forYou: 1 })
    expect((await tally(REVIEWER_READER)).get(held)).toEqual({ live: 1, forYou: 1 })
    expect(await inOrg(OTHER_ORG, () => repo.tallyLiveMarks(OTHER_ORG, [clean, held], memberReader(USER), USER))).toEqual(
      new Map()
    )
  })

  describe('waking Piloti (migration 0139)', () => {
    const count = async (query: ReturnType<typeof sql>) =>
      Number(Array.from(await inOrg(ORG, () => db.execute<{ n: number }>(query)))[0]?.n)
    const event = (annotationId: string, eventId: string) => ({
      organizationId: ORG,
      documentId: ids.document,
      annotationId,
      trigger: 'thread_mention' as const,
      eventId,
      actor: { userId: USER, email: null },
    })

    it('records the wake and queues its job in the reply’s transaction, under one id', async () => {
      const [row] = await insert(ids.document)
      const reply = await inOrg(ORG, () =>
        repo.insertAnnotationReply(
          { organizationId: ORG, annotationId: row.id, authorKind: 'person', body: '@Piloti?', createdBy: USER, addressesAgent: true },
          async (tx, inserted) => {
            await wake.enqueueWake(tx, event(row.id, inserted.id))
          }
        )
      )
      expect(reply.addressesAgent).toBe(true)
      const id = wakeIds.wakeTurnId(reply.id)
      expect(await count(sql`select count(*)::int as n from piloti_wakes where id = ${id}::uuid and status = 'queued'`)).toBe(1)
      expect(
        await count(sql`select count(*)::int as n from bff_job_queue where job_id = ${id}::uuid and kind = 'piloti_wake'`)
      ).toBe(1)
    })

    it('leaves no wake and no job when the reply rolls back', async () => {
      const [row] = await insert(ids.document)
      let wakeId = ''
      await expect(
        inOrg(ORG, () =>
          repo.insertAnnotationReply(
            { organizationId: ORG, annotationId: row.id, authorKind: 'person', body: '@Piloti?', createdBy: USER, addressesAgent: true },
            async (tx, inserted) => {
              wakeId = wakeIds.wakeTurnId(inserted.id)
              await wake.enqueueWake(tx, event(row.id, inserted.id))
              throw new Error('the write failed after the wake was enqueued')
            }
          )
        )
      ).rejects.toThrow(/after the wake/)
      expect(wakeId).not.toBe('')
      expect(await count(sql`select count(*)::int as n from piloti_wakes where id = ${wakeId}::uuid`)).toBe(0)
      expect(await count(sql`select count(*)::int as n from bff_job_queue where job_id = ${wakeId}::uuid`)).toBe(0)
      expect(await count(sql`select count(*)::int as n from document_annotation_replies where annotation_id = ${row.id}::uuid`)).toBe(0)
    })

    it('counts the wakes it let through against the cap, and records the one it held', async () => {
      const [row] = await insert(ids.document)
      const limits = { perMarkHour: 2, perPersonDay: 50 }
      const outcomes = []
      for (const n of [1, 2, 3]) {
        outcomes.push(
          await inOrg(ORG, () => db.transaction((tx) => wake.enqueueWake(tx, event(row.id, `cap-${STAMP}-${n}`), { limits })))
        )
      }
      expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['queued', 'queued', 'suppressed'])
      expect(
        await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid and status = 'suppressed' and reason = 'cap:mark-hour' and settled_at is not null`)
      ).toBe(1)
      // The same event a second time is not a second wake.
      const again = await inOrg(ORG, () => db.transaction((tx) => wake.enqueueWake(tx, event(row.id, `cap-${STAMP}-1`), { limits: { perMarkHour: 9, perPersonDay: 50 } })))
      expect(again.outcome).toBe('queued')
      expect(await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid`)).toBe(3)
    })

    it('refuses a wake record that says it did not start without saying why', async () => {
      const [row] = await insert(ids.document)
      await expect(
        inOrg(ORG, () =>
          db.execute(sql`
            insert into piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, settled_at)
            values (gen_random_uuid(), ${ORG}, ${ids.document}::uuid, ${row.id}::uuid, 'thread_mention', 'e', ${USER}, 'refused', now())`)
        )
      ).rejects.toThrow()
    })

    it('keeps a delegation whole, on an open mark only, and a reply of Piloti’s does not hand it back', async () => {
      const [row] = await insert(ids.document)
      const delegated = await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
          delegation: { delegatedBy: USER, delegatedAt: new Date() },
        })
      )
      expect(delegated).toMatchObject({ delegatedBy: USER })
      await expect(
        inOrg(ORG, () => db.execute(sql`update document_annotations set delegated_at = null where id = ${row.id}::uuid`))
      ).rejects.toThrow()
      await expect(
        inOrg(ORG, () =>
          db.execute(sql`update document_annotations set status = 'resolved', closed_by = ${USER}, closed_at = now() where id = ${row.id}::uuid`)
        )
      ).rejects.toThrow()

      await inOrg(ORG, () =>
        repo.insertAnnotationReply({
          organizationId: ORG,
          annotationId: row.id,
          authorKind: 'piloti',
          body: 'Erledigt.',
          createdBy: USER,
        })
      )
      const after = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
      expect(after).toMatchObject({ delegatedBy: USER, delegatedAt: expect.any(Date) })
    })

    it('queues the stop of a started delegation wake in the delete’s transaction, before the wake goes with its mark', async () => {
      const [row] = await insert(ids.document)
      const delegatedAt = new Date()
      await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(
          ORG,
          ids.document,
          row.id,
          'open',
          { delegation: { delegatedBy: USER, delegatedAt } },
          async (tx) => {
            await wake.enqueueWake(tx, {
              ...event(row.id, wakeIds.delegationEventId(row.id, delegatedAt)),
              trigger: 'assigned',
            })
          }
        )
      )
      await inOrg(ORG, () =>
        db.execute(sql`update piloti_wakes set status = 'started', settled_at = now() where annotation_id = ${row.id}::uuid`)
      )

      await inOrg(ORG, () =>
        repo.deleteDocumentAnnotation(ORG, ids.document, row.id, async (tx) => {
          await takeBack.readTakeBack(
            tx,
            { organizationId: ORG, documentId: ids.document, annotationId: row.id, delegatedAt },
            { stopTurn: true }
          )
        })
      )

      expect(await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid`)).toBe(0)
      expect(
        await count(
          sql`select count(*)::int as n from bff_job_queue where kind = 'piloti_wake_stop' and payload->>'annotationId' = ${row.id}`
        )
      ).toBe(1)
    })

    it('shows another organization none of the wakes', async () => {
      const leaked = await inOrg(OTHER_ORG, () =>
        db.execute<{ n: number }>(sql`select count(*)::int as n from piloti_wakes`)
      )
      expect(Number(Array.from(leaked)[0]?.n)).toBe(0)
    })
  })
})

/**
 * Opt-in integration test: the project mail inbox's tables against a REAL
 * Postgres with every migration applied, connected as `grid_app_rw` (ADR-0041).
 *
 * The unit specs show the service asks the right questions. Only this shows
 * the database refuses the wrong ones: that a token names one row across every
 * tenant, that one tenant cannot read or point at another's address or folder,
 * that the delivery key is unique per address and not per mail, and that the
 * drain's claim is fenced: a stale attempt cannot write over a newer one. The
 * backoff, the reaper and the retention sweeps are asserted here too, because
 * each is a claim about a WHERE clause.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbound-mail/repository.integration.spec.ts
 *
 * `task db:test:rls` builds the database and runs this file.
 */

import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const STAMP = Date.now()
const ORG_A = `org_mail_a_${STAMP}`
const ORG_B = `org_mail_b_${STAMP}`
// Distinct per run, and valid base32 (a-z, 2-7): the token index is global.
const suffix = STAMP.toString(32).replace(/[01]/g, 'z').replace(/[89]/g, 'y').slice(-6).padStart(6, 'q')
const TOKEN_A = `aaaaaa${suffix}`.slice(0, 12)
const TOKEN_B = `bbbbbb${suffix}`.slice(0, 12)
const KEY = 'f'.repeat(64)

function rootCause(error: unknown): Error & { code?: string } {
  let current = error as Error
  while (current?.cause instanceof Error) current = current.cause
  return current
}

async function refusal(run: () => PromiseLike<unknown>): Promise<Error & { code?: string }> {
  try {
    await run()
  } catch (error) {
    return rootCause(error)
  }
  throw new Error('expected the statement to be refused, but it succeeded')
}

describe.skipIf(!url)('inbound mail tables against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let context: typeof import('@/lib/db/tenant-context')
  let repo: typeof import('./repository')
  type NewDelivery = import('./repository').NewDelivery
  const projectOf: Record<string, string> = {}
  const addressOf: Record<string, string> = {}
  let bareProjectB = ''

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    context = await import('@/lib/db/tenant-context')
    repo = await import('./repository')
    db = (await import('@/lib/db')).getDb()

    for (const [org, token] of [
      [ORG_A, TOKEN_A],
      [ORG_B, TOKEN_B],
    ] as const) {
      await context.withPlatformAccess('test seed: organizations', () =>
        db.execute(
          sql`insert into organizations (workos_organization_id, display_name) values (${org}, ${org}) on conflict do nothing`
        )
      )
      await context.withTenant({ organizationId: org }, async () => {
        // The SAME project name in both tenants, so both slugs are `wohnbau`.
        const [project] = (await db.execute(
          sql`insert into projects (organization_id, name, created_by, collection_name)
              values (${org}, 'Wohnbau', 'user-seed', ${'coll_' + org}) returning id`
        )) as unknown as { id: string }[]
        projectOf[org] = String(project.id)
        const inserted = await repo.insertAddress({
          organizationId: org,
          projectId: projectOf[org],
          token,
          slug: 'wohnbau',
          createdBy: 'user-seed',
        })
        if (!inserted.ok) throw new Error(`seed address for ${org}: ${inserted.conflict}`)
        addressOf[org] = inserted.row.id
      })
    }
    // A project in org B with no address yet, so a cross-tenant insert below
    // meets the foreign key and not the one-active-address index.
    await context.withTenant({ organizationId: ORG_B }, async () => {
      const [bare] = (await db.execute(
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG_B}, 'Ohne Adresse', 'user-seed', ${'coll_bare_' + ORG_B}) returning id`
      )) as unknown as { id: string }[]
      bareProjectB = String(bare.id)
    })
  })

  afterAll(async () => {
    if (!db) return
    await context.withPlatformAccess('test teardown', async () => {
      await db.execute(sql`delete from projects where organization_id in (${ORG_A}, ${ORG_B})`)
      await db.execute(sql`delete from organizations where workos_organization_id in (${ORG_A}, ${ORG_B})`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('resolves a token to its own organization, under the platform bypass only', async () => {
    const found = await context.withPlatformAccess('test: token lookup', () => repo.findActiveAddressByToken(TOKEN_A))
    expect(found).toEqual({ addressId: addressOf[ORG_A], organizationId: ORG_A, projectId: projectOf[ORG_A] })

    // Inside another tenant the row simply is not there.
    const fromB = await context.withTenant({ organizationId: ORG_B }, () => repo.findActiveAddressByToken(TOKEN_A))
    expect(fromB).toBeNull()
  })

  it('refuses a second address with the same token, even in another organization', async () => {
    const result = await context.withTenant({ organizationId: ORG_B }, () =>
      repo.insertAddress({
        organizationId: ORG_B,
        projectId: projectOf[ORG_B],
        token: TOKEN_A,
        slug: 'wohnbau',
        createdBy: 'user-seed',
      })
    )
    // The active-per-project index can fire first; either way nothing was written.
    expect(result.ok).toBe(false)
  })

  it('refuses an address row that names another tenant’s project', async () => {
    const cause = await refusal(() =>
      context.withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into inbound_mail_addresses (organization_id, project_id, token, slug, created_by)
              values (${ORG_A}, ${bareProjectB}, 'cccccccccccc', '', 'x')`
        )
      )
    )
    expect(cause.code).toBe('23503')
  })

  it('refuses a message row that points at another tenant’s address', async () => {
    const cause = await refusal(() =>
      context.withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into inbound_mail_messages (organization_id, project_id, address_id, delivery_key, sender_user_id, folder_name)
              values (${ORG_A}, ${projectOf[ORG_A]}, ${addressOf[ORG_B]}, ${KEY}, 'user-anna', 'x')`
        )
      )
    )
    expect(cause.code).toBe('23503')
  })

  it('refuses a message row that files into another project’s folder', async () => {
    const [folder] = (await context.withTenant({ organizationId: ORG_B }, () =>
      db.execute(
        sql`insert into project_folders (project_id, name, path) values (${projectOf[ORG_B]}, 'Fremd', 'Fremd') returning id`
      )
    )) as unknown as { id: string }[]
    const cause = await refusal(() =>
      context.withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into inbound_mail_messages (organization_id, project_id, address_id, delivery_key, sender_user_id, folder_name, folder_id)
              values (${ORG_A}, ${projectOf[ORG_A]}, ${addressOf[ORG_A]}, ${'9'.repeat(64)}, 'user-anna', 'x', ${folder.id})`
        )
      )
    )
    expect(cause.code).toBe('23503')
  })

  it('keeps the claim token and the status in step, and a staged object never without its bucket', async () => {
    const insert = (status: string, token: string | null, staged: string, bucket: string | null) =>
      refusal(() =>
        context.withTenant({ organizationId: ORG_A }, () =>
          db.execute(
            sql`insert into inbound_mail_messages
                  (organization_id, project_id, address_id, delivery_key, sender_user_id, folder_name, status, claim_token, staged, staging_bucket)
                values (${ORG_A}, ${projectOf[ORG_A]}, ${addressOf[ORG_A]}, ${'8'.repeat(64)}, 'user-anna', 'x',
                        ${status}, ${token}, ${staged}::jsonb, ${bucket})`
          )
        )
      )
    expect((await insert('processing', null, '[]', null)).code).toBe('23514')
    expect((await insert('queued', randomUUID(), '[]', null)).code).toBe('23514')
    expect((await insert('queued', null, '[{"key":"k"}]', null)).code).toBe('23514')
  })

  describe('deliveries', () => {
    let seq = 0
    /** A fresh delivery key per test, so the tests do not see each other's rows. */
    const freshKey = () => createHash('sha256').update(`${STAMP}-${(seq += 1)}`).digest('hex')

    const queue = (org: string, key: string, overrides: Partial<NewDelivery> = {}) =>
      context.withTenant({ organizationId: org }, () =>
        repo.queueDelivery({
          id: randomUUID(),
          addressId: addressOf[org],
          organizationId: org,
          projectId: projectOf[org],
          deliveryKey: key,
          senderUserId: 'user-anna',
          folderName: '2026-09-30 10.15 – Anna Berger',
          subject: 'Pläne',
          stagingBucket: 'grid-documents',
          staged: [{ key: 'org/x/project/y/inbound-mail/z/1', filename: 'Plan.pdf', contentType: 'application/pdf', sha256: 'a'.repeat(64), size: 3 }],
          skipped: [{ filename: 'image001.png', reason: 'embedded' }],
          receivedAt: new Date(),
          ...overrides,
        })
      )

    const read = (id: string) =>
      context.withPlatformAccess('test: read a delivery', async () => {
        const [row] = (await db.execute(
          sql`select status, claim_token, attempts, next_attempt_at > now() as backed_off, subject, staged, skipped,
                     filed_count, skipped_count, last_error, folder_id
                from inbound_mail_messages where id = ${id}`
        )) as unknown as Record<string, unknown>[]
        return row
      })

    /** Only `id` is due: every other queued row of these tenants waits a day. */
    const onlyDue = (id: string) =>
      context.withPlatformAccess('test: make one delivery due', () =>
        db.execute(sql`update inbound_mail_messages set next_attempt_at = case when id = ${id} then now() - interval '1 second'
                         else now() + interval '1 day' end
                       where organization_id in (${ORG_A}, ${ORG_B}) and status = 'queued'`)
      )

    const claim = () => context.withPlatformAccess('test: claim', () => repo.claimNextDelivery())

    it('keys a delivery by address: the same mail twice at one address is one row', async () => {
      const key = freshKey()
      const first = await queue(ORG_A, key)
      expect(first).toEqual(expect.any(String))
      expect(await queue(ORG_A, key)).toBeNull()
      expect(await context.withTenant({ organizationId: ORG_A }, () => repo.findDelivery(addressOf[ORG_A], key))).toEqual({
        id: first,
        status: 'queued',
      })
    })

    it('one mail to two organizations is queued, and filed, twice', async () => {
      const key = freshKey()
      const a = await queue(ORG_A, key)
      const b = await queue(ORG_B, key)
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect(a).not.toBe(b)

      for (const [org, id] of [[ORG_A, a], [ORG_B, b]] as const) {
        await onlyDue(id!)
        const claimed = await claim()
        expect(claimed).toMatchObject({ id, organizationId: org, status: 'processing', attempts: 1 })
        const filed = await context.withTenant({ organizationId: org }, () =>
          repo.markDeliveryFiled(claimed!.id, claimed!.claimToken, { filedCount: 1, skipped: [], remaining: [] })
        )
        expect(filed).toBe(true)
      }
      expect((await read(a!)).status).toBe('filed')
      expect((await read(b!)).status).toBe('filed')
    })

    it('takes over a row that was given up on, keeping its id and folder', async () => {
      const key = freshKey()
      const id = await queue(ORG_A, key)
      await onlyDue(id!)
      const first = await claim()
      await context.withTenant({ organizationId: ORG_A }, () =>
        repo.markDeliveryFailed(first!.id, first!.claimToken, { filedCount: 0, skipped: [], remaining: [], lastError: 'x' })
      )
      expect(await queue(ORG_A, key, { subject: 'Nochmal' })).toBe(id)
      expect(await read(id!)).toMatchObject({ status: 'queued', attempts: 0, subject: 'Nochmal', last_error: null })
    })

    it('fences every write of an attempt on its claim token: a stale owner cannot overwrite a newer claim', async () => {
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const stale = await claim()
      expect(stale?.id).toBe(id)

      // The first attempt stalls past the window; the reaper hands the row back.
      await context.withPlatformAccess('test: age the heartbeat', () =>
        db.execute(sql`update inbound_mail_messages set updated_at = now() - interval '11 minutes' where id = ${id}`)
      )
      expect(await context.withPlatformAccess('test: reap', () => repo.reapStaleClaims())).toBeGreaterThanOrEqual(1)
      await onlyDue(id!)
      const fresh = await claim()
      expect(fresh?.id).toBe(id)
      expect(fresh?.claimToken).not.toBe(stale?.claimToken)
      expect(fresh?.attempts).toBe(2)

      // The slow original wakes up and tries every write it has. None lands.
      const inA = <T>(fn: () => Promise<T>) => context.withTenant({ organizationId: ORG_A }, fn)
      const token = stale!.claimToken
      expect(await inA(() => repo.heartbeat(id!, token))).toBe(false)
      expect(await inA(() => repo.recordDeliveryFolder(id!, token, randomUUID()))).toBe(false)
      expect(await inA(() => repo.scheduleRetry(id!, token, 60, 'x'))).toBe(false)
      expect(await inA(() => repo.releaseClaim(id!, token, 60))).toBe(false)
      expect(await inA(() => repo.markDeliveryFailed(id!, token, { filedCount: 0, skipped: [], remaining: [] }))).toBe(false)
      expect(await inA(() => repo.markDeliveryFiled(id!, token, { filedCount: 9, skipped: [], remaining: [] }))).toBe(false)
      expect(await read(id!)).toMatchObject({ status: 'processing', claim_token: fresh!.claimToken, filed_count: 0 })

      // …while the attempt that owns it still can.
      expect(await inA(() => repo.heartbeat(id!, fresh!.claimToken))).toBe(true)
    })

    it('reaps only attempts whose heartbeat stopped', async () => {
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const live = await claim()
      await context.withPlatformAccess('test: reap', () => repo.reapStaleClaims())
      expect(await read(id!)).toMatchObject({ status: 'processing', claim_token: live!.claimToken })

      await context.withPlatformAccess('test: age the heartbeat', () =>
        db.execute(sql`update inbound_mail_messages set updated_at = now() - interval '11 minutes' where id = ${id}`)
      )
      await context.withPlatformAccess('test: reap', () => repo.reapStaleClaims())
      expect(await read(id!)).toMatchObject({ status: 'queued', claim_token: null, attempts: 1, last_error: 'stale-claim' })
    })

    it('backs off: a retried row is not claimed before its time', async () => {
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const first = await claim()
      await context.withTenant({ organizationId: ORG_A }, () => repo.scheduleRetry(id!, first!.claimToken, 300, 'NotFoundError'))
      expect(await read(id!)).toMatchObject({ status: 'queued', claim_token: null, backed_off: true, last_error: 'NotFoundError' })

      await context.withPlatformAccess('test: park the rest', () =>
        db.execute(sql`update inbound_mail_messages set next_attempt_at = now() + interval '1 day'
                       where organization_id in (${ORG_A}, ${ORG_B}) and status = 'queued' and id <> ${id}`)
      )
      expect(await claim()).toBeNull()
      await onlyDue(id!)
      expect((await claim())?.attempts).toBe(2)
    })

    it('a hold gives the attempt back', async () => {
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const first = await claim()
      await context.withTenant({ organizationId: ORG_A }, () => repo.releaseClaim(id!, first!.claimToken, 3600))
      expect(await read(id!)).toMatchObject({ status: 'queued', attempts: 0, backed_off: true, last_error: 'held' })
    })

    it('a finished row keeps counts and reason codes, and drops the subject and every name', async () => {
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const first = await claim()
      await context.withTenant({ organizationId: ORG_A }, () =>
        repo.markDeliveryFiled(id!, first!.claimToken, {
          filedCount: 1,
          skipped: [{ filename: 'image001.png', reason: 'embedded' }, { filename: 'a.exe', reason: 'type' }],
          remaining: [],
        })
      )
      expect(await read(id!)).toMatchObject({
        status: 'filed',
        claim_token: null,
        subject: null,
        staged: [],
        skipped: [{ reason: 'embedded' }, { reason: 'type' }],
        filed_count: 1,
        skipped_count: 2,
      })
    })

    it('forgets a folder that was deleted, so the next attempt makes a new one', async () => {
      const [folder] = (await context.withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into project_folders (project_id, name, path) values (${projectOf[ORG_A]}, ${`Mail ${STAMP}`}, ${`Mail ${STAMP}`}) returning id`
        )
      )) as unknown as { id: string }[]
      const id = await queue(ORG_A, freshKey())
      await onlyDue(id!)
      const first = await claim()
      await context.withTenant({ organizationId: ORG_A }, () => repo.recordDeliveryFolder(id!, first!.claimToken, folder.id))
      expect((await read(id!)).folder_id).toBe(folder.id)
      await context.withTenant({ organizationId: ORG_A }, () => db.execute(sql`delete from project_folders where id = ${folder.id}`))
      expect(await read(id!)).toMatchObject({ folder_id: null, status: 'processing' })
    })

    it('retention: staging past seven days is found, a queued row with it fails, and rows past thirty days go', async () => {
      const old = await queue(ORG_A, freshKey())
      const filedOld = await queue(ORG_A, freshKey(), { staged: [], stagingBucket: null })
      const young = await queue(ORG_A, freshKey())
      await context.withPlatformAccess('test: age the rows', () =>
        db.execute(sql`update inbound_mail_messages set received_at = now() - interval '8 days' where id = ${old}`)
      )
      await context.withPlatformAccess('test: age the rows', () =>
        db.execute(sql`update inbound_mail_messages set received_at = now() - interval '31 days', status = 'filed' where id = ${filedOld}`)
      )

      const expired = await context.withPlatformAccess('test: expired staging', () => repo.findExpiredStaging(100))
      const ids = expired.map((row) => row.id)
      expect(ids).toContain(old)
      expect(ids).not.toContain(young)

      const row = expired.find((candidate) => candidate.id === old)!
      expect(await context.withTenant({ organizationId: ORG_A }, () => repo.clearExpiredStaging(row, []))).toBe(true)
      expect(await read(old!)).toMatchObject({ status: 'failed', staged: [], subject: null, last_error: 'staging-expired' })

      // A thirty-day-old row that still names staged objects is kept until they are gone.
      await context.withPlatformAccess('test: age the rows', () =>
        db.execute(sql`update inbound_mail_messages set received_at = now() - interval '31 days' where id = ${young}`)
      )
      await context.withPlatformAccess('test: retention', () => repo.deleteDeliveriesOlderThan())
      expect(await read(filedOld!)).toBeUndefined()
      expect(await read(young!)).toMatchObject({ status: 'queued' })
    })
  })

  it('rotation revokes the old token: it resolves to nothing, like an unknown one', async () => {
    const rotated = await context.withTenant({ organizationId: ORG_B }, () =>
      repo.rotateAddress({
        organizationId: ORG_B,
        projectId: projectOf[ORG_B],
        token: `dddddd${suffix}`.slice(0, 12),
        slug: 'wohnbau',
        createdBy: 'user-seed',
        revokedBy: 'user-seed',
      })
    )
    expect(rotated.ok).toBe(true)

    const lookup = (token: string) =>
      context.withPlatformAccess('test: token lookup', () => repo.findActiveAddressByToken(token))
    expect(await lookup(TOKEN_B)).toBeNull()
    expect(await lookup(`dddddd${suffix}`.slice(0, 12))).toMatchObject({ organizationId: ORG_B })
  })

  it('a soft-deleted project’s token resolves to nothing', async () => {
    await context.withTenant({ organizationId: ORG_A }, () =>
      db.execute(sql`update projects set deleted_at = now() where id = ${projectOf[ORG_A]}`)
    )
    const found = await context.withPlatformAccess('test: token lookup', () => repo.findActiveAddressByToken(TOKEN_A))
    expect(found).toBeNull()
  })

  it('both tables die with their project', async () => {
    await context.withPlatformAccess('test: purge', () =>
      db.execute(sql`delete from projects where id = ${projectOf[ORG_A]}`)
    )
    const [counts] = (await context.withPlatformAccess('test: count', () =>
      db.execute(sql`select
          (select count(*) from inbound_mail_addresses where project_id = ${projectOf[ORG_A]}) as addresses,
          (select count(*) from inbound_mail_messages where project_id = ${projectOf[ORG_A]}) as messages`)
    )) as unknown as { addresses: string | number; messages: string | number }[]
    expect(Number(counts.addresses)).toBe(0)
    expect(Number(counts.messages)).toBe(0)
  })
})

/**
 * Opt-in integration test: the project mail inbox's tables against a REAL
 * Postgres with every migration applied, connected as `grid_app_rw` (ADR-0041).
 *
 * The unit specs show the service asks the right questions. Only this shows
 * the database refuses the wrong ones: that a token names one row across every
 * tenant, that one tenant cannot read or point at another's address, and that
 * the idempotency key is the address and not the Message-ID alone.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/inbound-mail/repository.integration.spec.ts
 *
 * `task db:test:rls` builds the database and runs this file.
 */

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
const HASH = 'f'.repeat(64)

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
          sql`insert into inbound_mail_messages (organization_id, project_id, address_id, message_id_hash)
              values (${ORG_A}, ${projectOf[ORG_A]}, ${addressOf[ORG_B]}, ${HASH})`
        )
      )
    )
    expect(cause.code).toBe('23503')
  })

  it('keys idempotency by address: one Message-ID filed in two organizations is two deliveries', async () => {
    const claim = (org: string) =>
      context.withTenant({ organizationId: org }, () =>
        repo.claimMessage({
          addressId: addressOf[org],
          organizationId: org,
          projectId: projectOf[org],
          messageIdHash: HASH,
        })
      )

    const a = await claim(ORG_A)
    const b = await claim(ORG_B)
    expect(a.kind).toBe('claimed')
    expect(b.kind).toBe('claimed')

    // A second delivery while the first is still filing is busy, not a second claim.
    expect((await claim(ORG_A)).kind).toBe('busy')

    if (a.kind !== 'claimed' || b.kind !== 'claimed') throw new Error('unreachable')
    await context.withTenant({ organizationId: ORG_A }, () =>
      repo.markMessageFiled(a.messageRowId, { senderUserId: 'user-anna', filedCount: 2, skippedCount: 1 })
    )
    expect(await claim(ORG_A)).toEqual({ kind: 'duplicate', messageRowId: a.messageRowId, filedCount: 2 })

    await context.withTenant({ organizationId: ORG_B }, () => repo.markMessageFailed(b.messageRowId))
    expect(await claim(ORG_B)).toEqual({ kind: 'claimed', messageRowId: b.messageRowId })
  })

  it('takes over a processing row once it is stale', async () => {
    const hash = 'e'.repeat(64)
    const input = { addressId: addressOf[ORG_A], organizationId: ORG_A, projectId: projectOf[ORG_A], messageIdHash: hash }
    const first = await context.withTenant({ organizationId: ORG_A }, () => repo.claimMessage(input))
    expect(first.kind).toBe('claimed')

    const later = new Date(Date.now() + repo.STALE_PROCESSING_MS + 60_000)
    const takeover = await context.withTenant({ organizationId: ORG_A }, () => repo.claimMessage(input, later))
    expect(takeover.kind).toBe('claimed')
  })

  it('refuses a filed row without a sender', async () => {
    const cause = await refusal(() =>
      context.withTenant({ organizationId: ORG_A }, () =>
        db.execute(
          sql`insert into inbound_mail_messages (organization_id, project_id, address_id, message_id_hash, status)
              values (${ORG_A}, ${projectOf[ORG_A]}, ${addressOf[ORG_A]}, ${'d'.repeat(64)}, 'filed')`
        )
      )
    )
    expect(cause.code).toBe('23514')
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

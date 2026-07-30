/**
 * `listVisibleConversations` is the only place the visibility rule is expressed in
 * SQL, and getting it wrong is a data leak (ADR-0032, spec SH-4). So these tests
 * assert the **generated statement**, not a mock's arguments: the point is which
 * rows Postgres will hand back, and no amount of chain-spy assertion answers that.
 *
 * The DB is a drizzle `pg-proxy` instance — a real query builder over a callback
 * "driver" that records the SQL and parameters instead of connecting anywhere.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: [] }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import {
  CONVERSATION_LIST_LIMIT,
  deleteConversationInOrg,
  findMessageInConversation,
  listVisibleConversations,
  upsertConversationRead,
} from './repository'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

/** The one statement the call under test produced. */
function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

beforeEach(() => {
  captured.length = 0
})

describe('listVisibleConversations — scoped to a project', () => {
  it('keeps org tenancy and the legacy NULL-project fail-open rule', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('"conversations"."organization_id" = $1')
    expect(sql).toContain(
      '("conversations"."project_id" = $2 or "conversations"."project_id" is null)',
    )
    expect(params.slice(0, 2)).toEqual(['org_1', PROJECT_ID])
  })

  it('narrows ONLY private rows, because project access is already proven', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    // Anything not private is visible to someone who reaches the project;
    // private needs to be theirs or granted to them.
    expect(sql).toContain('"conversations"."visibility" <> $3')
    expect(sql).toContain('"conversations"."created_by" = $4')
    expect(params).toContain('private')
    expect(params.filter((param) => param === 'user_me')).toHaveLength(2)
  })

  it('resolves grants with ONE correlated subquery, not one check per row', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql } = onlyQuery()
    expect(sql).toContain('exists (select 1 from "resource_shares"')
    // Correlated on the outer row — this is what makes it a single round trip.
    expect(sql).toContain('"resource_shares"."resource_id" = "conversations"."id"')
    expect(sql).toContain('"resource_shares"."subject_user_id" = $7')
    // A grant row is tenant data like any other.
    expect(sql).toContain('"resource_shares"."organization_id" = $5')
    expect(sql).toContain('"resource_shares"."resource_type" = $6')
  })

  it('is bounded, newest first', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('order by "conversations"."updated_at" desc')
    expect(sql).toContain('limit $8')
    expect(params.at(-1)).toBe(CONVERSATION_LIST_LIMIT)
  })
})

describe('listVisibleConversations — no project scope', () => {
  it('returns only rows the caller owns, was granted, or that are org-visible', async () => {
    await listVisibleConversations('org_1', 'user_me')

    const { sql, params } = onlyQuery()
    // The deliberate tightening (spec MG-1): this list used to return the whole
    // organization, which is the defect ADR-0032 closes.
    expect(sql).toContain('"conversations"."organization_id" = $1')
    expect(sql).toContain('"conversations"."created_by" = $2')
    expect(sql).toContain('exists (select 1 from "resource_shares"')
    expect(sql).toContain('"conversations"."visibility" = $6')
    expect(params).toContain('organization')
    // No project claim is made, so no project predicate is applied either.
    expect(sql).not.toContain('"conversations"."project_id"')
    // And crucially: `project` visibility alone does NOT make the cut here.
    expect(params).not.toContain('project')
  })
})

describe('upsertConversationRead', () => {
  it('upserts on the (conversation, user) pair — one mark per person per thread', async () => {
    await upsertConversationRead({ conversationId: 'conv_1', userId: 'user_me' })

    const { sql } = onlyQuery()
    expect(sql).toContain('insert into "conversation_reads"')
    expect(sql).toContain('on conflict ("conversation_id","user_id") do update set')
  })

  it('keeps the stored anchor when the caller supplies no message id', async () => {
    await upsertConversationRead({ conversationId: 'conv_1', userId: 'user_me' })

    // A plain "I looked at this" must not erase the more precise mark that the
    // unread separator renders from (CC-19).
    expect(onlyQuery().sql).toContain(
      '"last_read_message_id" = "conversation_reads"."last_read_message_id"',
    )
  })

  it('moves the anchor when one IS supplied', async () => {
    await upsertConversationRead({
      conversationId: 'conv_1',
      userId: 'user_me',
      lastReadMessageId: 'msg_9',
    })

    const { sql, params } = onlyQuery()
    expect(sql).not.toContain('"conversation_reads"."last_read_message_id"')
    expect(params).toContain('msg_9')
  })
})

describe('deleteConversationInOrg', () => {
  it('carries tenancy in the WHERE clause, not only in the service above it', async () => {
    await deleteConversationInOrg('conv_1', 'org_1')

    const { sql, params } = onlyQuery()
    // Regression: deleting by id alone let any signed-in user delete another
    // org's conversation by guessing ids.
    expect(sql).toContain('"conversations"."id" = $1')
    expect(sql).toContain('"conversations"."organization_id" = $2')
    expect(params).toEqual(['conv_1', 'org_1'])
  })
})

describe('findMessageInConversation', () => {
  it('is scoped by BOTH ids, so a guessed id from another thread reads as absent', async () => {
    await findMessageInConversation('conv_1', 'msg_1')

    const { sql, params } = onlyQuery()
    expect(sql).toContain('"messages"."id" = $1')
    expect(sql).toContain('"messages"."conversation_id" = $2')
    expect(params.slice(0, 2)).toEqual(['msg_1', 'conv_1'])
  })
})

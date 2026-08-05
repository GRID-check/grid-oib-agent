/**
 * @vitest-environment node
 */
/**
 * `listVisibleConversations` is the only place the visibility rule is expressed in
 * SQL, and getting it wrong is a data leak (ADR-0032, spec SH-4). So these tests
 * assert the **generated statement**, not a mock's arguments: the point is which
 * rows Postgres will hand back, and no amount of chain-spy assertion answers that.
 *
 * The DB is a drizzle `pg-proxy` instance — a real query builder over a callback
 * "driver" that records the SQL and parameters instead of connecting anywhere.
 * The driver can also answer with canned rows, which is how the reads that shape
 * their result in JS (`listMessagesForConversation`) get pinned as well: the
 * statement is only half of what those functions return.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/pg-proxy'

interface CapturedQuery {
  sql: string
  params: unknown[]
}

const captured: CapturedQuery[] = []

/** What the driver answers the next query with: positional column values, as a real one would. */
let nextRows: unknown[][] = []

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  return { rows: nextRows }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import {
  CONVERSATION_LIST_LIMIT,
  MESSAGE_LIST_LIMIT,
  deleteConversationInOrg,
  findMessageInConversation,
  listMessagesForConversation,
  listVisibleConversations,
  upsertConversationRead,
} from './repository'

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

/** The one statement the call under test produced. */
function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

/** One `messages` row as the driver hands it over: column values in declaration order. */
// Positional, in schema declaration order — `organization_id` sits right after
// `conversation_id` since migration 0031 gave `messages` its own tenant column.
function messageRow(id: string, createdAt: string): unknown[] {
  return [id, 'conv_1', 'org_1', 'user', 'user_me', 'text', null, createdAt]
}

beforeEach(() => {
  captured.length = 0
  nextRows = []
})

describe('listVisibleConversations — scoped to a project', () => {
  it('keeps org tenancy, and judges in-project and unstamped rows SEPARATELY', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('"conversations"."organization_id" = $1')
    // Two disjuncts, each carrying its own visibility rule. The old shape put
    // `project_id is null` and `visibility <> 'private'` in INDEPENDENT clauses,
    // which is the leak: a row satisfying one from each was returned.
    expect(sql).toContain('("conversations"."project_id" = $2 and (')
    expect(sql).toContain('or ("conversations"."project_id" is null and (')
    expect(params.slice(0, 2)).toEqual(['org_1', PROJECT_ID])
  })

  it('narrows ONLY private rows inside the project, because project access is proven', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    // Anything not private is visible to someone who reaches the project;
    // private needs to be theirs or granted to them.
    expect(sql).toContain(
      '"conversations"."project_id" = $2 and ("conversations"."visibility" <> $3 or "conversations"."created_by" = $4',
    )
    expect(params).toContain('private')
  })

  it('does NOT hand an unstamped row out on `project` visibility alone (F5)', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    // A conversation with no `project_id` is not inside the project the caller
    // proved they reach, so that proof says nothing about it. Its own grounds are
    // exactly the ones `resolveResourceAccess` uses when there is no container:
    // creator, explicit grantee, or `organization` visibility. Before this, an
    // unstamped conversation whose owner set `project` visibility was listed —
    // with its title, tags and author — to every member of every project, and then
    // 404'd the moment they opened it.
    expect(sql).toContain(
      '("conversations"."project_id" is null and ("conversations"."created_by" = $8 or exists (',
    )
    expect(sql).toContain('"conversations"."visibility" = $12')
    expect(params[11]).toBe('organization')
    // The null-project branch never relaxes to "not private": `<>` appears once,
    // and only inside the in-project branch.
    expect(sql.match(/"conversations"\."visibility" <> /g)).toHaveLength(1)
  })

  it('resolves grants with ONE correlated subquery per branch, not one check per row', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql } = onlyQuery()
    expect(sql).toContain('exists (select 1 from "resource_shares"')
    // Correlated on the outer row — this is what makes it a single round trip.
    expect(sql).toContain('"resource_shares"."resource_id" = "conversations"."id"')
    expect(sql).toContain('"resource_shares"."subject_user_id" = $7')
    expect(sql).toContain('"resource_shares"."subject_user_id" = $11')
    // A grant row is tenant data like any other.
    expect(sql).toContain('"resource_shares"."organization_id" = $5')
    expect(sql).toContain('"resource_shares"."resource_type" = $6')
  })

  it('is bounded, newest first', async () => {
    await listVisibleConversations('org_1', 'user_me', { projectId: PROJECT_ID })

    const { sql, params } = onlyQuery()
    expect(sql).toContain('order by "conversations"."updated_at" desc')
    expect(sql).toContain('limit $13')
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
    // And crucially: `project` visibility alone does NOT make the cut here — the
    // same rule the scoped branch now applies to its unstamped rows.
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

describe('listMessagesForConversation', () => {
  it('takes the bounded window from the NEWEST end of the thread', async () => {
    await listMessagesForConversation('conv_1')

    const { sql, params } = onlyQuery()
    expect(sql).toContain('"messages"."conversation_id" = $1')
    // Ascending + limit took the OLDEST rows. On a private thread that is a
    // rehydration fallback and merely odd; on a shared thread this is *the* load
    // path (ADR-0033), so past the cap a reader was pinned to ancient history and
    // never saw a new message again — with the read receipt and the unread
    // divider following the same stale window down.
    expect(sql).toContain('order by "messages"."created_at" desc, "messages"."id" desc')
    expect(sql).toContain('limit $2')
    expect(params).toEqual(['conv_1', MESSAGE_LIST_LIMIT])
  })

  it('bounds an explicitly requested page the same way', async () => {
    await listMessagesForConversation('conv_1', 50)

    // The cap is not decoration: an unbounded transcript read is the one thing
    // the repository rules forbid outright.
    expect(onlyQuery().params).toEqual(['conv_1', 50])
  })

  it('hands the window back oldest-first, however it arrived', async () => {
    nextRows = [
      messageRow('msg_c', '2026-07-31T10:00:02.000Z'),
      messageRow('msg_b', '2026-07-31T10:00:01.000Z'),
      messageRow('msg_a', '2026-07-31T10:00:00.000Z'),
    ]

    const page = await listMessagesForConversation('conv_1', 3)

    // The DESC scan is an implementation detail of *which* rows the cap keeps;
    // every caller above it (`listConversationMessages`, and the transcript the
    // client folds into `messages-store`) reads in reading order. Losing the
    // reverse renders every thread backwards, and the statement assertions above
    // cannot see it — they are green either way.
    expect(page.map((row) => row.id)).toEqual(['msg_a', 'msg_b', 'msg_c'])
    expect(page.map((row) => row.createdAt.toISOString())).toEqual([
      '2026-07-31T10:00:00.000Z',
      '2026-07-31T10:00:01.000Z',
      '2026-07-31T10:00:02.000Z',
    ])
  })

  it('breaks a created_at tie by id, so a tie straddling the cap is not a coin toss (CC-11)', async () => {
    const sameInstant = '2026-07-31T10:00:01.000Z'
    // What Postgres returns for the statement below when the tied pair is exactly
    // what the cap admits: higher id first, the older third message cut.
    nextRows = [messageRow('msg_b', sameInstant), messageRow('msg_a', sameInstant)]

    const page = await listMessagesForConversation('conv_1', 2)

    // On `created_at` alone the tie is UNDEFINED, so two executions may admit a
    // different member of the pair into the window and order it differently —
    // "two clients MUST NOT show the same two messages in different orders".
    // Both keys must also point the SAME way: `desc, asc` still looks sorted, but
    // after the reverse its tied rows come out descending by id, contradicting
    // `compareThreadOrder` on the client and re-shuffling the thread at exactly
    // the boundary this tiebreak exists to make stable.
    expect(onlyQuery().sql).toContain('"messages"."created_at" desc, "messages"."id" desc')
    expect(page.map((row) => row.id)).toEqual(['msg_a', 'msg_b'])
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

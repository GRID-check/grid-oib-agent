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

/**
 * The same, for a statement with a `RETURNING` clause. Kept separate because a
 * write that reads first — `updateConversationVisibilityInOrg` checks the row's
 * level before it touches it — issues two statements whose result shapes differ,
 * and one variable can only answer for one of them.
 */
let nextWrittenRows: unknown[][] = []

/**
 * And a third, for the mounted COUNT the Büro visibility guard reads
 * (`countConversationMounts`). A workspace widening issues three statements
 * with three result shapes — scope, count, the update's RETURNING — and one
 * variable can only answer for one of them.
 */
let nextCountRows: unknown[][] = [[0]]

const proxyDb = drizzle(async (sql, params) => {
  captured.push({ sql, params })
  if (sql.startsWith('update ') || sql.startsWith('insert ')) return { rows: nextWrittenRows }
  if (sql.includes('"conversation_mounts"')) return { rows: nextCountRows }
  return { rows: nextRows }
})

vi.mock('@/lib/db', () => ({ getDb: () => proxyDb }))

import { BadRequestError } from '@/lib/api/errors'
import {
  CONVERSATION_LIST_LIMIT,
  MESSAGE_LIST_LIMIT,
  deleteConversationInOrg,
  findMessageInConversation,
  lastProjectActivityByUser,
  listMessagesForConversation,
  listVisibleConversations,
  updateConversationVisibilityInOrg,
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

/** One `conversations` row as the driver hands it over, in declaration order. */
function conversationRow(overrides: { scope?: string; visibility?: string } = {}): unknown[] {
  return [
    'conv_1',
    'org_1',
    'user_me',
    'Brandschutz Stiegenhaus',
    overrides.visibility ?? 'private',
    null,
    '{}',
    // The row's level and its project are one fact (migration 0081's CHECK), so
    // the fixture keeps them in step rather than letting a test assert against
    // a shape the database would refuse.
    (overrides.scope ?? 'project') === 'project' ? PROJECT_ID : null,
    overrides.scope ?? 'project',
    null,
    null,
    null,
    null,
    '2026-09-08T10:00:00.000Z',
    '2026-09-08T10:00:00.000Z',
  ]
}

beforeEach(() => {
  captured.length = 0
  nextRows = []
  nextWrittenRows = []
  // "Nothing mounted" is the default a count answers with; the one test that
  // widens a Büro thread says so explicitly.
  nextCountRows = [[1]]
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

describe('listVisibleConversations — narrowed to one level of the hierarchy', () => {
  it('adds the level as a further AND, so it can only remove rows', async () => {
    await listVisibleConversations('org_1', 'user_me', { scope: 'workspace' })

    const { sql, params } = onlyQuery()
    // The visibility rules the unscoped branch already applies, unchanged...
    expect(sql).toContain('"conversations"."organization_id" = $1')
    expect(sql).toContain('"conversations"."created_by" = $2')
    // ...plus the level. An AND, never a disjunct: a filter that widened would
    // be a leak dressed as a convenience.
    expect(sql).toContain('"conversations"."scope" = $7')
    expect(params).toContain('workspace')
  })

  it("never returns a project row to the Büro's sessions panel (spec WS-8)", async () => {
    await listVisibleConversations('org_1', 'user_me', { scope: 'workspace' })

    const { sql } = onlyQuery()
    // The equality is what makes it exact. `<>`/`is null` shapes were the old
    // way of asking this question and both let a project row through when the
    // column was NULL — which is why the column is NOT NULL.
    expect(sql).toContain('"conversations"."scope" = ')
    expect(sql).not.toContain('"conversations"."scope" <>')
  })

  it('applies no level predicate when none was asked for', async () => {
    await listVisibleConversations('org_1', 'user_me')

    const { sql } = onlyQuery()
    expect(sql).not.toContain('"conversations"."scope"')
  })
})

describe('updateConversationVisibilityInOrg — what a Büro thread may widen to (spec AC-7)', () => {
  it('refuses `project` for a workspace conversation — it has no project to share with', async () => {
    nextRows = [['workspace']]

    const failure = await updateConversationVisibilityInOrg('conv_1', 'org_1', 'project').catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(BadRequestError)
    // It read the row and then wrote NOTHING — the refusal is the whole point.
    expect(captured).toHaveLength(1)
    expect(captured[0].sql).toContain('select')
  })

  it('refuses `organization` while anything is mounted, and counts to find out', async () => {
    // Two reads: the scope, then the mounted count. There is no audience that
    // can be checked against AC-7 for "everyone in the organization".
    nextRows = [['workspace']]

    const failure = await updateConversationVisibilityInOrg(
      'conv_1',
      'org_1',
      'organization',
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BadRequestError)
    expect((failure as BadRequestError).details).toMatchObject({ scope: 'workspace' })
    expect(captured).toHaveLength(2)
    expect(captured[1].sql).toContain('"conversation_mounts"')
    expect(captured.every((query) => query.sql.startsWith('select'))).toBe(true)
  })

  it('lets a workspace conversation with NO mounts go organization-wide', async () => {
    // Nothing mounted, so the thread reads only what every member may read
    // anyway: the value is honest, and the guard is what makes the day the
    // registry offers it (SH-15) a safe one.
    nextRows = [['workspace']]
    nextCountRows = [[0]]
    nextWrittenRows = [conversationRow({ scope: 'workspace', visibility: 'organization' })]

    await updateConversationVisibilityInOrg('conv_1', 'org_1', 'organization')

    expect(captured).toHaveLength(3)
    expect(captured[2].sql).toContain('update "conversations" set')
    expect(captured[2].params).toContain('organization')
  })

  it('lets a project conversation be widened exactly as before', async () => {
    nextRows = [['project']]
    nextWrittenRows = [conversationRow({ scope: 'project', visibility: 'project' })]

    await updateConversationVisibilityInOrg('conv_1', 'org_1', 'project')

    expect(captured).toHaveLength(2)
    expect(captured[1].sql).toContain('update "conversations" set')
    expect(captured[1].params).toContain('project')
  })

  it('does not read the row at all when the change is a NARROWING to private', async () => {
    nextRows = [['workspace']]
    nextWrittenRows = [conversationRow({ scope: 'workspace' })]

    await updateConversationVisibilityInOrg('conv_1', 'org_1', 'private')

    // Narrowing a workspace thread back to private is allowed, so the guard
    // must not cost a round trip to permit it.
    expect(captured).toHaveLength(1)
    expect(captured[0].sql).toContain('update "conversations" set')
  })

  it('says nothing about a row that does not exist (spec AC-9)', async () => {
    nextRows = []

    // No row, so no scope, so no refusal to distinguish "not yours" from "not
    // shareable": the UPDATE runs, matches nothing, and the caller maps the
    // null to a 404 exactly as it did before this guard existed.
    await expect(
      updateConversationVisibilityInOrg('conv_gone', 'org_1', 'organization'),
    ).resolves.toBeNull()
    expect(captured).toHaveLength(2)
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

/**
 * The projects-home rail is ordered by this query, so "whose activity" is the
 * whole point: a predicate that let another member's messages through would
 * reorder the rail for everyone in the project, and nothing on the page would
 * look wrong. Asserted against the generated statement for the same reason as
 * the visibility rule above.
 */
describe('lastProjectActivityByUser', () => {
  const OTHER_PROJECT = '3f2504e0-4f89-11d3-9a0c-0305e82c3302'

  it('counts only messages this user wrote, plus their own legacy unauthored ones', async () => {
    await lastProjectActivityByUser('org_1', 'user_me', [PROJECT_ID])

    const { sql, params } = onlyQuery()
    // Their own authorship, OR an unauthored USER message in a thread they started.
    expect(sql).toMatch(/"author_user_id" = \$\d+ or \("messages"\."author_user_id" is null/i)
    expect(sql).toMatch(/"messages"\."role" = \$\d+/i)
    expect(sql).toMatch(/"conversations"\."created_by" = \$\d+/i)
    // Assistant/tool rows are NULL-authored forever — the role filter is what
    // keeps them from crediting the user with the agent's replies.
    expect(params).toContain('user')
    expect(params.filter((param) => param === 'user_me')).toHaveLength(2)
  })

  it('scopes to the organization, the requested projects, and live conversations', async () => {
    await lastProjectActivityByUser('org_1', 'user_me', [PROJECT_ID, OTHER_PROJECT])

    const { sql, params } = onlyQuery()
    expect(sql).toMatch(/"conversations"\."organization_id" = \$\d+/i)
    expect(sql).toMatch(/"conversations"\."project_id" in \(/i)
    expect(sql).toMatch(/"conversations"\."deleted_at" is null/i)
    expect(sql).toMatch(/group by "conversations"\."project_id"/i)
    expect(params).toContain('org_1')
    expect(params).toContain(PROJECT_ID)
    expect(params).toContain(OTHER_PROJECT)
  })

  it('coerces the aggregate at the boundary and keys it by project', async () => {
    nextRows = [
      [PROJECT_ID, '2026-08-05T09:00:00.000Z'],
      [OTHER_PROJECT, new Date('2026-08-01T07:30:00.000Z')],
    ]

    expect(await lastProjectActivityByUser('org_1', 'user_me', [PROJECT_ID, OTHER_PROJECT])).toEqual({
      [PROJECT_ID]: '2026-08-05T09:00:00.000Z',
      [OTHER_PROJECT]: '2026-08-01T07:30:00.000Z',
    })
  })

  it('drops an unparseable aggregate rather than emitting an Invalid Date', async () => {
    nextRows = [[PROJECT_ID, 'not-a-timestamp']]

    expect(await lastProjectActivityByUser('org_1', 'user_me', [PROJECT_ID])).toEqual({})
  })

  it('asks nothing when there are no projects to ask about', async () => {
    expect(await lastProjectActivityByUser('org_1', 'user_me', [])).toEqual({})
    expect(captured).toHaveLength(0)
  })
})

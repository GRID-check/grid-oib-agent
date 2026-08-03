/**
 * The two inbox behaviours that only exist in generated SQL: the mark-read paths
 * spending the group counter, and the batch fan-out folding a conflict exactly as
 * the single-row upsert does. Neither survives a chain-spy — what matters is the
 * statement Postgres receives, so these tests assert it.
 *
 * The DB is a drizzle `pg-proxy` instance — a real query builder over a callback
 * "driver" that records the SQL and parameters instead of connecting anywhere
 * (same harness as `lib/conversations/repository.spec.ts`).
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
  markAllInboxItemsRead,
  markInboxItemsRead,
  markResourceItemsRead,
  upsertInboxItem,
  upsertInboxItems,
} from './repository'

import type { NewInboxItem } from '@/lib/db/schema'

/** The one statement the call under test produced. */
function onlyQuery(): CapturedQuery {
  expect(captured).toHaveLength(1)
  return captured[0]
}

/** The `do update set` list of an upsert, without the insert or the RETURNING. */
function conflictSet(sql: string): string {
  const match = /do update set (.+?) returning /.exec(sql)
  expect(match, sql).not.toBeNull()
  return match![1]
}

/** Which columns that `set` list assigns, in statement order. */
function assignedColumns(sql: string): string[] {
  return [...conflictSet(sql).matchAll(/"([a-z_]+)" = /g)].map((match) => match[1])
}

function newItem(overrides: Partial<NewInboxItem> = {}): NewInboxItem {
  return {
    organizationId: 'org_1',
    recipientUserId: 'user_me',
    type: 'conversation.activity',
    resourceType: 'conversation',
    resourceId: 'c1',
    groupKey: 'conversation.activity:conversation:c1',
    actionable: false,
    actorUserId: 'u_bob',
    anchorId: 'msg_9',
    payload: { subject: 'Atrium' },
    ...overrides,
  }
}

beforeEach(() => {
  captured.length = 0
})

describe('mark-read — reading a group spends its counter', () => {
  const paths: ReadonlyArray<{ name: string; run: () => Promise<number> }> = [
    { name: 'markInboxItemsRead', run: () => markInboxItemsRead('org_1', 'user_me', ['item_1']) },
    { name: 'markAllInboxItemsRead', run: () => markAllInboxItemsRead('org_1', 'user_me') },
    {
      name: 'markResourceItemsRead',
      run: () => markResourceItemsRead('org_1', 'user_me', 'conversation', 'c1'),
    },
  ]

  for (const { name, run } of paths) {
    it(`${name} writes count = 0 in the same statement as read_at`, async () => {
      await run()

      const { sql, params } = onlyQuery()
      // `count` is occurrences SINCE THE ROW WAS LAST READ, and the upsert
      // increments from whatever mark-read leaves behind. Setting only `read_at`
      // left the counter standing, so a group of twenty the user had just read
      // said "21 new messages" the moment a twenty-first arrived — twenty of
      // which they had already seen. Zeroed here, that next arrival reads "1".
      expect(sql).toContain('set "count" = $1, "read_at" = $2')
      expect(params[0]).toBe(0)
    })
  }
})

describe('upsertInboxItems — the batch fold matches the single-row fold', () => {
  /** Two recipients, so the fan-out is genuinely ONE statement for many rows. */
  const fanOut = [newItem(), newItem({ recipientUserId: 'user_you' })]

  it('takes the newest actor and anchor from the row being inserted', async () => {
    await upsertInboxItems(fanOut)

    const set = conflictSet(onlyQuery().sql)
    // `excluded`, not a literal: one `set` serves every conflicting row in the
    // batch, so a bound parameter would stamp the first recipient's actor onto
    // everyone. Missing entirely — as they were — a collapsed group kept its
    // FIRST actor and FIRST anchor for good: "Anna shared a conversation with
    // you" stayed Anna's name after Bob re-shared, and the deep link kept
    // pointing at the message that opened the group.
    expect(set).toContain('"actor_user_id" = excluded.actor_user_id')
    expect(set).toContain('"anchor_id" = excluded.anchor_id')
  })

  it('MERGES the incoming payload into the stored one instead of replacing it', async () => {
    await upsertInboxItems(fanOut)

    const set = conflictSet(onlyQuery().sql)
    // `||` is jsonb concat: new keys win, absent keys are left alone. The
    // activity fan-out emits `{}` whenever the title lookup comes back null, and
    // a straight `excluded.payload` let that one null wipe the subject off every
    // recipient's row — permanently, because the row is never re-emitted with the
    // title. The negative assertion is the point: the presence of an assignment
    // is not the behaviour, the merge is.
    expect(set).toContain('"payload" = "inbox_items"."payload" || excluded.payload')
    expect(set).not.toMatch(/"payload" = excluded\.payload/)
  })

  it('assigns exactly the columns the single-row upsert assigns', async () => {
    await upsertInboxItems(fanOut)
    const batch = assignedColumns(onlyQuery().sql)

    captured.length = 0
    await upsertInboxItem(newItem())
    const single = assignedColumns(onlyQuery().sql)

    // The doc comment above `upsertInboxItems` PROMISES "conflicts fold exactly
    // as upsertInboxItem does", and the two lists drifted apart unnoticed. This
    // pins the promise itself, so the next column added to one and forgotten in
    // the other fails here rather than in someone's inbox.
    expect(batch).toEqual(single)
    expect(batch).toContain('actor_user_id')
    expect(batch).toContain('anchor_id')
    expect(batch).toContain('payload')
  })

  it('increments the counter and revives the row, in both folds', async () => {
    await upsertInboxItems(fanOut)
    const batchSet = conflictSet(onlyQuery().sql)

    captured.length = 0
    await upsertInboxItem(newItem())
    const singleSet = conflictSet(onlyQuery().sql)

    // Counting is relative to the STORED row, never to `excluded` — the incoming
    // row always carries the default 1. And a new occurrence is new information,
    // so the fold clears the states that would otherwise keep the row out of
    // sight.
    for (const set of [batchSet, singleSet]) {
      expect(set).toContain('"count" = "inbox_items"."count" + 1')
      expect(set).toContain('"read_at" = ')
      expect(set).toContain('"resolved_at" = ')
      expect(set).toContain('"archived_at" = ')
      expect(set).toContain('"inert_at" = ')
    }
  })

  it('does not touch the database for an empty fan-out', async () => {
    expect(await upsertInboxItems([])).toEqual([])
    expect(captured).toHaveLength(0)
  })
})

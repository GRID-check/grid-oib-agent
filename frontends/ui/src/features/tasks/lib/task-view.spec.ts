/**
 * The task view boundary: submission words never reach the row.
 *
 * The task vocabulary talks about WORK (`queued`/`running`/…), but a status
 * naming the submission (`submitted`, `pending`) can still arrive on the wire.
 * Rendered raw it would put a backend token in front of an architect, so the
 * panel folds both to the planner word `queued` ("accepted, not started").
 * Backend enums are untouched — this maps at the view boundary only.
 */

import { describe, expect, test } from 'vitest'
import {
  bucketFor,
  filterCounts,
  groupByRecency,
  matchesFilter,
  normalizeTaskStatus,
  taskResultTarget,
  type TaskWireRow,
} from './task-view'

describe('normalizeTaskStatus', () => {
  test('folds submission words to the planner word', () => {
    expect(normalizeTaskStatus('submitted')).toBe('queued')
    expect(normalizeTaskStatus('pending')).toBe('queued')
  })

  test('is case- and whitespace-tolerant, like every other wire read', () => {
    expect(normalizeTaskStatus(' Submitted ')).toBe('queued')
    expect(normalizeTaskStatus('PENDING')).toBe('queued')
  })

  test('leaves planner words alone', () => {
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'interrupted']) {
      expect(normalizeTaskStatus(status)).toBe(status)
    }
  })
})

/**
 * Where a finished task's result lives.
 *
 * The order is the point: the filed DOCUMENT is the durable artefact the rest
 * of the product treats as real, a conversation is the thing you continue, and
 * the run's own report is the fallback that stops a finished research task from
 * being a dead end — which is exactly what it was before this existed.
 */
describe('taskResultTarget', () => {
  const row = (overrides: Partial<TaskWireRow> = {}): TaskWireRow => ({
    id: 't1',
    kind: 'document',
    title: 'Aktenvermerk',
    goal: null,
    status: 'succeeded',
    review: null,
    reviewReason: null,
    filedDocumentId: null,
    conversationId: null,
    runMessageId: null,
    backendJobId: null,
    trigger: 'delegated',
    requesterUserId: 'user_anna',
    requesterName: 'Anna Berger',
    createdAt: '2026-09-15T08:00:00.000Z',
    finishedAt: null,
    error: null,
    ...overrides,
  })

  test('a filed document wins over everything else it could offer', () => {
    const target = taskResultTarget('p1', row({
      filedDocumentId: 'doc-9',
      conversationId: 'conv-1',
      backendJobId: 'bj-1',
    }))
    expect(target).toEqual({ kind: 'document', href: '/app/projects/p1/files?doc=doc-9' })
  })

  test('a run with no message of its own still opens the thread it wrote into', () => {
    const target = taskResultTarget('p1', row({ conversationId: 'conv-1', backendJobId: 'bj-1' }))
    expect(target).toEqual({ kind: 'conversation', href: '/app/projects/p1/chat?session=conv-1' })
  })

  /**
   * A run is one message in its thread (ADR-0062), and a standing task's thread
   * holds every fire it has ever had — so „open the result" has to land on THIS
   * run, not at the bottom of a year of them. `#message-<id>` is the anchor the
   * inbox links already use, and `?run=` names the run for a surface that has
   * only the thread.
   */
  test('a run with its own message opens the thread AT that message', () => {
    const target = taskResultTarget(
      'p1',
      row({ id: 'run-7', conversationId: 'conv-1', runMessageId: 'msg-7', backendJobId: 'bj-1' }),
    )
    expect(target).toEqual({
      kind: 'conversation',
      href: '/app/projects/p1/chat?session=conv-1&run=run-7#message-msg-7',
    })
  })

  test('a finished run that filed nothing still opens its report', () => {
    expect(taskResultTarget('p1', row({ backendJobId: 'bj-1' }))).toEqual({
      kind: 'report',
      href: '/app/projects/p1/chat?job=bj-1',
    })
  })

  test('a failure opens its thinking — there is no report to read', () => {
    expect(taskResultTarget('p1', row({ status: 'failed', backendJobId: 'bj-1' }))).toEqual({
      kind: 'thinking',
      href: '/app/projects/p1/chat?job=bj-1&tab=thinking',
    })
    expect(taskResultTarget('p1', row({ status: 'error', backendJobId: 'bj-1' }))?.kind).toBe(
      'thinking',
    )
  })

  test('a run still going is followed live', () => {
    expect(taskResultTarget('p1', row({ status: 'running', backendJobId: 'bj-1' }))).toEqual({
      kind: 'report',
      href: '/app/projects/p1/chat?job=bj-1&tab=tasks',
    })
  })

  test('a submission that never reached the agent points nowhere, and says so', () => {
    expect(taskResultTarget('p1', row({ status: 'error' }))).toBeNull()
  })

  test('ids are encoded — a project or document id is not a URL fragment', () => {
    const target = taskResultTarget('p 1', row({ filedDocumentId: 'a/b' }))
    expect(target?.href).toBe('/app/projects/p%201/files?doc=a%2Fb')
  })
})

/**
 * The filter row. `unreviewed` is the one that earns the row: a finished task
 * nobody judged is an open loop, and the count is the number a person wants at
 * zero.
 */
describe('task filters', () => {
  const at = (overrides: Partial<TaskWireRow>): TaskWireRow => ({
    id: 'x',
    kind: 'document',
    title: 't',
    goal: null,
    status: 'succeeded',
    review: null,
    reviewReason: null,
    filedDocumentId: null,
    conversationId: null,
    runMessageId: null,
    backendJobId: null,
    trigger: 'delegated',
    requesterUserId: 'u',
    requesterName: null,
    createdAt: '2026-09-15T08:00:00.000Z',
    finishedAt: null,
    error: null,
    ...overrides,
  })

  test('unreviewed is finished work nobody has judged — reviewing it clears it', () => {
    expect(matchesFilter(at({ status: 'succeeded', review: null }), 'unreviewed')).toBe(true)
    expect(matchesFilter(at({ status: 'succeeded', review: 'accepted' }), 'unreviewed')).toBe(false)
    expect(matchesFilter(at({ status: 'succeeded', review: 'rejected' }), 'unreviewed')).toBe(false)
    // Not finished is not unreviewed: there is nothing to judge yet.
    expect(matchesFilter(at({ status: 'running' }), 'unreviewed')).toBe(false)
  })

  test('failed covers a broken run AND a submission that never reached the agent', () => {
    expect(matchesFilter(at({ status: 'failed' }), 'failed')).toBe(true)
    expect(matchesFilter(at({ status: 'error' }), 'failed')).toBe(true)
  })

  test('a deliberate stop is not a failure and does not pad the failure list', () => {
    for (const status of ['interrupted', 'skipped'] as const) {
      expect(matchesFilter(at({ status }), 'failed')).toBe(false)
      expect(matchesFilter(at({ status }), 'active')).toBe(false)
      expect(matchesFilter(at({ status }), 'unreviewed')).toBe(false)
      // …but it is still in the list.
      expect(matchesFilter(at({ status }), 'all')).toBe(true)
    }
  })

  test('the counts are what each chip would show, zeros included', () => {
    const counts = filterCounts([
      at({ id: '1', status: 'running' }),
      at({ id: '2', status: 'succeeded', review: null }),
      at({ id: '3', status: 'succeeded', review: 'accepted' }),
    ])
    expect(counts).toEqual({ all: 3, active: 1, unreviewed: 1, failed: 0 })
  })
})

/**
 * Recency buckets. Relative, not per-day: "Heute / Gestern / Diese Woche /
 * Früher" is how a person remembers when they asked, and it cannot degenerate
 * into forty groups of one.
 */
describe('groupByRecency', () => {
  const now = new Date('2026-09-15T14:00:00.000Z')
  const at = (id: string, createdAt: string): TaskWireRow => ({
    id,
    kind: 'document',
    title: id,
    goal: null,
    status: 'succeeded',
    review: null,
    reviewReason: null,
    filedDocumentId: null,
    conversationId: null,
    runMessageId: null,
    backendJobId: null,
    trigger: 'delegated',
    requesterUserId: 'u',
    requesterName: null,
    createdAt,
    finishedAt: null,
    error: null,
  })

  test('buckets by local calendar day, not by a 24-hour subtraction', () => {
    // 01:00 local today is 13 hours before `now` — a 24h window would call it
    // "today" either way, but 23:00 local yesterday is only 15 hours before and
    // must still read as Gestern.
    const today = new Date(now)
    today.setHours(1, 0, 0, 0)
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(23, 0, 0, 0)

    expect(bucketFor(today.toISOString(), now)).toBe('today')
    expect(bucketFor(yesterday.toISOString(), now)).toBe('yesterday')
  })

  test('keeps the newest bucket first and drops the empty ones', () => {
    const older = new Date(now)
    older.setDate(older.getDate() - 20)
    const groups = groupByRecency([at('a', now.toISOString()), at('b', older.toISOString())], now)
    expect(groups.map((group) => group.bucket)).toEqual(['today', 'earlier'])
  })

  test('order inside a bucket is the order the server sent — no second opinion', () => {
    const [group] = groupByRecency(
      [at('a', now.toISOString()), at('b', now.toISOString())],
      now,
    )
    expect(group.tasks.map((task) => task.id)).toEqual(['a', 'b'])
  })
})

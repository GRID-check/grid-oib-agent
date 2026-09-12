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
import { normalizeTaskStatus } from './task-view'

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

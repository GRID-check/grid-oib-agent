/**
 * @vitest-environment node
 */
/**
 * One definition, one thread — held by a derived id rather than by an index.
 *
 * These four facts are the whole mechanism: the id is a function of the
 * definition, it is spelled like every other conversation id, a standing thread
 * is recognisable from the row alone, and the per-fire conversations already in
 * every deployment are not mistaken for one.
 */

import { describe, expect, it } from 'vitest'
import { isTaskThread, taskThreadConversationId } from './task-thread'

const DEFINITION = '3f8b0d2e-0000-4000-8000-000000000001'

describe('taskThreadConversationId', () => {
  it('is the same id for the same definition, every time', () => {
    expect(taskThreadConversationId(DEFINITION)).toBe(taskThreadConversationId(DEFINITION))
  })

  it('is a different id for a different definition', () => {
    expect(taskThreadConversationId(DEFINITION)).not.toBe(
      taskThreadConversationId('3f8b0d2e-0000-4000-8000-000000000002'),
    )
  })

  /**
   * The id doubles as this session's Qdrant collection name, so a definition's
   * thread has to be spelled exactly the way an interactive one is: `s_` and a
   * uuid whose hyphens are underscores.
   */
  it('is spelled like every other conversation id', () => {
    expect(taskThreadConversationId(DEFINITION)).toMatch(/^s_[0-9a-f_]{36}$/)
  })
})

describe('isTaskThread', () => {
  it('recognises a standing thread from the row alone, with no query', () => {
    expect(isTaskThread({ id: taskThreadConversationId(DEFINITION), jobId: DEFINITION })).toBe(true)
  })

  /**
   * The rows this has to tell apart. Every fire before this design stamped its
   * own conversation with the SAME `job_id`, and those stay hidden from the
   * personal sessions list — showing them is the 52-threads-a-year the rule
   * exists to prevent.
   */
  it('does not mistake a per-fire job conversation for one', () => {
    expect(isTaskThread({ id: 's_0e1b2c3d_1111_4111_8111_111111111111', jobId: DEFINITION })).toBe(
      false,
    )
  })

  it('is false for a conversation a person started', () => {
    expect(isTaskThread({ id: taskThreadConversationId(DEFINITION), jobId: null })).toBe(false)
  })
})

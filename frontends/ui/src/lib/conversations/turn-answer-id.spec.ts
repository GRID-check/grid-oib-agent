import { describe, expect, it } from 'vitest'
import { turnAnswerId } from './turn-answer-id'

describe('turnAnswerId', () => {
  it('is the id the backend persists the same turn under', () => {
    // python -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_URL, 'grid:assistant:s_abc:msg_1727_1'))"
    expect(turnAnswerId('s_abc', 'msg_1727_1')).toBe('a0c0a494-db9a-5e6d-b445-9070301b154f')
  })

  it('differs per turn', () => {
    expect(turnAnswerId('s_abc', 'msg_1')).not.toBe(turnAnswerId('s_abc', 'msg_2'))
  })
})

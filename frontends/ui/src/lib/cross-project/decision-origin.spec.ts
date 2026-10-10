/**
 * One rule for who stands behind a decision, read by the agent's lookup and a
 * person's similar-projects page alike.
 */
import { describe, expect, it } from 'vitest'
import { memoryOriginOf } from './decision-origin'

describe('memoryOriginOf', () => {
  it('a decision a person confirmed, pinned or wrote is the person’s, whatever it was drafted from', () => {
    expect(memoryOriginOf({ pinned: false, verification: 'user_confirmed', provenanceType: 'distillation' })).toBe('person')
    expect(memoryOriginOf({ pinned: true, verification: 'source_grounded', provenanceType: 'distillation' })).toBe('person')
    expect(memoryOriginOf({ pinned: false, verification: 'unverified', provenanceType: 'user' })).toBe('person')
  })

  it('one read from the documents and not confirmed is the documents’, anything else the agent’s', () => {
    expect(memoryOriginOf({ pinned: false, verification: 'source_grounded', provenanceType: 'distillation' })).toBe('documents')
    expect(memoryOriginOf({ pinned: false, verification: 'unverified', provenanceType: 'agent' })).toBe('agent')
  })
})

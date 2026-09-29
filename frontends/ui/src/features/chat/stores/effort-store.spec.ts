import { beforeEach, describe, expect, it } from 'vitest'

import { effectiveEffort, useEffortStore } from './effort-store'

describe('the Aufwand dial store', () => {
  beforeEach(() => {
    useEffortStore.setState({ orgDefault: 'medium', draft: null, byConversation: {} })
  })

  it("starts a chat at the organization's default", () => {
    useEffortStore.getState().setOrgDefault('low')
    expect(effectiveEffort(useEffortStore.getState(), 'c1')).toBe('low')
    expect(useEffortStore.getState().levelForSend('c1')).toBe('low')
  })

  it('keeps each chat at its own level', () => {
    useEffortStore.getState().choose('c1', 'high')
    useEffortStore.getState().choose('c2', 'minimal')

    expect(useEffortStore.getState().levelForSend('c1')).toBe('high')
    expect(useEffortStore.getState().levelForSend('c2')).toBe('minimal')
    expect(useEffortStore.getState().levelForSend('c3')).toBe('medium')
  })

  it('hands a level chosen before the chat existed to its first send, once', () => {
    useEffortStore.getState().choose(null, 'xhigh')

    expect(useEffortStore.getState().levelForSend('fresh')).toBe('xhigh')
    expect(useEffortStore.getState().draft).toBeNull()
    expect(useEffortStore.getState().levelForSend('another')).toBe('medium')
    expect(useEffortStore.getState().levelForSend('fresh')).toBe('xhigh')
  })

  it('forgets the oldest chat first past its bound', () => {
    for (let i = 0; i < 205; i += 1) useEffortStore.getState().choose(`c${i}`, 'high')
    const remembered = Object.keys(useEffortStore.getState().byConversation)

    expect(remembered).toHaveLength(200)
    expect(remembered).not.toContain('c0')
    expect(remembered).toContain('c204')
  })
})

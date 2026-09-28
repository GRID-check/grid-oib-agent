/**
 * The sessions panel's rows survive a streamed delta unchanged, so the layout
 * that renders them does not re-render with every one.
 */

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { useChatStore } from '@/features/chat'
import type { Conversation } from '@/features/chat/types'
import { useSessionRows } from './use-session-rows'

const conversation = (id: string, updatedAt: Date, content = ''): Conversation => ({
  id,
  userId: 'u1',
  projectId: null,
  title: `Titel ${id}`,
  messages: [
    { id: `${id}-a`, role: 'assistant', content, timestamp: updatedAt, messageType: 'assistant' },
  ],
  createdAt: updatedAt,
  updatedAt,
})

describe('useSessionRows', () => {
  beforeEach(() => {
    const older = conversation('older', new Date(2026, 8, 24))
    const open = conversation('open', new Date(2026, 8, 25))
    useChatStore.setState({
      currentUserId: 'u1',
      projectId: null,
      currentConversation: open,
      conversations: [older, open],
    })
  })

  test('lists the user’s sessions newest first', () => {
    const { result } = renderHook(() => useSessionRows())
    expect(result.current.map((row) => row.id)).toEqual(['open', 'older'])
  })

  test('a delta that changes only the messages keeps the same list', () => {
    const { result } = renderHook(() => useSessionRows())
    const before = result.current

    act(() => {
      const { conversations } = useChatStore.getState()
      const streamed = { ...conversations[1]!, messages: [...conversations[1]!.messages] }
      streamed.messages[0] = { ...streamed.messages[0]!, content: 'mehr Text', isStreaming: true }
      useChatStore.setState({
        currentConversation: streamed,
        conversations: [conversations[0]!, streamed],
      })
    })

    expect(result.current).toBe(before)
  })

  test('a changed title yields a new row for that session only', () => {
    const { result } = renderHook(() => useSessionRows())
    const [openBefore, olderBefore] = result.current

    act(() => {
      const { conversations } = useChatStore.getState()
      useChatStore.setState({
        conversations: [conversations[0]!, { ...conversations[1]!, title: 'Umbenannt' }],
      })
    })

    expect(result.current[0]).not.toBe(openBefore)
    expect(result.current[0]!.title).toBe('Umbenannt')
    expect(result.current[1]).toBe(olderBefore)
  })
})

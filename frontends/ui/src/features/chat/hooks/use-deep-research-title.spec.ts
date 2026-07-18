import { renderHook, act } from '@testing-library/react'
import { describe, test, expect, beforeEach } from 'vitest'
import type { DeepResearchTodo } from '../types'
import { useChatStore } from '../store'
import { useDeepResearchTitle } from './use-deep-research-title'

const todo = (status: DeepResearchTodo['status'], id: string): DeepResearchTodo => ({
  id,
  content: `task ${id}`,
  status,
})

describe('useDeepResearchTitle', () => {
  beforeEach(() => {
    useChatStore.setState({ isDeepResearchStreaming: false, deepResearchTodos: [] })
    // The route metadata would have set this base title before the job ran.
    document.title = 'Neubau Wohnbau · Ask Piloti — Piloti'
  })

  test('leaves the tab title alone when no job is streaming', () => {
    renderHook(() => useDeepResearchTitle())
    expect(document.title).toBe('Neubau Wohnbau · Ask Piloti — Piloti')
  })

  test('shows an active marker while streaming with no todos yet', () => {
    renderHook(() => useDeepResearchTitle())
    act(() => {
      useChatStore.setState({ isDeepResearchStreaming: true, deepResearchTodos: [] })
    })
    expect(document.title).toBe('⏳ Research — Piloti')
  })

  test('reflects todo progress as a percentage in the title', () => {
    renderHook(() => useDeepResearchTitle())
    act(() => {
      useChatStore.setState({
        isDeepResearchStreaming: true,
        deepResearchTodos: [
          todo('completed', '1'),
          todo('in_progress', '2'),
          todo('pending', '3'),
        ],
      })
    })
    // 1 of 3 completed -> round(33.33) = 33
    expect(document.title).toBe('33% · Research — Piloti')
  })

  test('restores the base title when the job completes', () => {
    renderHook(() => useDeepResearchTitle())
    act(() => {
      useChatStore.setState({
        isDeepResearchStreaming: true,
        deepResearchTodos: [todo('completed', '1'), todo('pending', '2')],
      })
    })
    expect(document.title).toBe('50% · Research — Piloti')

    act(() => {
      useChatStore.setState({ isDeepResearchStreaming: false })
    })
    expect(document.title).toBe('Neubau Wohnbau · Ask Piloti — Piloti')
  })

  test('restores the base title on unmount mid-run', () => {
    const { unmount } = renderHook(() => useDeepResearchTitle())
    act(() => {
      useChatStore.setState({ isDeepResearchStreaming: true, deepResearchTodos: [] })
    })
    expect(document.title).toBe('⏳ Research — Piloti')

    unmount()
    expect(document.title).toBe('Neubau Wohnbau · Ask Piloti — Piloti')
  })
})

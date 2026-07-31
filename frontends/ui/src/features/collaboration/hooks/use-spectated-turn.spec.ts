/**
 * When the live view opens, when it stays shut, and how it gives up.
 *
 * The gating is the part worth pinning: this is the only connection in the
 * collaboration feature that carries a token stream, so "opens for a colleague's
 * turn and for nothing else" is a cost property as much as a correctness one.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSpectatedTurn } from './use-spectated-turn'

/** A controllable stand-in for the browser's EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

function frame(seq: number, payload: unknown) {
  return { kind: 'frame', seq, payload }
}

function delta(text: string, parentId = 'turn-1') {
  return {
    type: 'system_response_message',
    id: `${parentId}-${text}`,
    parent_id: parentId,
    content: { text },
    status: 'in_progress',
  }
}

describe('useSpectatedTurn', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens nothing when disabled', () => {
    renderHook(() => useSpectatedTurn({ conversationId: 'conv_1', enabled: false }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('opens nothing without a conversation', () => {
    renderHook(() => useSpectatedTurn({ conversationId: null, enabled: true }))
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('opens the conversation stream when a colleague is being answered', () => {
    renderHook(() => useSpectatedTurn({ conversationId: 'conv_1', enabled: true }))
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/conversations/conv_1/live')
  })

  it('goes live only once there is something to show', async () => {
    const { result } = renderHook(() =>
      useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
    )
    // Connected, no frames: the caller must still be rendering the banner, not an
    // empty box where the answer will be.
    expect(result.current.live).toBe(false)

    act(() => FakeEventSource.instances[0].emit(frame(1, delta('Ja, '))))
    await waitFor(() => expect(result.current.live).toBe(true))
    expect(result.current.turn?.answer).toBe('Ja, ')
  })

  it('ignores a frame it has already applied', async () => {
    const { result } = renderHook(() =>
      useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
    )
    const source = FakeEventSource.instances[0]

    act(() => source.emit(frame(1, delta('Ja, '))))
    act(() => source.emit(frame(2, delta('ab drei Geschossen.'))))
    // A reconnect re-delivering seq 2 must not duplicate the tokens.
    act(() => source.emit(frame(2, delta('ab drei Geschossen.'))))

    await waitFor(() => expect(result.current.turn?.answer).toBe('Ja, ab drei Geschossen.'))
  })

  it('closes and reports nothing when the server has no live channel', async () => {
    const { result } = renderHook(() =>
      useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
    )
    const source = FakeEventSource.instances[0]

    act(() => source.emit({ kind: 'unsupported' }))

    // Closed, so EventSource does not reconnect into a stream that will answer
    // the same way; and nothing reported, so the caller falls back to the banner.
    await waitFor(() => expect(source.closed).toBe(true))
    expect(result.current.live).toBe(false)
    expect(result.current.turn).toBeNull()
  })

  it('stops when access is revoked mid-stream', async () => {
    const { result } = renderHook(() =>
      useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
    )
    const source = FakeEventSource.instances[0]

    act(() => source.emit(frame(1, delta('Teilantwort'))))
    act(() => source.emit({ kind: 'revoked' }))

    await waitFor(() => expect(result.current.turn).toBeNull())
    expect(source.closed).toBe(true)
  })

  it('closes the stream when the turn ends', async () => {
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useSpectatedTurn({ conversationId: 'conv_1', enabled: props.enabled }),
      { initialProps: { enabled: true } }
    )
    const source = FakeEventSource.instances[0]
    rerender({ enabled: false })
    await waitFor(() => expect(source.closed).toBe(true))
  })

  it('clears the half-written answer when the turn ends', async () => {
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useSpectatedTurn({ conversationId: 'conv_1', enabled: props.enabled }),
      { initialProps: { enabled: true } }
    )
    act(() => FakeEventSource.instances[0].emit(frame(1, delta('Halb geschriebene '))))
    await waitFor(() => expect(result.current.turn?.answer).toBe('Halb geschriebene '))

    // The persisted answer is what renders from here on; a leftover live copy
    // would show the same answer twice.
    rerender({ enabled: false })
    await waitFor(() => expect(result.current.turn).toBeNull())
  })

  it('degrades quietly in a runtime with no EventSource', () => {
    vi.stubGlobal('EventSource', undefined)
    const { result } = renderHook(() =>
      useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
    )
    expect(result.current.turn).toBeNull()
    expect(result.current.live).toBe(false)
  })
})

describe('reconnect policy', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('backs off, and gives up rather than hammering the route', () => {
    // The server sends `retry: 2000`, so leaving reconnection to the browser
    // means every observer of every running turn retries in lockstep twice a
    // second — each attempt costing an authorization read and a fresh cache
    // subscriber. The hook takes control instead.
    vi.useFakeTimers()
    try {
      renderHook(() => useSpectatedTurn({ conversationId: 'conv_1', enabled: true }))
      expect(FakeEventSource.instances).toHaveLength(1)

      // Six failures, each given far more time than any backoff step needs.
      for (let round = 0; round < 6; round += 1) {
        const live = FakeEventSource.instances.at(-1)!
        act(() => live.onerror?.())
        expect(live.closed).toBe(true)
        act(() => {
          vi.advanceTimersByTime(60_000)
        })
      }

      // One initial connection plus a bounded number of retries — never one per
      // two seconds, and never unbounded.
      expect(FakeEventSource.instances.length).toBeGreaterThan(1)
      expect(FakeEventSource.instances.length).toBeLessThanOrEqual(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not spend the budget on failures separated by working stretches', () => {
    // A long turn can drop and recover several times. Without resetting the
    // ladder on evidence the connection works, four failures spread over an hour
    // exhaust it and the observer loses the live view for the rest of the turn.
    vi.useFakeTimers()
    try {
      renderHook(() => useSpectatedTurn({ conversationId: 'conv_1', enabled: true }))

      for (let round = 0; round < 8; round += 1) {
        const live = FakeEventSource.instances.at(-1)!
        // Proof the connection works, then a drop.
        act(() => live.emit(frame(round + 1, delta('x'))))
        act(() => live.onerror?.())
        act(() => {
          vi.advanceTimersByTime(60_000)
        })
      }

      // Every drop was preceded by a working connection, so every one of them
      // reconnected: 1 initial + 8 retries.
      expect(FakeEventSource.instances).toHaveLength(9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reconnect after the effect is torn down', () => {
    vi.useFakeTimers()
    try {
      const { unmount } = renderHook(() =>
        useSpectatedTurn({ conversationId: 'conv_1', enabled: true })
      )
      const live = FakeEventSource.instances.at(-1)!
      act(() => live.onerror?.())
      unmount()
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      // The pending retry must not open a stream for a thread nobody is watching.
      expect(FakeEventSource.instances).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

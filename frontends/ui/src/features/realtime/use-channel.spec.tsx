/**
 * One channel in a component: what goes up says whether it is motion, and a
 * channel that closed says nothing more under its peer, whoever still holds
 * its `send`.
 */

import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpstreamBase } from '@/lib/realtime/types'
import type { ChannelPostOptions } from './connection'
import type { RosterEntry } from './presence'
import { useChannel, useRosterSelector, type ChannelLink, type ChannelFrame, type SnapshotStore } from './use-channel'

type Event = { kind: string; peer?: { peerId: string; userId: string; name: string; kind: 'person' | 'piloti' } }

function scriptedLink() {
  const posts: Array<{ msg: UpstreamBase & Record<string, unknown>; options?: ChannelPostOptions }> = []
  const link: ChannelLink = {
    connect({ onOpen }) {
      onOpen()
      return () => undefined
    },
    post: (msg, options) => posts.push({ msg: msg as UpstreamBase & Record<string, unknown>, options }),
  }
  return { link, posts }
}

const PRESENCE = { refreshMs: 10_000, initial: () => undefined, reduce: () => undefined }
const parse = (event: unknown) => event as Event

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useChannel', () => {
  it('marks a throttled lane as motion and an unthrottled message as a claim', () => {
    const { link, posts } = scriptedLink()
    const { result, unmount } = renderHook(() => useChannel<Event>('doc:a', { enabled: true, link, parse }))

    act(() => result.current.send({ cursor: 1 }, { throttleMs: 80, lane: 'cursor' }))
    act(() => result.current.send({ selected: 'ann_1' }))
    expect(posts.map((post) => [Object.keys(post.msg).sort().join(','), post.options?.motion])).toEqual([
      ['cursor,peerId', true],
      ['peerId,selected', false],
    ])
    unmount()
  })

  it('says nothing more once the channel closed: a late send would bring the peer back as a ghost', () => {
    const { link, posts } = scriptedLink()
    const { result, unmount } = renderHook(() =>
      useChannel<Event, undefined>('doc:a', { enabled: true, link, parse, presence: PRESENCE })
    )
    const { send } = result.current

    unmount()
    expect(posts.at(-1)?.msg.presence).toBe('gone')
    const said = posts.length

    // A timer that outlived the component (the cursor chat's linger) still holds `send`.
    send({ cursor: null, chat: null })
    send({ selected: null })
    vi.advanceTimersByTime(30_000)
    expect(posts).toHaveLength(said)
  })
})

describe('the roster as a store', () => {
  type Peer = NonNullable<Event['peer']>
  const ANNA: Peer = { peerId: 'tab-anna', userId: 'user_anna', name: 'Anna Berger', kind: 'person' }
  const JAKOB: Peer = { peerId: 'tab-jakob', userId: 'user_jakob', name: 'Jakob Huber', kind: 'person' }
  type Moved = { kind: string; peer?: Peer; x?: number }
  const MOVES = { refreshMs: 10_000, initial: () => 0, reduce: (_: number, event: Moved) => event.x ?? 0 }

  function liveLink() {
    let deliver: ((frame: ChannelFrame) => void) | null = null
    const link: ChannelLink = {
      connect({ onFrame, onOpen }) {
        deliver = onFrame
        onOpen()
        return () => undefined
      },
      post: () => undefined,
    }
    const say = (event: Moved) => act(() => deliver?.({ kind: 'event', event }))
    const frame = () => act(() => vi.advanceTimersByTime(20))
    return { link, say, frame }
  }

  it('moves without re-rendering the component that opened the channel; a peer that did not move keeps its entry', () => {
    const { link, say, frame } = liveLink()
    let renders = 0
    let roster: SnapshotStore<readonly RosterEntry<number>[]> | null = null
    function Host() {
      renders += 1
      roster = useChannel<Moved, number>('doc:a', { enabled: true, link, parse: (event) => event as Moved, presence: MOVES }).roster
      return null
    }
    render(<Host />)
    say({ kind: 'cursor', peer: ANNA, x: 1 })
    say({ kind: 'cursor', peer: JAKOB, x: 1 })
    frame()
    const settled = renders
    const before = roster!.get()
    const jakob = before.find((entry) => entry.peer.peerId === JAKOB.peerId)

    for (let x = 2; x < 20; x += 1) {
      say({ kind: 'cursor', peer: ANNA, x })
      frame()
    }

    expect(renders).toBe(settled)
    expect(roster!.get().find((entry) => entry.peer.peerId === ANNA.peerId)?.state).toBe(19)
    expect(roster!.get().find((entry) => entry.peer.peerId === JAKOB.peerId)).toBe(jakob)
  })

  it('re-renders a selector only when what it reads changed', () => {
    const { link, say, frame } = liveLink()
    let reads = 0
    function Host() {
      const { roster } = useChannel<Moved, number>('doc:a', { enabled: true, link, parse: (event) => event as Moved, presence: MOVES })
      return <Count roster={roster} />
    }
    function Count({ roster }: { roster: SnapshotStore<readonly RosterEntry<number>[]> }) {
      reads += 1
      const count = useRosterSelector(roster, (entries) => entries.length)
      return <span>{count}</span>
    }
    const view = render(<Host />)
    say({ kind: 'cursor', peer: ANNA, x: 1 })
    frame()
    expect(view.container.textContent).toBe('1')
    const settled = reads

    for (let x = 2; x < 12; x += 1) {
      say({ kind: 'cursor', peer: ANNA, x })
      frame()
    }
    expect(reads).toBe(settled)

    say({ kind: 'cursor', peer: JAKOB, x: 1 })
    frame()
    expect(view.container.textContent).toBe('2')
    expect(reads).toBe(settled + 1)
  })
})

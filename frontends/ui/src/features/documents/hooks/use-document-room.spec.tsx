/**
 * The document room over its live channel, against a scripted room: pointer
 * motion nobody else would see is never sent, a dragged region and a cursor chat
 * ride along with the pointer, and Piloti is a peer of its own.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RoomFrame, RoomPost } from '@/lib/annotations/room-types'
import {
  createHighlightTracker,
  HIGHLIGHT_MS,
  useDocumentRoom,
  type RoomPeerState,
  type RoomTransport,
} from './use-document-room'

function scriptedRoom() {
  let deliver: ((frame: RoomFrame) => void) | null = null
  const posts: RoomPost[] = []
  const transport: RoomTransport = {
    connect({ onFrame, onOpen }) {
      deliver = onFrame
      onOpen()
      onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
      return () => {
        deliver = null
      }
    },
    post: (post) => posts.push(post),
  }
  return { transport, posts, send: (frame: RoomFrame) => act(() => deliver?.(frame)) }
}

const ANNA = { peerId: 'peer_anna_0001', userId: 'user_anna', name: 'Anna Berger', kind: 'person' as const }
const PILOTI = { peerId: 'piloti-run_42', userId: 'user_me', name: 'Piloti', kind: 'piloti' as const }

const pointerPosts = (posts: RoomPost[]) => posts.filter((post) => post.cursor !== undefined || post.viewport)

describe('useDocumentRoom', () => {
  it('streams no pointer motion while no other person is here, only where it is, for the snapshot', async () => {
    const room = scriptedRoom()
    const { result, unmount } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))

    expect(result.current.status).toBe('live')
    expect(result.current.self).toEqual({ userId: 'user_me', name: 'Miriam Hofer', kind: 'person' })
    expect(room.posts.filter((post) => post.presence === 'here')).toHaveLength(1)

    // Piloti in the room is not company for the pointer: it reads the server's snapshot.
    room.send({ kind: 'event', event: { kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 } })
    await waitFor(() => expect(result.current.peers.get()).toHaveLength(1))

    act(() => {
      for (let step = 0; step < 20; step += 1) result.current.sendCursor({ page: 1, x: step / 20, y: 0.5 }, 'select')
      for (let step = 0; step < 5; step += 1) result.current.sendViewport({ page: 1, y: 0.31 + step * 0.005 })
    })
    expect(pointerPosts(room.posts)).toEqual([
      { peerId: result.current.peerId, cursor: { page: 1, x: 0, y: 0.5 }, tool: 'select', draft: null, chat: null },
      { peerId: result.current.peerId, viewport: { page: 1, y: 0.31 } },
    ])

    act(() => result.current.sendSelection('ann_7'))
    act(() => result.current.sendSelection('ann_7'))
    expect(room.posts.filter((post) => post.selected !== undefined)).toEqual([
      { peerId: result.current.peerId, selected: 'ann_7' },
    ])

    unmount()
    expect(room.posts.at(-1)).toMatchObject({ presence: 'gone' })
  })

  it('sends the pointer with its draft and chat once somebody else is here', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    room.send({ kind: 'event', event: { kind: 'presence', peer: ANNA, state: 'here', ttlMs: 25_000 } })
    await waitFor(() => expect(result.current.peers.get()).toHaveLength(1))

    act(() => {
      result.current.sendDraft({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 })
      result.current.sendViewport({ page: 1, y: 0.3 })
    })
    await waitFor(() => expect(pointerPosts(room.posts).length).toBeGreaterThanOrEqual(2))
    act(() => result.current.sendCursor({ page: 1, x: 0.5, y: 0.5 }, 'region'))
    act(() => result.current.sendChat('  Hier fehlt die Kote  '))

    // The last pointer post: the answer to Anna's claim may land after it, a random moment later.
    await waitFor(() =>
      expect(pointerPosts(room.posts).filter((post) => post.cursor !== undefined).at(-1)).toEqual({
        peerId: result.current.peerId,
        cursor: { page: 1, x: 0.5, y: 0.5 },
        tool: 'region',
        draft: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
        chat: 'Hier fehlt die Kote',
      })
    )
    expect(room.posts.some((post) => post.viewport?.y === 0.3)).toBe(true)
  })

  it('shows a colleague’s draft and chat, and keeps them while the pointer moves', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    room.send({
      kind: 'event',
      event: {
        kind: 'cursor',
        peer: ANNA,
        cursor: { page: 1, x: 0.2, y: 0.2 },
        tool: 'region',
        draft: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        chat: 'Hier fehlt die Kote',
      },
    })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.3, y: 0.3 } } })

    await waitFor(() =>
      expect(result.current.peers.get()[0]).toMatchObject({
        peer: ANNA,
        cursor: { page: 1, x: 0.3, y: 0.3 },
        tool: 'region',
        draft: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        chat: 'Hier fehlt die Kote',
        activity: null,
      })
    )
  })

  it('shows Piloti as a peer: pointing with a label, saying what it does, highlighting, and leaving', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    const box = { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 }
    room.send({ kind: 'event', event: { kind: 'presence', peer: PILOTI, state: 'here', ttlMs: 25_000 } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: PILOTI, cursor: { page: 1, x: 0.2, y: 0.25 }, label: 'Treppe' } })
    room.send({ kind: 'event', event: { kind: 'activity', peer: PILOTI, state: 'reading', box, label: 'sieht sich Seite 1 an' } })
    room.send({ kind: 'event', event: { kind: 'highlight', peer: PILOTI, box, label: 'Laufbreite', ttlMs: 6_000 } })

    await waitFor(() =>
      expect(result.current.peers.get()).toEqual([
        expect.objectContaining({
          peer: PILOTI,
          cursor: { page: 1, x: 0.2, y: 0.25 },
          label: 'Treppe',
          activity: { state: 'reading', box, label: 'sieht sich Seite 1 an' },
          highlight: { box, label: 'Laufbreite', expiresAt: expect.any(Number) },
        }),
      ])
    )
    // Piloti is not a stranger to answer: it does not listen.
    expect(room.posts.filter((post) => post.presence === 'here')).toHaveLength(1)

    room.send({ kind: 'event', event: { kind: 'activity', peer: PILOTI, state: 'idle' } })
    await waitFor(() => expect(result.current.peers.get()[0]?.activity).toBeNull())
    room.send({ kind: 'event', event: { kind: 'presence', peer: PILOTI, state: 'gone', ttlMs: 25_000 } })
    await waitFor(() => expect(result.current.peers.get()).toEqual([]))
  })

  it('knows which Anmerkung a colleague has selected', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    room.send({ kind: 'event', event: { kind: 'viewport', peer: ANNA, viewport: { page: 2, y: 0.5 } } })
    room.send({ kind: 'event', event: { kind: 'viewport', peer: ANNA, selected: 'ann_3' } })
    await waitFor(() =>
      expect(result.current.peers.get()[0]).toMatchObject({ viewport: { page: 2, y: 0.5 }, selected: 'ann_3' })
    )
  })

  it('hears changes to the Anmerkungen, and forgets everyone when the room is revoked', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    const heard: string[][] = []
    act(() => {
      result.current.onAnnotationsChanged((event) => heard.push(event.annotationIds))
    })
    room.send({
      kind: 'event',
      event: { kind: 'annotations.changed', annotationIds: ['a1'], change: 'created', actor: { ...ANNA } },
    })
    room.send({ kind: 'event', event: { kind: 'presence', peer: ANNA, state: 'here', ttlMs: 25_000 } })
    await waitFor(() => expect(result.current.peers.get()).toHaveLength(1))
    expect(heard).toEqual([['a1']])

    room.send({ kind: 'revoked' })
    await waitFor(() => expect(result.current.peers.get()).toEqual([]))
    expect(result.current.status).toBe('offline')
  })

  it('is offline and silent when not enabled', () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: false, transport: room.transport }))
    expect(result.current.status).toBe('offline')
    expect(room.posts).toEqual([])
  })
})

describe('useDocumentRoom after it closed', () => {
  it('sends nothing once the room is gone, so a line that lingers past the review raises no ghost', () => {
    const room = scriptedRoom()
    const { result, unmount } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    const { sendChat } = result.current

    unmount()
    expect(room.posts.at(-1)).toMatchObject({ presence: 'gone' })
    const said = room.posts.length

    // `CursorChat`'s linger clears the line after the review closed.
    sendChat(null)
    expect(room.posts).toHaveLength(said)
  })
})

describe('the room as a store', () => {
  const JAKOB = { peerId: 'peer_jakob_0001', userId: 'user_jakob', name: 'Jakob Huber', kind: 'person' as const }

  it('keeps the object of a peer that did not move, so a page that reads only it is not redrawn', async () => {
    const room = scriptedRoom()
    const { result } = renderHook(() => useDocumentRoom('doc_1', { enabled: true, transport: room.transport }))
    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.1, y: 0.1 } } })
    room.send({ kind: 'event', event: { kind: 'cursor', peer: JAKOB, cursor: { page: 2, x: 0.5, y: 0.5 } } })
    await waitFor(() => expect(result.current.peers.get()).toHaveLength(2))
    const jakob = result.current.peers.get().find((state) => state.peer.peerId === JAKOB.peerId)

    room.send({ kind: 'event', event: { kind: 'cursor', peer: ANNA, cursor: { page: 1, x: 0.2, y: 0.1 } } })
    await waitFor(() =>
      expect(result.current.peers.get().find((state) => state.peer.peerId === ANNA.peerId)?.cursor?.x).toBe(0.2)
    )
    expect(result.current.peers.get().find((state) => state.peer.peerId === JAKOB.peerId)).toBe(jakob)
  })
})

describe('createHighlightTracker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const piloti = (box: { page: number; x: number; y: number; w: number; h: number }): RoomPeerState => ({
    peer: PILOTI,
    expiresAt: Date.now() + 25_000,
    cursor: null,
    movedAt: null,
    tool: 'select',
    viewport: null,
    draft: null,
    chat: null,
    label: null,
    selected: null,
    activity: null,
    highlight: { box, label: 'Breite', expiresAt: Date.now() + 60_000 },
  })

  it('shows a box Piloti points out once for the room, for its time, however often the room is read', () => {
    vi.useFakeTimers()
    const tracker = createHighlightTracker()
    const box = { page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
    const read = [piloti(box)]
    tracker.update(read)
    const shown = tracker.store.get()
    expect(shown).toHaveLength(1)
    // Every pointer frame reads the room again: nothing new, nothing redrawn, no second timer.
    for (let frame = 0; frame < 50; frame += 1) tracker.update(read)
    expect(tracker.store.get()).toBe(shown)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(HIGHLIGHT_MS + 1)
    expect(tracker.store.get()).toEqual([])
    tracker.stop()
  })
})

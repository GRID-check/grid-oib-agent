'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CURSOR_CHAT_MAX,
  CURSOR_INTERVAL_MS,
  PRESENCE_REFRESH_MS,
  roomEventSchema,
  VIEWPORT_INTERVAL_MS,
  type PilotiActivityState,
  type RoomBox,
  type RoomCursor,
  type RoomDraft,
  type RoomHighlight,
  type RoomEvent,
  type RoomFrame,
  type RoomPeer,
  type RoomPost,
  type RoomTool,
  type RoomViewport,
} from '@/lib/annotations/room-types'
import type { ChannelPostOptions, ChannelStatus } from '@/features/realtime/connection'
import type { RosterEntry } from '@/features/realtime/presence'
import {
  createSnapshotStore,
  realtimeLink,
  sameItems,
  useChannel,
  useSnapshot,
  useStoreSelector,
  type ChannelLink,
  type SnapshotStore,
} from '@/features/realtime/use-channel'

/** How a room reaches the server: the tab's live connection, or a stand-in (the specs, the `/dev` preview). */
export interface RoomTransport {
  /** Open the stream. Returns the close. */
  connect(handlers: { onFrame: (frame: RoomFrame) => void; onOpen: () => void; onDrop: () => void }): () => void
  /** `motion`: a pointer or a scroll, which the connection sheds while the server refuses it. */
  post(post: RoomPost, options?: ChannelPostOptions): void
}

/** The live channel key of a document's room. */
export const documentRoomChannel = (documentId: string) => `doc:${documentId}`

/**
 * The production transport: the document's `doc:<id>` channel on the tab's one
 * `GET /api/realtime` stream, and `POST /api/realtime/send` up
 * (`features/realtime`, ADR-0110). Kept under its old name for the callers
 * that name it.
 */
export function sseRoomTransport(documentId: string): RoomTransport {
  const link = realtimeLink<RoomPost>(documentRoomChannel(documentId))
  return {
    connect: ({ onFrame, onOpen, onDrop }) =>
      link.connect({
        onOpen,
        onDrop,
        onFrame: (frame) => {
          if (frame.kind !== 'event') return onFrame(frame)
          const parsed = roomEventSchema.safeParse(frame.event)
          if (parsed.success) onFrame({ kind: 'event', event: parsed.data })
        },
      }),
    post: (post, options) => link.post(post, options),
  }
}

/** What Piloti is doing on the document, while it works on it. */
export interface RoomActivityState {
  state: PilotiActivityState
  /** The region it is reading, when it reads one. */
  box: RoomBox | null
  label: string | null
}

/** A box Piloti shows for a moment; draw it until `expiresAt`. */
export interface RoomHighlightState {
  box: RoomHighlight['box']
  label: string | null
  /** ms since the epoch. */
  expiresAt: number
}

/** One other viewer, as this tab knows them now. */
export interface RoomPeerState {
  peer: RoomPeer
  /** Where their pointer is on the pages; null when it is off them. */
  cursor: RoomCursor | null
  /** When their pointer last moved, ms since the epoch: a pointer still for long reads as idle. */
  movedAt: number | null
  tool: RoomTool
  viewport: RoomViewport | null
  /** The region they are dragging out, on their cursor's page; null when none. */
  draft: RoomDraft | null
  /** Their cursor chat; null when none. */
  chat: string | null
  /** The words beside their pointer (Piloti saying what it points at); null when none. */
  label: string | null
  /** The Anmerkung they have selected; null when none. */
  selected: string | null
  /** Piloti's activity, for a peer of kind `piloti`; null for a person. */
  activity: RoomActivityState | null
  /** Piloti's latest highlight; null when none. Stale once past `expiresAt`. */
  highlight: RoomHighlightState | null
  /** When their presence claim runs out, ms since the epoch. */
  expiresAt: number
}

export type RoomStatus = ChannelStatus

type PeerFields = Omit<RoomPeerState, 'peer' | 'expiresAt'>

const NOBODY: PeerFields = {
  cursor: null,
  movedAt: null,
  tool: 'select',
  viewport: null,
  draft: null,
  chat: null,
  label: null,
  selected: null,
  activity: null,
  highlight: null,
}

/** While nobody else is here, the pointer and the view go up at most this often, and only when they moved on. */
const ALONE_INTERVAL_MS = 1_000

/** Fold one of a peer's events into what this tab knows of them; null takes them out of the room. */
export function reduceRoomPeer(state: PeerFields, event: RoomEvent): PeerFields | null {
  switch (event.kind) {
    case 'cursor':
      return {
        ...state,
        cursor: event.cursor,
        movedAt: event.cursor ? Date.now() : state.movedAt,
        tool: event.tool ?? state.tool,
        draft: event.draft !== undefined ? event.draft : state.draft,
        chat: event.chat !== undefined ? event.chat || null : state.chat,
        label: event.label ?? null,
      }
    case 'viewport':
      return {
        ...state,
        viewport: event.viewport ?? state.viewport,
        selected: event.selected !== undefined ? event.selected : state.selected,
      }
    case 'activity':
      if (event.state === 'idle') return { ...state, activity: null }
      return { ...state, activity: { state: event.state, box: event.box ?? null, label: event.label ?? null } }
    case 'highlight':
      return { ...state, highlight: { box: event.box, label: event.label ?? null, expiresAt: Date.now() + event.ttlMs } }
    default:
      return state
  }
}

const ROOM_PRESENCE = {
  refreshMs: PRESENCE_REFRESH_MS,
  initial: (): PeerFields => NOBODY,
  reduce: reduceRoomPeer,
}

const parseRoomEvent = (value: unknown): RoomEvent | null => {
  const parsed = roomEventSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

type AnnotationsChanged = Extract<RoomEvent, { kind: 'annotations.changed' }>

/** A box Piloti points out on a page, with what it says about it. */
export interface PilotiHighlight {
  page: number
  x: number
  y: number
  w: number
  h: number
  label: string | null
}

/** How long a box Piloti pointed out stays on the page, unless it points out the next one first. */
export const HIGHLIGHT_MS = 6_000

/**
 * What Piloti points out, read off its peer: its latest highlight while it
 * lasts, else the region its activity says it is reading.
 */
export function pilotiHighlightOf(state: RoomPeerState, now = Date.now()): PilotiHighlight | null {
  if (state.peer.kind !== 'piloti') return null
  if (state.highlight && state.highlight.expiresAt > now) {
    return { ...state.highlight.box, label: state.highlight.label }
  }
  const box = state.activity?.box
  return box ? { ...box, label: state.activity?.label ?? null } : null
}

export type ShownHighlight = PilotiHighlight & { key: string; peerId: string }

/**
 * The boxes Piloti pointed out, each shown until it points out the next or
 * {@link HIGHLIGHT_MS} passes: a highlight is a gesture, not a mark. Kept once
 * per room, not per page drawn: one timer per box, however many pages and
 * viewers show it.
 */
export function createHighlightTracker() {
  const store = createSnapshotStore<readonly ShownHighlight[]>([])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let signature = ''
  return {
    store: store as SnapshotStore<readonly ShownHighlight[]>,
    /** Read the peers again; only a different set of boxes changes anything. */
    update(peers: readonly RoomPeerState[]) {
      const arrived = peers.flatMap((state) => {
        const highlight = pilotiHighlightOf(state)
        if (!highlight) return []
        const key = `${state.peer.peerId}:${highlight.page}:${highlight.x}:${highlight.y}:${highlight.w}:${highlight.h}:${highlight.label ?? ''}`
        return [{ ...highlight, key, peerId: state.peer.peerId }]
      })
      const next = arrived.map((highlight) => highlight.key).join('|')
      if (next === signature) return
      signature = next
      if (arrived.length === 0) return
      const before = store.get()
      store.set([
        ...before.filter((old) => !arrived.some((fresh) => fresh.peerId === old.peerId)),
        ...arrived.filter((fresh) => !before.some((old) => old.key === fresh.key)),
        ...before.filter((old) => arrived.some((fresh) => fresh.key === old.key)),
      ])
      for (const highlight of arrived) {
        if (timers.has(highlight.key)) continue
        timers.set(
          highlight.key,
          setTimeout(() => {
            timers.delete(highlight.key)
            store.set(store.get().filter((old) => old.key !== highlight.key))
          }, HIGHLIGHT_MS)
        )
      }
    },
    stop() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      signature = ''
      store.set([])
    },
  }
}

/**
 * The roster as the room reads it: each entry flattened into a
 * {@link RoomPeerState}, and a peer that did not change keeps the object it
 * had, so a selector over the peers of one page compares them by identity.
 */
export function roomPeersOf(
  roster: SnapshotStore<readonly RosterEntry<PeerFields>[]>
): SnapshotStore<readonly RoomPeerState[]> {
  const flat = new WeakMap<RosterEntry<PeerFields>, RoomPeerState>()
  let source: readonly RosterEntry<PeerFields>[] | null = null
  let peers: readonly RoomPeerState[] = []
  return {
    get() {
      const entries = roster.get()
      if (entries === source) return peers
      source = entries
      peers = entries.map((entry) => {
        const known = flat.get(entry)
        if (known) return known
        const state: RoomPeerState = { peer: entry.peer, expiresAt: entry.expiresAt, ...entry.state }
        flat.set(entry, state)
        return state
      })
      return peers
    },
    subscribe: roster.subscribe,
  }
}

/**
 * This tab in a document's room: who else is looking, where their pointers
 * are and what they are dragging out, where they are scrolled to, what Piloti
 * is reading, and that the Anmerkungen changed (`lib/annotations/room-types.ts`).
 *
 * A thin adapter over the `doc:<id>` live channel (`features/realtime`): the
 * presence gossip, the connection and the throttling are the channel's. What is
 * the room's own: pointers go up at most every 80ms with the dragged region and
 * the cursor chat riding along, viewports every 200ms, the selection when it
 * changes. While no other person is in the room the motion is not sent at all:
 * only where the pointer and the view are (page, draft, roughly where on the
 * page), at most once a second, for the server's snapshot that Piloti reads
 * (`roomSnapshot`). A receiver glides between pointer updates (`LiveCursor`),
 * so twelve a second read as continuous motion.
 */
export function useDocumentRoom(
  documentId: string,
  { enabled, transport }: { enabled: boolean; transport?: RoomTransport }
) {
  const link = useMemo<ChannelLink>(() => {
    const room = transport ?? sseRoomTransport(documentId)
    return {
      connect: (handlers) => room.connect(handlers),
      post: (msg, options) => room.post(msg as RoomPost, options),
    }
  }, [transport, documentId])
  const listeners = useRef(new Set<(event: AnnotationsChanged) => void>())
  const pointer = useRef<{ cursor: RoomCursor | null; tool: RoomTool; draft: RoomDraft | null; chat: string | null }>({
    cursor: null,
    tool: 'select',
    draft: null,
    chat: null,
  })

  const onEvent = useCallback((event: RoomEvent) => {
    if (event.kind !== 'annotations.changed') return
    for (const listener of [...listeners.current]) listener(event)
  }, [])

  const channel = useChannel<RoomEvent, PeerFields>(documentRoomChannel(documentId), {
    enabled,
    link,
    parse: parseRoomEvent,
    onEvent,
    presence: ROOM_PRESENCE,
  })
  const { send } = channel

  const { roster } = channel
  const peers = useMemo(() => roomPeersOf(roster), [roster])
  // Piloti's highlights, once for the room: every page and both viewers read the same boxes.
  const [highlights] = useState(createHighlightTracker)
  useEffect(() => {
    const update = () => highlights.update(peers.get())
    update()
    const unsubscribe = peers.subscribe(update)
    return () => {
      unsubscribe()
      highlights.stop()
    }
  }, [peers, highlights])

  const { peerCount } = channel
  /** Whether a person besides this tab is here: Piloti reads the server's snapshot, not the pointer stream. */
  const company = useCallback(() => peerCount((peer) => peer.kind === 'person') > 0, [peerCount])
  /** What was last sent while alone, so moving within one page alone sends nothing. */
  const aloneSent = useRef({ pointer: '', viewport: '' })
  const view = useRef<{ viewport: RoomViewport | null; selected: string | null }>({ viewport: null, selected: null })

  const pushPointer = useCallback(() => {
    const { cursor, tool, draft, chat } = pointer.current
    const message = { cursor, tool, draft, chat }
    if (company()) {
      aloneSent.current.pointer = ''
      send(message, { throttleMs: CURSOR_INTERVAL_MS, lane: 'cursor' })
      return
    }
    // Alone: no motion, only where the pointer is (its page, the draft, the chat), for the server's snapshot.
    const summary = JSON.stringify([cursor?.page ?? null, tool, draft, chat])
    if (summary === aloneSent.current.pointer) return
    aloneSent.current.pointer = summary
    send(message, { throttleMs: ALONE_INTERVAL_MS, lane: 'cursor-alone' })
  }, [company, send])

  /** Say where this tab's pointer is on the pages (null: off them), and what it is doing. */
  const sendCursor = useCallback(
    (cursor: RoomCursor | null, tool: RoomTool = pointer.current.tool) => {
      pointer.current = { ...pointer.current, cursor, tool, draft: cursor ? pointer.current.draft : null }
      pushPointer()
    },
    [pushPointer]
  )

  /** Show the others the region this tab is dragging out, on the pointer's page; null when it is done. */
  const sendDraft = useCallback(
    (draft: RoomDraft | null) => {
      pointer.current = { ...pointer.current, draft }
      pushPointer()
    },
    [pushPointer]
  )

  /** Show a line of cursor chat beside this tab's pointer; null or empty clears it. */
  const sendChat = useCallback(
    (text: string | null) => {
      const chat = text?.trim().slice(0, CURSOR_CHAT_MAX) || null
      pointer.current = { ...pointer.current, chat }
      pushPointer()
    },
    [pushPointer]
  )

  const sendViewport = useCallback(
    (viewport: RoomViewport) => {
      view.current = { ...view.current, viewport }
      if (company()) {
        aloneSent.current.viewport = ''
        send({ viewport }, { throttleMs: VIEWPORT_INTERVAL_MS, lane: 'viewport' })
        return
      }
      // Alone: the page and roughly where on it, for the snapshot; not every scroll step.
      const summary = `${viewport.page}:${Math.round(viewport.y * 10)}`
      if (summary === aloneSent.current.viewport) return
      aloneSent.current.viewport = summary
      send({ viewport }, { throttleMs: ALONE_INTERVAL_MS, lane: 'viewport-alone' })
    },
    [company, send]
  )

  /** Say which Anmerkung this tab has selected (null: none). Rare, so never throttled, and sent alone too. */
  const sendSelection = useCallback(
    (annotationId: string | null) => {
      if (view.current.selected === annotationId) return
      view.current = { ...view.current, selected: annotationId }
      send({ selected: annotationId })
    },
    [send]
  )

  /** Hear about changes to the Anmerkungen; returns the unsubscribe. */
  const onAnnotationsChanged = useCallback((listener: (event: AnnotationsChanged) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  const { peerId, status, self } = channel
  return useMemo(
    () => ({
      peerId,
      status,
      self,
      /** Who else is here, as a store: read it with {@link useRoomPeers} or {@link useRoomSelector}, never in the host's render. */
      peers,
      /** The boxes Piloti points out now; see {@link createHighlightTracker}. */
      highlights: highlights.store,
      sendCursor,
      sendViewport,
      sendDraft,
      sendChat,
      sendSelection,
      onAnnotationsChanged,
    }),
    [peerId, status, self, peers, highlights, sendCursor, sendViewport, sendDraft, sendChat, sendSelection, onAnnotationsChanged]
  )
}

export type DocumentRoom = ReturnType<typeof useDocumentRoom>

/** Everyone in the room, re-rendering whenever anyone moves: for what draws pointers. */
export const useRoomPeers = (room: Pick<DocumentRoom, 'peers'>): readonly RoomPeerState[] => useSnapshot(room.peers)

/** What `select` reads of the room's peers, re-rendering only when that changed by `equal`. */
export const useRoomSelector = <R,>(
  room: Pick<DocumentRoom, 'peers'>,
  select: (peers: readonly RoomPeerState[]) => R,
  equal?: (a: R, b: R) => boolean
): R => useStoreSelector(room.peers, select, equal)

/** The peers whose pointer or box is on one page, compared by identity: a pointer on another page re-renders nothing here. */
export const usePeersOnPage = (room: Pick<DocumentRoom, 'peers'>, page: number): readonly RoomPeerState[] =>
  useStoreSelector(room.peers, (peers) => peers.filter((state) => state.cursor?.page === page), sameItems)

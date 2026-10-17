'use client'

/**
 * One live channel in a component (ADR-0110): its status, who the server takes
 * this tab to be, the gossip roster when the channel has presence, and a
 * throttled `send`.
 *
 * The channel reaches the server through a {@link ChannelLink}: by default the
 * tab's shared connection (`./connection`), or a scripted stand-in in specs and
 * `/dev` previews.
 *
 * The roster is an external store (`roster`): its snapshot moves once per
 * animation frame at most, and only what subscribes to it re-renders, through
 * {@link useSnapshot} or {@link useRosterSelector} with a selector that says
 * what it reads. The component that opened the channel does not re-render
 * when a pointer moves, so a room of pointers redraws the pointers, not the
 * surface under them. A peer that did not change keeps its entry object
 * (`./presence`), so a selector can compare peers by identity.
 *
 * Once the channel closes (unmount, a disabled hook, another link), this tab's
 * peer has said `gone`, and nothing more goes up under its `peerId`: a late
 * send from a timer that outlived the component would put the peer back in
 * everyone's roster for a lease, a ghost of a tab that left.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RealtimeSelf, UpstreamBase } from '@/lib/realtime/types'
import {
  getRealtimeConnection,
  type ChannelPostOptions,
  type ChannelStatus,
  type RealtimeConnection,
} from './connection'
import { createRoster, type PeerEvent, type RosterEntry } from './presence'

/** One channel's share of the stream, as a link delivers it. */
export type ChannelFrame =
  | { kind: 'event'; event: unknown }
  | { kind: 'welcome'; self: RealtimeSelf }
  | { kind: 'revoked' }

/** How one channel reaches the server. The seam specs and `/dev` previews script. */
export interface ChannelLink<TUp extends UpstreamBase = UpstreamBase> {
  /** Open the channel. Returns the close. */
  connect(handlers: { onFrame: (frame: ChannelFrame) => void; onOpen: () => void; onDrop: () => void }): () => void
  post(msg: TUp, options?: ChannelPostOptions): void
}

/** The production link: the channel on the tab's shared connection. */
export function realtimeLink<TUp extends UpstreamBase>(
  ch: string,
  connection: RealtimeConnection = getRealtimeConnection()
): ChannelLink<TUp> {
  return {
    connect({ onFrame, onOpen, onDrop }) {
      let last: ChannelStatus | null = null
      return connection.join(ch, {
        onEvent: (event) => onFrame({ kind: 'event', event }),
        onWelcome: (self) => onFrame({ kind: 'welcome', self }),
        onClosed: () => onFrame({ kind: 'revoked' }),
        onStatus: (status) => {
          if (status === last) return
          last = status
          if (status === 'live') onOpen()
          else if (status === 'offline') onDrop()
        },
      })
    },
    post: (msg, options) => connection.send(ch, msg, options),
  }
}

export interface SendOptions {
  /**
   * Send at most once per this many ms, always the latest message, and the
   * last one for sure. A throttled lane is motion: the connection sheds it
   * while the server refuses the channel's motion. Unthrottled is a claim.
   */
  throttleMs?: number
  /** Messages throttle per lane; a pointer must not wait behind a scroll. Default `default`. */
  lane?: string
}

export interface ChannelOptions<E, S> {
  enabled: boolean
  /** Defaults to {@link realtimeLink}. Keep it stable (memoize): a new link reconnects. */
  link?: ChannelLink
  /** The channel's vocabulary: an event, or null to drop what does not parse. */
  parse(event: unknown): E | null
  /** Every parsed event, including those the roster consumed. */
  onEvent?(event: E): void
  /** A gossip roster: peers' state, folded from their events. Keep it stable. */
  presence?: {
    refreshMs: number
    leaseMs?: number
    initial(peer: RosterEntry<S>['peer']): S
    reduce(state: S, event: E): S | null
  }
}

/**
 * A value that changes outside React, read with `useSyncExternalStore`: the
 * roster of a channel, and what a feature derives from it. `get` returns the
 * same snapshot until a listener is told it moved.
 */
export interface SnapshotStore<T> {
  get(): T
  subscribe(listener: () => void): () => void
}

/** A store whose snapshot the owner sets. */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> & { set(next: T): void } {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      if (Object.is(next, snapshot)) return
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A store that never moves: a fixed roster for specs and previews. */
export const fixedStore = <T,>(value: T): SnapshotStore<T> => ({ get: () => value, subscribe: () => () => {} })

/** The whole snapshot: re-renders whenever it moves. */
export function useSnapshot<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * What `select` reads of a store, re-rendering only when that changed by
 * `equal` (default `Object.is`). The selector may be an inline closure: it is
 * run again when the snapshot or the selector changes, and a result equal to
 * the last keeps the last one's identity.
 */
export function useStoreSelector<T, R>(
  store: SnapshotStore<T>,
  select: (snapshot: T) => R,
  equal: (a: R, b: R) => boolean = Object.is
): R {
  const last = useRef<{ source: T; select: (snapshot: T) => R; result: R } | null>(null)
  const read = (): R => {
    const source = store.get()
    const memo = last.current
    if (memo && memo.source === source && memo.select === select) return memo.result
    const next = select(source)
    const result = memo && equal(memo.result, next) ? memo.result : next
    last.current = { source, select, result }
    return result
  }
  return useSyncExternalStore(store.subscribe, read, read)
}

/** Two lists with the same items, by identity, in the same order: a selector's `equal` over roster entries. */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
}

/** What a selector reads of a channel's roster; see {@link useStoreSelector}. */
export const useRosterSelector = <S, R>(
  roster: SnapshotStore<readonly RosterEntry<S>[]>,
  select: (entries: readonly RosterEntry<S>[]) => R,
  equal?: (a: R, b: R) => boolean
) => useStoreSelector(roster, select, equal)

const NOBODY: readonly never[] = []

const newPeerId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
    : Math.random().toString(36).slice(2, 22).padEnd(12, '0')

/** A sender that sends at most once per `interval`, always the latest value, and the last one for sure. */
function throttle<T>(interval: number, send: (value: T) => void) {
  let last = 0
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    if (!pending) return
    last = Date.now()
    const { value } = pending
    pending = null
    send(value)
  }
  return {
    push(value: T) {
      pending = { value }
      const wait = interval - (Date.now() - last)
      if (wait <= 0) flush()
      else timer ??= setTimeout(flush, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}

type Message = Record<string, unknown>

export function useChannel<E extends PeerEvent, S = undefined>(
  ch: string | null,
  { enabled, link: given, parse, onEvent, presence }: ChannelOptions<E, S>
) {
  const peerId = useMemo(newPeerId, [])
  const link = useMemo(() => given ?? (ch ? realtimeLink(ch) : null), [given, ch])
  const active = enabled && link !== null
  const [status, setStatus] = useState<ChannelStatus>('connecting')
  const [self, setSelf] = useState<RealtimeSelf | null>(null)
  const [store] = useState(() => createSnapshotStore<readonly RosterEntry<S>[]>(NOBODY))
  const frame = useRef<number | null>(null)
  const handlers = useRef({ parse, onEvent })
  handlers.current = { parse, onEvent }
  const lanes = useRef(new Map<string, ReturnType<typeof throttle<Message>>>())
  const roster = useRef<ReturnType<typeof createRoster<E, S>> | null>(null)
  /** The link the channel is open on; null once it closed, undefined before it first opened. */
  const openOn = useRef<ChannelLink | null | undefined>(undefined)

  const commit = useCallback(() => {
    if (frame.current !== null) return
    const run = () => {
      frame.current = null
      store.set(roster.current?.entries() ?? NOBODY)
    }
    frame.current =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number)
  }, [store])

  useEffect(() => {
    if (!active || !link) return
    const post = (msg: Message) => link.post({ ...msg, peerId } as UpstreamBase)
    const list = presence
      ? createRoster<E, S>({
          selfPeerId: peerId,
          refreshMs: presence.refreshMs,
          leaseMs: presence.leaseMs,
          initial: presence.initial,
          reduce: presence.reduce,
          say: (state) => post({ presence: state }),
          onChange: commit,
        })
      : null
    roster.current = list
    openOn.current = link
    const lanesNow = lanes.current

    setStatus('connecting')
    const close = link.connect({
      onOpen: () => {
        setStatus('live')
        list?.hello()
      },
      onDrop: () => setStatus('offline'),
      onFrame: (next) => {
        if (next.kind === 'welcome') {
          setSelf(next.self)
          setStatus('live')
          return
        }
        if (next.kind === 'revoked') {
          setStatus('offline')
          list?.clear()
          return
        }
        const event = handlers.current.parse(next.event)
        if (!event) return
        list?.observe(event)
        handlers.current.onEvent?.(event)
      },
    })
    list?.start()
    return () => {
      for (const lane of lanesNow.values()) lane.cancel()
      lanesNow.clear()
      list?.stop()
      // After the `gone`: whatever is still on its way under this peer stays here.
      openOn.current = null
      roster.current = null
      close()
      store.set(NOBODY)
    }
  }, [active, link, peerId, presence, commit, store])

  useEffect(
    () => () => {
      if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
    },
    []
  )

  /** Say something in the channel; the tab's `peerId` is added. */
  const send = useCallback(
    (msg: Message, { throttleMs = 0, lane = 'default' }: SendOptions = {}) => {
      if (!active || !link) return
      const deliver = (value: Message) => {
        // A send that outlived the channel (a component's timer, a stale callback) says nothing.
        if (openOn.current !== undefined && openOn.current !== link) return
        link.post({ ...value, peerId } as UpstreamBase, { motion: throttleMs > 0 })
      }
      if (throttleMs <= 0) {
        deliver(msg)
        return
      }
      let sender = lanes.current.get(lane)
      if (!sender) {
        sender = throttle<Message>(throttleMs, deliver)
        lanes.current.set(lane, sender)
      }
      sender.push(msg)
    },
    [active, link, peerId]
  )

  /** How many others (that `which` accepts) are in the channel now, from the roster's ref: no render needed to ask. */
  const peerCount = useCallback(
    (which?: (peer: RosterEntry<S>['peer']) => boolean) =>
      which ? (roster.current?.entries().filter((entry) => which(entry.peer)).length ?? 0) : (roster.current?.size ?? 0),
    []
  )

  return {
    peerId,
    status: active ? status : ('offline' as ChannelStatus),
    self,
    /** Who else is here, as a store; see {@link useSnapshot} and {@link useRosterSelector}. */
    roster: store as SnapshotStore<readonly RosterEntry<S>[]>,
    send,
    peerCount,
  }
}

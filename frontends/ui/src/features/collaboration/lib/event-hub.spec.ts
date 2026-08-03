/**
 * The one connection every live consumer shares, and how it behaves when the
 * server goes away.
 *
 * Two of these properties are cost properties before they are correctness ones:
 * "one `EventSource` however many subscribers" is what stops a single tab from
 * holding five server connections with five Redis subscribers behind them, and
 * the backoff ladder is what stops a rolling deploy from turning into a retry
 * storm on `/api/stream`. The rest is about not making things worse than the
 * outage already is: the ladder must forget an outage the tab has recovered
 * from, and a single bad frame must not cost a listener its connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetEventHub,
  subscribeToEvents,
  type CollaborationEvent,
} from './event-hub'

/** A controllable stand-in for the browser's EventSource. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  /** Deliver a raw SSE payload, valid or not. */
  emit(data: string): void {
    this.onmessage?.({ data })
  }

  /** Deliver a well-formed `{ id, at, event }` envelope. */
  deliver(event: unknown): void {
    this.emit(JSON.stringify({ id: 'evt_1', at: 1_700_000_000_000, event }))
  }
}

/** The connection the hub is currently on — a reconnect makes a new one. */
function live(): FakeEventSource {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]
}

const inboxChanged: CollaborationEvent = { kind: 'inbox.changed', pending: 3 }

describe('event hub', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    __resetEventHub()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens one connection for any number of subscribers and fans out to all of them', () => {
    const badge = vi.fn()
    const list = vi.fn()
    const thread = vi.fn()
    subscribeToEvents(badge)
    subscribeToEvents(list)
    subscribeToEvents(thread)

    // A connection per hook would be four or five sockets per tab, each with its
    // own subscriber on the server side.
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(live().url).toBe('/api/stream')

    live().deliver(inboxChanged)
    for (const listener of [badge, list, thread]) {
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(inboxChanged)
    }
  })

  it('holds the connection until the last subscriber leaves, then drops it', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribeToEvents(first)
    const unsubscribeSecond = subscribeToEvents(second)

    // Closing on the first unsubscribe would blind everyone else in the tab.
    unsubscribeFirst()
    expect(live().closed).toBe(false)
    live().deliver(inboxChanged)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    // Nobody is listening any more: a socket left open here outlives the last
    // consumer for as long as the tab does.
    unsubscribeSecond()
    expect(live().closed).toBe(true)

    // And the hub is reusable afterwards rather than stuck closed.
    subscribeToEvents(vi.fn())
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(live().closed).toBe(false)
  })

  it('backs off between reconnects instead of hammering the route', () => {
    // The failure mode this rules out is a retry every tick after a pod restart:
    // every dropped tab reconnecting immediately, each attempt costing an
    // authorization read and a fresh cache subscriber.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1) // top of the jitter window
    subscribeToEvents(vi.fn())

    live().onerror?.()
    expect(live().closed).toBe(true)
    vi.advanceTimersByTime(1_999)
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(2)

    // The second wait is longer than the first — the ladder climbs, it does not
    // sit on a constant delay.
    live().onerror?.()
    vi.advanceTimersByTime(3_999)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(3)
  })

  it('forgets an outage the connection has since recovered from', () => {
    // A tab can climb to the 30s cap during a deploy and then run healthy for an
    // hour. Without a reset on `onopen` the next single blip costs that tab half
    // a minute of live updates for no reason at all.
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(1)
    subscribeToEvents(vi.fn())

    for (let attempt = 0; attempt < 5; attempt += 1) {
      live().onerror?.()
      vi.advanceTimersByTime(60_000)
    }

    // Premise: the ladder really is at the cap now — a 2s wait is not enough.
    const atCap = FakeEventSource.instances.length
    live().onerror?.()
    vi.advanceTimersByTime(2_000)
    expect(FakeEventSource.instances).toHaveLength(atCap)
    vi.advanceTimersByTime(28_000)
    expect(FakeEventSource.instances).toHaveLength(atCap + 1)

    // Evidence the connection works again, so the count of *consecutive*
    // failures is one from here, not six.
    live().onopen?.()
    const recovered = FakeEventSource.instances.length
    live().onerror?.()
    vi.advanceTimersByTime(2_000)
    expect(FakeEventSource.instances).toHaveLength(recovered + 1)
  })

  it('drops a malformed frame without taking the connection down', () => {
    const listener = vi.fn()
    subscribeToEvents(listener)
    const source = live()

    source.emit('<html>502 Bad Gateway</html>')
    source.emit(JSON.stringify({ id: 'evt_1', at: 1 })) // envelope, no event
    source.deliver({ pending: 1 }) // event, no discriminator
    source.deliver(null)

    expect(listener).not.toHaveBeenCalled()
    // The connection is the expensive thing; a bad frame is cheap. Throwing out
    // of `onmessage` would cost every consumer in the tab its live updates over
    // one unparseable byte — and the whole design says a dropped hint is
    // survivable, because correctness comes from the refetch.
    expect(source.closed).toBe(false)
    expect(FakeEventSource.instances).toHaveLength(1)

    source.deliver(inboxChanged)
    expect(listener).toHaveBeenCalledWith(inboxChanged)
  })
})

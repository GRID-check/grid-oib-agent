/**
 * Per-user event bus for live collaboration updates (ADR-0035 §9, spec RT-1…RT-8).
 *
 * **What this is NOT:** a store. The database is the system of record. Dragonfly
 * runs `cache_mode=true` with no persistence volume and evicts under memory
 * pressure (ADR-0020), so a notification that existed only here could vanish
 * unseen. Every event published here is a *hint that something changed*; the
 * receiver's correctness comes from re-reading Postgres.
 *
 * **Authorization happens at publish time.** Events go to per-USER channels
 * (`user:<id>:events`), never per-resource channels. The server resolves a
 * resource's participants and publishes to each one's own channel, so a
 * subscriber can only ever receive what was addressed to them and there is no
 * shared channel to accidentally over-subscribe to. Browsers never filter
 * locally.
 *
 * **Fail-open.** With no `REDIS_URL` the transport is an in-process emitter:
 * correct on a single replica (dev, tests, the single-node Coolify deployment)
 * and byte-identical in behaviour to the multi-replica path from a caller's
 * point of view. Every Redis operation is wrapped so an outage degrades to
 * local-only delivery instead of failing the request that triggered it.
 *
 * Mirrors the design of the Python tier's `conversation_bus.py` deliberately:
 * injectable transport, JSON envelopes, fail-open, unit-testable over the
 * in-memory transport with two bus instances standing in for two replicas.
 */

import 'server-only'
import type { InboxItemType, ShareableResourceType } from '@/lib/db/schema'

/** Channel a single user's live updates flow on. */
export function userChannel(userId: string): string {
  return `user:${userId}:events`
}

/**
 * Event kinds. Each is a HINT — it names what changed and where, never the
 * authoritative content. A receiver that trusts a payload instead of re-reading
 * is a bug, because a dropped or stale event must not be able to corrupt state.
 */
export type CollaborationEvent =
  | {
      kind: 'inbox.changed'
      /** Cheap badge refresh without a fetch; the list itself is still re-read. */
      pending: number
      itemType?: InboxItemType
    }
  | {
      kind: 'conversation.message'
      conversationId: string
      /** So a client can ignore the echo of its own write. */
      authorUserId: string | null
      messageId: string
    }
  | {
      kind: 'conversation.turn'
      conversationId: string
      /** `started` shows "Piloti is answering X's question"; `ended` clears it. */
      phase: 'started' | 'ended'
      /** Who asked — the observer's banner names them. */
      actorUserId: string | null
    }
  | {
      kind: 'conversation.awaiting'
      conversationId: string
      /** WorkOS user ids the thread is waiting on; empty means the wait cleared. */
      awaitingUserIds: string[]
    }
  | {
      kind: 'resource.access.changed'
      resourceType: ShareableResourceType
      resourceId: string
      /** `revoked` tells a client to drop the resource from view immediately. */
      change: 'granted' | 'revoked' | 'visibility'
    }

export interface EventEnvelope {
  /** Monotonic-ish id for debugging; NOT a resume cursor (Postgres is the truth). */
  id: string
  at: string
  event: CollaborationEvent
}

/** The pluggable transport, so the protocol is testable without Redis. */
export interface EventTransport {
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>
}

/**
 * In-process transport. Correct for a single replica; used whenever `REDIS_URL`
 * is unset (dev, tests, single-node deployments).
 */
export class InProcessTransport implements EventTransport {
  private subscribers = new Map<string, Set<(payload: string) => void>>()

  async publish(channel: string, payload: string): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) {
      // Isolate handlers: one throwing subscriber must not stop delivery to the rest.
      try {
        handler(payload)
      } catch (error) {
        console.warn('[events] in-process subscriber threw:', error)
      }
    }
  }

  async subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>> {
    const set = this.subscribers.get(channel) ?? new Set()
    set.add(onMessage)
    this.subscribers.set(channel, set)
    return async () => {
      const current = this.subscribers.get(channel)
      if (!current) return
      current.delete(onMessage)
      if (current.size === 0) this.subscribers.delete(channel)
    }
  }
}

/**
 * Redis-protocol transport (Dragonfly).
 *
 * A subscriber connection cannot issue normal commands, so publishing and
 * subscribing use separate clients — the publisher is shared and long-lived,
 * each subscription gets its own short-lived client it closes on teardown.
 * Timeouts are tight so a cache outage degrades quickly rather than hanging a
 * request (same posture as `@/lib/cache`).
 */
export class RedisTransport implements EventTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publisher: any
  private readonly url: string

  constructor(url: string) {
    this.url = url
    this.publisher = createRedisClient(url)
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.publisher.publish(channel, payload)
  }

  async subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>> {
    const client = createRedisClient(this.url)
    await client.subscribe(channel)
    client.on('message', (_channel: string, payload: string) => {
      try {
        onMessage(payload)
      } catch (error) {
        console.warn('[events] redis subscriber threw:', error)
      }
    })
    return async () => {
      try {
        await client.unsubscribe(channel)
      } catch {
        // Best effort — we are tearing down anyway.
      }
      try {
        client.disconnect()
      } catch {
        // Same.
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createRedisClient(url: string): any {
  // Lazy require keeps ioredis out of bundles that never set REDIS_URL.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  })
  client.on('error', (error: unknown) => {
    console.warn('[events] redis transport error:', error)
  })
  return client
}

let transport: EventTransport | null = null
/**
 * The in-process transport is ALSO used as the local fan-out when Redis is
 * configured: a publish goes to Redis for other replicas and to the local
 * emitter for subscribers on this one, because a Redis publisher does not echo
 * to its own process's subscriber clients reliably enough to depend on.
 */
let local: InProcessTransport | null = null

function getLocal(): InProcessTransport {
  if (!local) local = new InProcessTransport()
  return local
}

function getTransport(): EventTransport | null {
  if (transport) return transport
  const url = process.env.REDIS_URL
  if (!url) return null
  try {
    transport = new RedisTransport(url)
    return transport
  } catch (error) {
    console.warn('[events] failed to create redis transport, staying local-only:', error)
    return null
  }
}

/** Test seam: force a transport (or `null` for local-only) and reset local state. */
export function __setTransportForTests(next: EventTransport | null): void {
  transport = next
  local = new InProcessTransport()
}

let counter = 0

function envelope(event: CollaborationEvent): EventEnvelope {
  counter += 1
  return { id: `${Date.now().toString(36)}-${counter}`, at: new Date().toISOString(), event }
}

/**
 * Publish an event to one user's channel.
 *
 * NEVER throws: a delivery failure must not fail the user action that caused it.
 * The event is a latency optimisation — the receiver would converge anyway on
 * its next fetch (spec RT-4).
 */
export async function publishToUser(userId: string, event: CollaborationEvent): Promise<void> {
  const payload = JSON.stringify(envelope(event))
  const channel = userChannel(userId)

  // Local subscribers first: this is the path that works with no Redis at all.
  await getLocal().publish(channel, payload)

  const remote = getTransport()
  if (!remote) return
  try {
    await remote.publish(channel, payload)
  } catch (error) {
    console.warn('[events] publish failed (degrading to local-only):', error)
  }
}

/**
 * Publish the same event to several users — the participant fan-out.
 *
 * Deliberately N publishes rather than one broadcast: it is what makes the
 * authorization argument trivial (a user's channel only ever carries what was
 * addressed to them). Fine at present scale; revisit for very large rosters.
 */
export async function publishToUsers(userIds: readonly string[], event: CollaborationEvent): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean)
  await Promise.all(unique.map((userId) => publishToUser(userId, event)))
}

/**
 * Subscribe to one user's channel. Returns an unsubscribe function that MUST be
 * called (the SSE route calls it when the client disconnects), or subscriber
 * clients leak.
 */
export async function subscribeUser(
  userId: string,
  onEvent: (envelope: EventEnvelope) => void,
): Promise<() => Promise<void>> {
  const channel = userChannel(userId)
  const handle = (payload: string) => {
    try {
      onEvent(JSON.parse(payload) as EventEnvelope)
    } catch (error) {
      console.warn('[events] dropping malformed envelope:', error)
    }
  }

  const unsubscribeLocal = await getLocal().subscribe(channel, handle)

  const remote = getTransport()
  if (!remote) return unsubscribeLocal

  try {
    const unsubscribeRemote = await remote.subscribe(channel, handle)
    return async () => {
      await unsubscribeLocal()
      await unsubscribeRemote()
    }
  } catch (error) {
    console.warn('[events] subscribe failed (local-only for this connection):', error)
    return unsubscribeLocal
  }
}

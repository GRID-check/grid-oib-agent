/**
 * Live-event wire types, shared by the publisher (server) and the browser hub.
 *
 * Deliberately separate from `./bus`, which is `'server-only'` and pulls in
 * ioredis: the browser needs these shapes to interpret an SSE frame, and
 * importing them from the bus would drag the server transport into the client
 * bundle.
 *
 * **Every event is a HINT, never authoritative content.** It names what changed
 * and where; a receiver responds by re-reading from the server. That is what
 * keeps the product correct when the channel is dead, the cache tier is down, or
 * the user was offline (spec RT-4), and it is why no consumer may treat a payload
 * field as the new state.
 */

import type { InboxItemType, ShareableResourceType } from '@/lib/db/schema'

export type CollaborationEvent =
  | {
      kind: 'inbox.changed'
      /**
       * Badge count at publish time, so the common case needs no fetch. May be
       * `-1` when the publisher did not recompute it — treat any negative value
       * as "unknown, go and read the summary".
       */
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
      actorUserId: string | null
    }
  | {
      kind: 'conversation.awaiting'
      conversationId: string
      /** Users the thread is waiting on; empty means the wait cleared. */
      awaitingUserIds: string[]
    }
  | {
      kind: 'resource.access.changed'
      resourceType: ShareableResourceType
      resourceId: string
      /**
       * `role_changed` is distinct from `granted` on purpose: the subject already
       * had access, so a client must re-read what it may DO rather than announce an
       * arrival. A downgrade to `viewer` takes the composer away, and a UI that
       * only learns on its next full reload lets somebody keep typing into a thread
       * they may no longer contribute to.
       */
      change: 'granted' | 'revoked' | 'visibility' | 'role_changed'
    }

export interface EventEnvelope {
  /** Debugging id. NOT a resume cursor — Postgres is the truth (spec RT-4). */
  id: string
  at: string
  event: CollaborationEvent
}

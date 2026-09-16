'use client'

/**
 * One run's ledger, live while the run is — the data half of the block in the
 * thread (ADR-0062, PR 2 design: "one truth").
 *
 * The block renders ONLY from a `RunLedger`. This hook says which one: the
 * ledger stored on the message at mount, replaced by every `run.ledger`
 * snapshot the run's own event stream emits while the run is still going. It
 * never folds an event itself — the fold lives on the producer's side, and a
 * second one here would be a second account of one run, differing from the
 * stored one exactly when something went wrong.
 *
 * ## One subscription per block, no store
 *
 * Several live runs in one thread are the normal case (a person delegates
 * three things and keeps typing), so each block holds its own subscription,
 * keyed by its run id, and drops it on unmount. Nothing here is a singleton:
 * the chat store's `deepResearchJobId` slice is the one-run-at-a-time model
 * this replaces, and it stays only for the escalated chat question, which has
 * no run message until PR 3.
 *
 * ## How the stream is found
 *
 * The message holds the run id; the stream hangs off the backend job id. So a
 * live run costs one `GET /api/projects/[id]/runs/[runId]` (the session read
 * door, `lib/runs/run-view-client.ts`) for `backendJobId`, then the existing
 * job-events proxy (`/api/jobs/async/job/[jobId]/stream`) through
 * `createDeepResearchClient` with NO last event id, so the stream replays from
 * the start and the newest snapshot is the one that lands. Only `onLedger` is
 * wired: the other twelve callbacks narrate a run for the drawer, and the block
 * does not read them.
 *
 * ## Fail-open
 *
 * A refused fetch, an unrecognised body or a stream that never opens leaves the
 * stored ledger on screen. A reload shows the same block either way; what is
 * lost is liveness, not the account.
 *
 * ## A snapshot never moves the block backwards
 *
 * A replay starts at the run's first flush, and the stored ledger may already
 * be past it. Every candidate — stored, fetched or streamed — is taken only
 * when its `updatedAt` is not older than what is shown. The instants are
 * UTC-normalised by `sanitizeRunLedger`, so string comparison is the right one.
 */

import { useEffect, useState } from 'react'
import { createDeepResearchClient, type DeepResearchClient } from '@/adapters/api/deep-research-client'
import type { ChatMessage } from '@/features/chat/types'
import { sanitizeRunLedger } from '@/lib/runs/run-ledger'
import { isTerminalRunStatus, type RunLedger } from '@/lib/runs/run-ledger-types'
import { fetchRunView } from '@/lib/runs/run-view-client'
import { runDisplayStatus } from '@/lib/runs/run-vocabulary'

export interface UseRunLedgerInput {
  /** The run's message; `runLedger` is the account it was loaded with. */
  message: Pick<ChatMessage, 'runLedger'>
  /** The project the run belongs to. Without one there is no read door, so no stream. */
  projectId?: string | null
}

export interface UseRunLedgerResult {
  ledger: RunLedger | null
  /** A stream is attached. Ambient motion only; the block's state comes from the ledger. */
  live: boolean
}

/** `candidate` unless what is shown is newer. */
function notOlder(current: RunLedger | null, candidate: RunLedger): RunLedger {
  if (!current) return candidate
  return candidate.updatedAt >= current.updatedAt ? candidate : current
}

export function useRunLedger({ message, projectId }: UseRunLedgerInput): UseRunLedgerResult {
  const stored = message.runLedger ?? null
  const [ledger, setLedger] = useState<RunLedger | null>(stored)
  const [live, setLive] = useState(false)

  // The store rebuilds the message object when the thread reloads; a newer
  // stored ledger (the terminal one, after a reload) wins over what the stream
  // last said, an older one does not.
  useEffect(() => {
    if (stored) setLedger((current) => notOlder(current, stored))
  }, [stored])

  const runId = ledger?.runId ?? null
  const terminal = ledger ? isTerminalRunStatus(runDisplayStatus(ledger)) : true

  useEffect(() => {
    if (terminal || !runId || !projectId) return

    let cancelled = false
    let client: DeepResearchClient | null = null

    const close = (): void => {
      client?.disconnect()
      client = null
      setLive(false)
    }

    fetchRunView(projectId, runId)
      .then((view) => {
        if (cancelled) return
        const fetched = view.ledger
        if (fetched) setLedger((current) => notOlder(current, fetched))
        // Nothing to stream from, or nothing left to stream: the fetched
        // ledger is the account, and the terminal flag above re-runs this
        // effect to a no-op.
        if (!view.backendJobId) return
        if (fetched && isTerminalRunStatus(fetched.status)) return

        client = createDeepResearchClient({
          jobId: view.backendJobId,
          callbacks: {
            onLedger: (payload) => {
              const next = sanitizeRunLedger(payload)
              if (!next) return
              setLedger((current) => notOlder(current, next))
              if (isTerminalRunStatus(next.status)) close()
            },
            onComplete: () => setLive(false),
            onError: () => setLive(false),
            onDisconnect: () => setLive(false),
          },
        })
        client.connect()
        setLive(true)
      })
      .catch(() => {
        // Fail-open: the stored ledger stays on screen.
      })

    return () => {
      cancelled = true
      close()
    }
  }, [runId, projectId, terminal])

  return { ledger, live: live && !terminal }
}

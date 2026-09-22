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
 * ## One subscription per block, no run store
 *
 * Several live runs in one thread are the normal case (a person delegates
 * three things and keeps typing), so each block holds its own subscription,
 * keyed by its run id, and drops it on unmount. Nothing here is a singleton;
 * the chat store's one-run-at-a-time slice this replaced is gone.
 *
 * ## The stored ledger follows the stream
 *
 * The message's own `runLedger` is the account everything OUTSIDE the block
 * reads — the composer, the toolbar's „läuft" pill, the history's row state,
 * the watchdog that exempts a turn a run is carrying, the delete that stops a
 * live run (`chat/lib/session-activity`). So when the stream moves the run
 * from one status word to another, the hook writes that ledger back onto the
 * message in the chat store. Only on a status change: a snapshot per step
 * would bump the thread on every event for facts nobody outside reads. The
 * server row is not touched — the worker is its writer, and a reload lands on
 * the same terminal ledger either way.
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

import { useCallback, useEffect, useState } from 'react'
import {
  createDeepResearchClient,
  type DeepResearchClient,
} from '@/adapters/api/deep-research-client'
import type { ChatMessage } from '@/features/chat/types'
import { useChatStore } from '@/features/chat/store'
import { sanitizeRunLedger } from '@/lib/runs/run-ledger'
import { isTerminalRunStatus, type RunLedger } from '@/lib/runs/run-ledger-types'
import { cancelRun, fetchRunView, writeNowRun } from '@/lib/runs/run-view-client'
import { runDisplayStatus } from '@/lib/runs/run-vocabulary'

export interface UseRunLedgerInput {
  /** The run's message; `runLedger` is the account it was loaded with. */
  message: Pick<ChatMessage, 'id' | 'runLedger'>
  /** The project the run belongs to. Without one there is no read door, so no stream. */
  projectId?: string | null
  /**
   * The thread the message is in. With it, a status change on the stream is
   * written back onto the stored message (see the module note); without it
   * the block still follows the stream, and nothing outside it learns.
   */
  conversationId?: string | null
}

/**
 * What the run's own stream is doing, when there is one to watch.
 *
 * `null` means there is nothing to watch: the run is over, or it was never
 * streamed. The other two are the honest states of a line that dropped while
 * the run went on — and it DOES go on, which is the fact both of them exist to
 * state. Silence here would read as a run that stopped.
 */
export type RunConnection = 'live' | 'reconnecting' | 'lost'

export interface UseRunLedgerResult {
  ledger: RunLedger | null
  /** A stream is attached. Ambient motion only; the block's state comes from the ledger. */
  live: boolean
  /** The stream's own state, or `null` when there is no stream to lose. */
  connection: RunConnection | null
  /**
   * Stop the run, when there is one to stop. `null` while there is not — a
   * block with nothing running offers no way to stop it rather than a control
   * that refuses. Optimistic about nothing: the ledger changes when the fold
   * says the run was cancelled, never because the button was pressed.
   */
  cancel: (() => Promise<void>) | null
  /**
   * „Jetzt schreiben": stop researching and write from what is there. `null`
   * on the same terms as `cancel`; the block decides whether the run is in a
   * phase where it means anything.
   */
  writeNow: (() => Promise<void>) | null
}

/**
 * `candidate` only when it is strictly NEWER than what is shown.
 *
 * Strictly, because the same instant is the same frame: the fold bumps
 * `updatedAt` on every op, so two ledgers that agree on it agree on everything.
 * Taking an equal one would swap in a new object for identical facts — and a
 * caller that rebuilds the message on every render (the chat store does) would
 * then set state on every render, which is a render loop, not a refresh.
 */
function notOlder(current: RunLedger | null, candidate: RunLedger): RunLedger {
  if (!current) return candidate
  return candidate.updatedAt > current.updatedAt ? candidate : current
}

export function useRunLedger({
  message,
  projectId,
  conversationId,
}: UseRunLedgerInput): UseRunLedgerResult {
  const stored = message.runLedger ?? null
  const [ledger, setLedger] = useState<RunLedger | null>(stored)
  const [live, setLive] = useState(false)
  const [connection, setConnection] = useState<RunConnection | null>(null)

  // The store rebuilds the message object when the thread reloads; a newer
  // stored ledger (the terminal one, after a reload) wins over what the stream
  // last said, an older one does not.
  useEffect(() => {
    if (stored) setLedger((current) => notOlder(current, stored))
  }, [stored])

  const runId = ledger?.runId ?? null
  const terminal = ledger ? isTerminalRunStatus(runDisplayStatus(ledger)) : true

  // Write a status change back onto the stored message, so the rest of the
  // thread reads the run the way the block shows it.
  const messageId = message.id
  useEffect(() => {
    if (!ledger || !conversationId || !messageId) return
    if (stored && runDisplayStatus(stored) === runDisplayStatus(ledger)) return
    if (stored && stored.updatedAt >= ledger.updatedAt) return
    useChatStore.getState().patchConversationMessage(conversationId, messageId, {
      runLedger: ledger,
    })
  }, [ledger, stored, conversationId, messageId])

  useEffect(() => {
    if (terminal || !runId || !projectId) return

    let cancelled = false
    let client: DeepResearchClient | null = null

    const close = (): void => {
      client?.disconnect()
      client = null
      setLive(false)
      setConnection(null)
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
            // The run ended on the stream's own terms: there is nothing left
            // to watch, so there is nothing to say about the connection.
            onComplete: () => {
              setLive(false)
              setConnection(null)
            },
            // The line dropped while the run went on. Both say so; only the
            // first one is still trying.
            onReconnecting: () => setConnection('reconnecting'),
            onError: () => {
              setLive(false)
              setConnection('lost')
            },
            onDisconnect: () => {
              setLive(false)
              setConnection('lost')
            },
          },
        })
        client.connect()
        setLive(true)
        setConnection('live')
      })
      .catch(() => {
        // Fail-open: the stored ledger stays on screen.
      })

    return () => {
      cancelled = true
      close()
    }
  }, [runId, projectId, terminal])

  const cancel = useCallback(async (): Promise<void> => {
    if (!runId || !projectId) return
    try {
      const view = await cancelRun(projectId, runId)
      if (view.ledger) setLedger((current) => notOlder(current, view.ledger as RunLedger))
    } catch {
      // Fail-open, like every other reader here: the run goes on, the block
      // keeps saying what the ledger says, and the person can try again.
    }
  }, [runId, projectId])

  const writeNow = useCallback(async (): Promise<void> => {
    if (!runId || !projectId) return
    try {
      const view = await writeNowRun(projectId, runId)
      if (view.ledger) setLedger((current) => notOlder(current, view.ledger as RunLedger))
    } catch {
      // Fail-open, like the cancel: the run goes on and the person can try again.
    }
  }, [runId, projectId])

  return {
    ledger,
    live: live && !terminal,
    // A run that has ended has nothing to reconnect to, whatever the socket did.
    connection: terminal ? null : connection,
    cancel: terminal || !runId || !projectId ? null : cancel,
    writeNow: terminal || !runId || !projectId ? null : writeNow,
  }
}

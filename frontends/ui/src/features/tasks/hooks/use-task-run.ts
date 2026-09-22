'use client'

/**
 * One task's run, for the Aufträge drawer.
 *
 * The drawer shows the REAL block (`RunBlock`), which renders only from a
 * `RunLedger`, and the index does not carry one — the list projection sends
 * three numbers per row (`TaskRunSummary`) precisely so that a page of forty
 * tasks is not forty ledgers. So the drawer fetches the one it opened, through
 * the same read door the block in the thread uses
 * (`GET /api/projects/[id]/runs/[runId]`, ADR-0055).
 *
 * ## One read, not a subscription
 *
 * `useRunLedger` opens the run's event stream; this does not, on purpose. The
 * drawer sits over a list that already polls every ten seconds, and a socket
 * behind a modal over a polling surface is two liveness mechanisms for one
 * screen — the kind of second path ADR-0055 exists to forbid. Instead the read
 * repeats whenever the panel's poll moves the row it is showing (`revision`),
 * which is the same signal the list itself redraws on, and never otherwise.
 *
 * The thread is still where a live run is WATCHED: the drawer says so with a
 * link, rather than growing a second live view of the same run.
 *
 * ## Fail-open, and never a stale run
 *
 * A refused read or a body this build does not recognise leaves `ledger` null
 * and `failed` true: the drawer then says the account could not be loaded and
 * still offers the result and the thread. A response that arrives after the
 * drawer moved to another run is dropped — `active` is checked on settle — so
 * a slow read can never paint run A's ledger under run B's title.
 */

import { useEffect, useState } from 'react'
import type { RunLedger } from '@/lib/runs/run-ledger-types'
import { fetchRunView } from '@/lib/runs/run-view-client'

export interface UseTaskRunInput {
  projectId: string
  /** The run to read, or null while the drawer is shut or has no run. */
  runId: string | null
  /**
   * Changes when the row this drawer is showing has moved. The panel's poll
   * hands its own view of the row's state; a new value re-reads, an equal one
   * does not. Omitted for a run that cannot change any more.
   */
  revision?: string
}

export interface UseTaskRun {
  ledger: RunLedger | null
  loading: boolean
  /** The read was refused or unreadable. `ledger` stays null. */
  failed: boolean
}

export function useTaskRun({ projectId, runId, revision }: UseTaskRunInput): UseTaskRun {
  const [ledger, setLedger] = useState<RunLedger | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!runId) {
      setLedger(null)
      setFailed(false)
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    setFailed(false)
    fetchRunView(projectId, runId)
      // A run that reads fine and carries no ledger is not a failure: it is a
      // run from before run messages existed. Both end with no block, and the
      // drawer says different things about them.
      .then((view) => {
        if (!active) return
        setLedger(view.ledger)
      })
      .catch(() => {
        if (!active) return
        setLedger(null)
        setFailed(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, runId, revision])

  return { ledger, loading, failed }
}

'use client'

import { useCallback, useRef, useState } from 'react'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import { requestReingest } from '../lib/reingest-request'

/**
 * How many re-reads are in flight at once. Each request only dispatches a job
 * and answers; the ingest queue paces the actual reading per office. A small
 * pool keeps "re-read 200 failed plans" from opening 200 sockets at once.
 */
const POOL = 4

export interface BulkReingestProgress {
  /** Documents in the batch. */
  total: number
  /** Documents the server has answered for, either way. */
  done: number
  /** Answers that were refusals or errors. */
  failed: number
}

/**
 * „Alle erneut lesen" — send a set of documents back through ingestion, a few
 * at a time, and report how far along the batch is.
 *
 * feld72 asked for exactly this (Jour fixe, 2026-10-09): a long upload broke off
 * part-way and left failed documents in a dozen folders, and the only retry was
 * one document at a time from each card's menu. Each document goes through
 * the same {@link requestReingest} the card's own action uses, and each answer
 * patches that row through `onReingested`, so the listing turns from „Lesen
 * fehlgeschlagen" to „Wird gelesen" row by row while the batch runs.
 */
export function useBulkReingest(onReingested: (id: string, status: string) => void) {
  const [progress, setProgress] = useState<BulkReingestProgress | null>(null)
  const running = useRef(false)

  const run = useCallback(
    async (documentIds: readonly string[]): Promise<BulkReingestProgress> => {
      const total = documentIds.length
      const result: BulkReingestProgress = { total, done: 0, failed: 0 }
      if (running.current || total === 0) return result
      running.current = true
      setProgress({ ...result })
      const queue = [...documentIds]
      const worker = async () => {
        for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
          const outcome = await requestReingest(id)
          result.done += 1
          if (outcome.kind === 'failed') result.failed += 1
          else if (outcome.status) onReingested(id, outcome.status)
          setProgress({ ...result })
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(POOL, total) }, worker))
      } finally {
        running.current = false
        notifyDocumentsChanged()
        setProgress(null)
      }
      return result
    },
    [onReingested]
  )

  return { run, progress }
}

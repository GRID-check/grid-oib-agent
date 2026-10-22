'use client'

/**
 * How many mails wait for this reader in a project's E-Mail-Eingang: the
 * number on the Dateien header entry, the rail, the phone's Dateien tab and
 * the quiet line above the shelf.
 *
 * ONE READ PER PROJECT, SHARED. Four surfaces show the same number on one
 * screen, so they share one module-level entry per project: the first to
 * mount reads, the others subscribe, and a decision anywhere refreshes it for
 * all (`refreshInboundMailWaiting`). The read is the list operation itself
 * (`inbound-mail-list`, one page of up to 50), so the count is honest per
 * reader in the `project-surfaces.md` sense: a reader who may not decide sees
 * a 404 and no number, never a count of mail they cannot open.
 *
 * Arrival is not pushed to the browser (the receive job publishes to the door
 * only), so the number is read again when the tab comes back into view and
 * once a minute while it is visible, never in a hidden tab.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { ApiRequestError } from '@/adapters/api/api-error'
import { INBOUND_MAIL_LIST_MAX_LIMIT } from '@/lib/inbound-mail/inbound-mail-wire'
import { inboundMailClient, type InboundMailClient } from '../lib/client'

export interface InboundMailWaiting {
  /** Mails waiting for a decision; null while unknown, or when the reader may not decide here. */
  count: number | null
  /** More wait than one page holds: the count is a floor. */
  more: boolean
}

const UNKNOWN: InboundMailWaiting = { count: null, more: false }
/** A read younger than this is reused by a surface that mounts. */
const FRESH_MS = 30_000
/** While the tab is visible, the number is read again this often. */
export const WAITING_POLL_MS = 60_000

interface Entry {
  state: InboundMailWaiting
  readAt: number
  inflight: Promise<void> | null
  /** The reader may not decide here (404): asked once per page load, never again. */
  denied: boolean
  listeners: Set<() => void>
}

const entries = new Map<string, Entry>()

function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId)
  if (!entry) {
    entry = { state: UNKNOWN, readAt: 0, inflight: null, denied: false, listeners: new Set() }
    entries.set(projectId, entry)
  }
  return entry
}

function read(projectId: string, client: InboundMailClient, force = false): Promise<void> {
  const entry = entryFor(projectId)
  if (entry.denied) return Promise.resolve()
  if (entry.inflight) return entry.inflight
  if (!force && Date.now() - entry.readAt < FRESH_MS) return Promise.resolve()
  entry.inflight = client
    .list(projectId, { status: 'waiting', limit: INBOUND_MAIL_LIST_MAX_LIMIT })
    .then((page) => {
      entry.state = { count: page.items.filter((mail) => mail.status === 'waiting').length, more: page.nextCursor !== null }
    })
    .catch((error: unknown) => {
      // No right to decide here, or the office has the feature off: no number, ever.
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
        entry.denied = true
        entry.state = UNKNOWN
      }
      // Anything else keeps the last number: a blanked badge is worse than a stale one.
    })
    .finally(() => {
      entry.readAt = Date.now()
      entry.inflight = null
      for (const listener of entry.listeners) listener()
    })
  return entry.inflight
}

/** Read the number again now, for every surface showing it (after a decision, a restore, an undo). */
export function refreshInboundMailWaiting(projectId: string, client: InboundMailClient = inboundMailClient): Promise<void> {
  return read(projectId, client, true)
}

/** Put a number in without a read: a preview, or a page that just read the list itself. */
export function primeInboundMailWaiting(projectId: string, state: InboundMailWaiting): void {
  const entry = entryFor(projectId)
  entry.state = state
  entry.readAt = Date.now()
  for (const listener of entry.listeners) listener()
}

export function useInboundMailWaiting(
  projectId: string | null,
  enabled: boolean,
  client: InboundMailClient = inboundMailClient,
): InboundMailWaiting {
  const active = enabled && projectId !== null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!active || !projectId) return () => {}
      const entry = entryFor(projectId)
      entry.listeners.add(listener)
      return () => entry.listeners.delete(listener)
    },
    [active, projectId],
  )
  const snapshot = useCallback(() => (active && projectId ? entryFor(projectId).state : UNKNOWN), [active, projectId])
  const state = useSyncExternalStore(subscribe, snapshot, () => UNKNOWN)

  useEffect(() => {
    if (!active || !projectId) return
    void read(projectId, client)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void read(projectId, client)
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read(projectId, client, true)
    }, WAITING_POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [active, projectId, client])

  return state
}

/** Forget every entry. Specs only. */
export function resetInboundMailWaitingForTests(): void {
  entries.clear()
}

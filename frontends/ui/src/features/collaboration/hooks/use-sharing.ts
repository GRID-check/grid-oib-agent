'use client'

/**
 * Sharing + hand-off data hooks.
 *
 * Plain `fetch` + `useState`, matching the rest of the codebase. Mutations
 * deliberately do NOT update state optimistically: sharing is the feature whose
 * bugs are access-control bugs, so the server's answer is always what gets
 * rendered. A share dialog that shows an optimistic row which the server then
 * refuses would be actively misleading about who can read the thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AwaitingStateResponse, MentionCandidatesResponse } from '@/lib/mentions/types'
import type {
  ResourceRole,
  ResourceSharingState,
  ResourceVisibility,
  ShareCandidate,
  ShareableResourceType,
} from '@/lib/sharing/types'
import { createRetryLadder, type RetryLadder } from '@/shared/utils/backoff'
import { useLiveEvents } from './use-live-events'

/** A refusal the UI can localise, extracted from the standard error envelope. */
export interface SharingFailure {
  /** `details.reason` when the server supplied one (e.g. `last-owner`). */
  reason: string | null
  /** Server-supplied message, as a fallback when the reason is unrecognised. */
  message: string | null
}

async function readFailure(response: Response): Promise<SharingFailure> {
  try {
    const body = (await response.json()) as {
      error?: string
      details?: { reason?: string } | null
    }
    return { reason: body.details?.reason ?? null, message: body.error ?? null }
  } catch {
    return { reason: null, message: null }
  }
}

/**
 * Backoff ladder, in ms, for a load that came back empty-handed.
 *
 * The failure this exists for is not an error, it is a RACE. A brand-new thread
 * reaches the server only when its first message is persisted
 * (`ensureServerConversation` in the chat store — a list, then a create), while
 * the header starts asking who can read the thread the moment that message
 * appears locally. The sharing read therefore loses that race on the first turn
 * of every new conversation and is answered with the 404 that
 * `resolveResourceAccess` gives anything it cannot find.
 *
 * With a single attempt that 404 was permanent for the session: nothing re-reads
 * until the tab is refocused, or the disconnected poll comes round a minute
 * later (`useLiveEvents`), or the page is reloaded — so the thread you were
 * actually in was the one thread with no Share in its menu, which is exactly
 * when you want it.
 *
 * The ladder is short on purpose. It covers one create round-trip and then
 * stops: a resource that is genuinely gone must not be polled forever, and the
 * three existing triggers are still there for everything slower than this.
 */
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000]

export interface UseSharingResult {
  state: ResourceSharingState | null
  /** True while an answer is still coming — including between retries. */
  loading: boolean
  /**
   * Set when a load failed and will NOT be retried (distinct from a failed
   * mutation). A load still working through {@link RETRY_DELAYS_MS} is
   * `loading`, not failed: a one-second-old thread has not gone wrong.
   */
  loadError: boolean
  /** Set by the most recent mutation; cleared when the next one starts. */
  failure: SharingFailure | null
  /** Dismiss the current mutation failure without starting a new mutation. */
  dismissFailure: () => void
  saving: boolean
  refresh: () => void
  setVisibility: (visibility: ResourceVisibility) => Promise<boolean>
  grant: (subjectUserId: string, role?: ResourceRole) => Promise<boolean>
  changeRole: (subjectUserId: string, role: ResourceRole) => Promise<boolean>
  revoke: (subjectUserId: string) => Promise<boolean>
  escalate: () => Promise<boolean>
}

/**
 * Sharing state for one resource. Every mutation resolves to a boolean (did it
 * succeed) and refreshes from the server, so the roster on screen is always the
 * roster the server believes in.
 */
export function useSharing(
  resourceType: ShareableResourceType,
  resourceId: string | null,
  enabled: boolean,
): UseSharingResult {
  const [state, setState] = useState<ResourceSharingState | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [failure, setFailure] = useState<SharingFailure | null>(null)
  const [saving, setSaving] = useState(false)
  const seq = useRef(0)
  // The ladder owns its own position and timer (see `createRetryLadder`) — four
  // hand-rolled copies of that bookkeeping is how this codebase got four
  // different reset bugs.
  // Lazy init: bare `useRef(create…())` builds and discards a ladder on every
  // render. Harmless — no timer is armed at construction — but wasteful and not
  // the idiom.
  const retryRef = useRef<RetryLadder | null>(null)
  retryRef.current ??= createRetryLadder({ delaysMs: RETRY_DELAYS_MS })
  const retry = retryRef.current
  // Lets a scheduled retry call the CURRENT refresh without making `refresh`
  // depend on itself.
  const refreshRef = useRef<() => void>(() => {})

  const base = resourceId
    ? `/api/sharing/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`
    : null

  const cancelRetry = useCallback(() => retry.cancel(), [retry])

  const refresh = useCallback(async () => {
    if (!enabled || !base) {
      // Invalidate any read still in flight: without this bump its `current`
      // would still match and it would write the abandoned resource's state back
      // over the cleared one.
      seq.current += 1
      retry.cancel()
      setState(null)
      setLoading(false)
      return
    }
    const current = ++seq.current
    try {
      const response = await fetch(base)
      if (!response.ok) throw new Error(`sharing ${response.status}`)
      const data = (await response.json()) as ResourceSharingState
      if (current !== seq.current) return
      setState(data)
      setLoadError(false)
      retry.reset()
      setLoading(false)
    } catch {
      if (current !== seq.current) return
      if (!retry.schedule(() => refreshRef.current())) {
        // The ladder is spent. Now it is a real failure, and the dialog may say so.
        setLoadError(true)
        setLoading(false)
      }
      // `loading` deliberately stays true across the ladder: the answer is still
      // coming, and a skeleton is truer than an error for a thread this young.
    }
  }, [base, enabled, retry])

  useEffect(() => {
    refreshRef.current = () => void refresh()
  }, [refresh])

  /**
   * Read again from the top: a fresh ladder, not a continuation of the last one.
   * This is what every EXTERNAL trigger gets — the dialog's "try again", a focus
   * event, a live access change — because each of them is new evidence that the
   * answer may have changed, and none of them should inherit the exhaustion of
   * an attempt made minutes ago.
   */
  const restart = useCallback(() => {
    retry.reset()
    // Clearing the failure and showing the skeleton is what makes "try again"
    // legible: without it the same destructive alert simply stayed on screen for
    // the whole retry ladder, and if the retry failed too nothing on screen ever
    // changed — a button that reads as broken.
    setLoadError(false)
    setLoading(Boolean(enabled && base))
    void refresh()
  }, [refresh, retry, enabled, base])

  useEffect(() => {
    retry.reset()
    setLoadError(false)
    setLoading(Boolean(enabled && base))
    void refresh()
    // Switching resource (or closing the gate) abandons the ladder in flight —
    // otherwise a retry for the thread you just left overwrites the one you are in.
    return cancelRetry
  }, [refresh, enabled, base, cancelRetry, retry])

  // A revocation or visibility change made by someone else must land here too —
  // otherwise an owner's dialog keeps showing a roster that is no longer true.
  useLiveEvents({
    enabled: enabled && Boolean(base),
    onEvent: (event) => {
      if (event.kind === 'resource.access.changed' && event.resourceId === resourceId) restart()
    },
    onRefresh: restart,
  })

  const mutate = useCallback(
    async (input: string, init: RequestInit): Promise<boolean> => {
      setFailure(null)
      setSaving(true)
      try {
        const response = await fetch(input, init)
        if (!response.ok) {
          setFailure(await readFailure(response))
          return false
        }
        // Render the server's answer, never an optimistic guess.
        const data = (await response.json()) as ResourceSharingState
        // Invalidate any READ still in flight. A mutation's response is strictly
        // newer than a GET issued before it, but the GET had no way to know that:
        // invite someone, tab away and back (which restarts the read), and the
        // read could land last and quietly restore the roster without them.
        seq.current += 1
        // `reset`, and the two `set`s below it, because this response is a
        // complete answer — the same thing the read was retrying FOR. Cancelling
        // the pending retry without them stranded the dialog: `loading` is held
        // true across the whole ladder on purpose, so dropping the last rung left
        // nothing to ever set it false or raise `loadError`. A skeleton over
        // fresh, correct state, for good.
        retry.reset()
        setState(data)
        setLoadError(false)
        setLoading(false)
        return true
      } catch {
        setFailure({ reason: null, message: null })
        return false
      } finally {
        setSaving(false)
      }
    },
    [retry],
  )

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  return {
    state,
    loading,
    loadError,
    failure,
    dismissFailure: () => setFailure(null),
    saving,
    refresh: restart,
    setVisibility: async (visibility) =>
      base ? mutate(base, { ...json({ visibility }), method: 'PATCH' }) : false,
    grant: async (subjectUserId, role = 'collaborator') =>
      base ? mutate(`${base}/grants`, json({ subjectUserId, role })) : false,
    changeRole: async (subjectUserId, role) =>
      base ? mutate(`${base}/grants`, { ...json({ subjectUserId, role }), method: 'PATCH' }) : false,
    revoke: async (subjectUserId) =>
      base
        ? mutate(`${base}/grants/${encodeURIComponent(subjectUserId)}`, { method: 'DELETE' })
        : false,
    escalate: async () => (base ? mutate(`${base}/grants`, json({ escalate: true })) : false),
  }
}

/** Invite candidates for the share dialog. Loaded lazily — only when it opens. */
export function useShareCandidates(
  resourceType: ShareableResourceType,
  resourceId: string | null,
  enabled: boolean,
): { candidates: ShareCandidate[]; loading: boolean; error: boolean; reload: () => void } {
  const [candidates, setCandidates] = useState<ShareCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Bumped by `reload`: the effect re-runs without the dialog closing.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || !resourceId) {
      setCandidates([])
      setError(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(false)
    void (async () => {
      try {
        const response = await fetch(
          `/api/sharing/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/candidates`,
        )
        if (!response.ok) throw new Error(`candidates ${response.status}`)
        const data = (await response.json()) as ShareCandidate[] | { candidates: ShareCandidate[] }
        if (cancelled) return
        setCandidates(Array.isArray(data) ? data : (data.candidates ?? []))
      } catch {
        // A failed load must not pose as "nobody left to invite" — that is a
        // false statement about the org, so the failure gets its own surface.
        if (!cancelled) {
          setCandidates([])
          setError(true)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resourceType, resourceId, enabled, attempt])

  return { candidates, loading, error, reload: () => setAttempt((current) => current + 1) }
}

/**
 * The thread's hand-off state (spec MN-8).
 *
 * Derived server-side from open mention requests, so this hook never computes it
 * locally — it re-reads on the `conversation.awaiting` event and on the usual
 * focus/poll fallbacks.
 */
export function useAwaitingState(
  conversationId: string | null,
  enabled: boolean,
): { awaiting: AwaitingStateResponse | null; refresh: () => void; release: (requestId: string) => Promise<boolean> } {
  const [awaiting, setAwaiting] = useState<AwaitingStateResponse | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled || !conversationId) {
      setAwaiting(null)
      return
    }
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/awaiting`)
      if (!response.ok) return
      setAwaiting((await response.json()) as AwaitingStateResponse)
    } catch {
      // Keep the last known state: a failed poll must not make the thread look
      // free to answer when it is still waiting on someone.
    }
  }, [conversationId, enabled])

  useLiveEvents({
    enabled: enabled && Boolean(conversationId),
    onEvent: (event) => {
      if (event.kind === 'conversation.awaiting' && event.conversationId === conversationId) void refresh()
      if (event.kind === 'conversation.message' && event.conversationId === conversationId) void refresh()
    },
    onRefresh: () => void refresh(),
  })

  useEffect(() => {
    void refresh()
  }, [refresh])

  const release = useCallback(
    async (requestId: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/mentions/${encodeURIComponent(requestId)}/release`, {
          method: 'POST',
        })
        if (!response.ok) return false
        setAwaiting((await response.json()) as AwaitingStateResponse)
        return true
      } catch {
        return false
      }
    },
    [],
  )

  return { awaiting, refresh: () => void refresh(), release }
}

/** Mention-picker candidates for a conversation. */
export function useMentionCandidates(
  conversationId: string | null,
  enabled: boolean,
): { data: MentionCandidatesResponse | null; loading: boolean } {
  const [data, setData] = useState<MentionCandidatesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  // Same new-thread race as the sharing read above: the conversation reaches
  // the server only with its first persisted message, so the first candidates
  // read 404s. Without the ladder that 404 was permanent for the thread — the
  // picker stayed dead until a reload, for exactly the first-time user `@`
  // exists to teach.
  // Lazy init: bare `useRef(create…())` builds and discards a ladder on every
  // render. Harmless — no timer is armed at construction — but wasteful and not
  // the idiom.
  const retryRef = useRef<RetryLadder | null>(null)
  retryRef.current ??= createRetryLadder({ delaysMs: RETRY_DELAYS_MS })
  const retry = retryRef.current

  const cancelRetry = useCallback(() => retry.cancel(), [retry])

  const refresh = useCallback(async () => {
    if (!enabled || !conversationId) {
      // Same reason as in `useSharing`: bump the sequence so a candidates read
      // still in flight for the previous conversation fails its guard instead of
      // repopulating the picker we just cleared.
      seq.current += 1
      retry.cancel()
      setData(null)
      setLoading(false)
      return
    }
    const current = ++seq.current
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/mention-candidates`,
      )
      if (!response.ok) throw new Error(`candidates ${response.status}`)
      if (current !== seq.current) return
      setData((await response.json()) as MentionCandidatesResponse)
      retry.reset()
      setLoading(false)
    } catch {
      if (current !== seq.current) return
      if (!retry.schedule(() => void refresh())) {
        setData(null)
        setLoading(false)
      }
      // `loading` stays true across the ladder, so the picker shows its
      // loading state rather than vanishing for a thread this young.
    }
  }, [conversationId, enabled, retry])

  /**
   * External triggers (focus, reconnect poll) read again from the top — new
   * evidence must not inherit the exhaustion of an attempt made minutes ago.
   */
  const restart = useCallback(() => {
    retry.reset()
    void refresh()
  }, [refresh, retry])

  useEffect(() => {
    retry.reset()
    setLoading(Boolean(enabled && conversationId))
    void refresh()
    return cancelRetry
  }, [refresh, enabled, conversationId, cancelRetry, retry])

  useLiveEvents({
    enabled: enabled && Boolean(conversationId),
    onRefresh: restart,
  })

  return { data, loading }
}

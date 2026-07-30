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

export interface UseSharingResult {
  state: ResourceSharingState | null
  loading: boolean
  /** Set when a load failed (distinct from a failed mutation). */
  loadError: boolean
  /** Set by the most recent mutation; cleared when the next one starts. */
  failure: SharingFailure | null
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

  const base = resourceId
    ? `/api/sharing/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`
    : null

  const refresh = useCallback(async () => {
    if (!enabled || !base) {
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
    } catch {
      if (current !== seq.current) return
      setLoadError(true)
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [base, enabled])

  useEffect(() => {
    setLoading(Boolean(enabled && base))
    void refresh()
  }, [refresh, enabled, base])

  // A revocation or visibility change made by someone else must land here too —
  // otherwise an owner's dialog keeps showing a roster that is no longer true.
  useLiveEvents({
    enabled: enabled && Boolean(base),
    onEvent: (event) => {
      if (event.kind === 'resource.access.changed' && event.resourceId === resourceId) void refresh()
    },
    onRefresh: () => void refresh(),
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
        setState(data)
        return true
      } catch {
        setFailure({ reason: null, message: null })
        return false
      } finally {
        setSaving(false)
      }
    },
    [],
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
    saving,
    refresh: () => void refresh(),
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
): { candidates: ShareCandidate[]; loading: boolean } {
  const [candidates, setCandidates] = useState<ShareCandidate[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !resourceId) {
      setCandidates([])
      return
    }
    let cancelled = false
    setLoading(true)
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
        if (!cancelled) setCandidates([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resourceType, resourceId, enabled])

  return { candidates, loading }
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

  useEffect(() => {
    if (!enabled || !conversationId) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/mention-candidates`,
        )
        if (!response.ok) throw new Error(`candidates ${response.status}`)
        if (cancelled) return
        setData((await response.json()) as MentionCandidatesResponse)
      } catch {
        if (!cancelled) setData(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversationId, enabled])

  return { data, loading }
}

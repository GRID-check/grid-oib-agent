'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A memory item as surfaced to the chat "Grid noted N" chip. Mirrors the subset
 * of the project_memory row the chip renders (see lib/db/schema/project-memory).
 */
export interface ConversationMemoryItem {
  id: string
  kind: string
  content: string
  confidence: string
  provenanceType: string
  sourceConversationId: string | null
  createdAt: string
}

/**
 * Poll schedule (ms) after a turn completes. The in-turn `remember` writes land
 * synchronously, but the async post-answer reflection stage writes a beat later,
 * so we re-check a few times to catch it without a realtime channel.
 */
const POLL_SCHEDULE_MS = [0, 1500, 4000]

interface UseConversationMemoryResult {
  items: ConversationMemoryItem[]
  loading: boolean
}

/**
 * Fetch the memory items recorded during one conversation, scoped by
 * `sourceConversationId`. Read-only; polls a small bounded schedule so a
 * reflection-phase write that lands after the answer still surfaces. Disabled
 * (returns nothing) when there is no project or conversation in scope.
 */
export function useConversationMemory(
  projectId: string | null | undefined,
  conversationId: string | null | undefined,
  enabled = true,
): UseConversationMemoryResult {
  const [items, setItems] = useState<ConversationMemoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    if (!enabled || !projectId || !conversationId) {
      setItems([])
      return
    }

    const controller = new AbortController()
    let cancelled = false
    setLoading(true)

    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/memory?conversationId=${encodeURIComponent(conversationId)}`,
          { signal: controller.signal, credentials: 'same-origin' },
        )
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { items?: ConversationMemoryItem[] }
        if (cancelled) return
        // Only items actually written in this conversation (defensive: the route
        // already filters, but org-wide items share the list shape).
        const scoped = (data.items ?? []).filter((it) => it.sourceConversationId === conversationId)
        setItems(scoped)
      } catch {
        // Silent: the chip is a progressive enhancement, never a blocking error.
      }
    }

    timers.current = POLL_SCHEDULE_MS.map((delay, i) =>
      setTimeout(async () => {
        await fetchOnce()
        if (!cancelled && i === POLL_SCHEDULE_MS.length - 1) setLoading(false)
      }, delay),
    )

    return () => {
      cancelled = true
      controller.abort()
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
  }, [projectId, conversationId, enabled])

  return { items, loading }
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { AnswerFeedbackReason, AnswerFeedbackVerdict } from '@/lib/db/schema/answer-feedback'

/** The client-side view of the caller's vote on one answer. */
export interface AnswerFeedbackState {
  verdict: AnswerFeedbackVerdict
  reason: AnswerFeedbackReason | null
  comment: string | null
}

type ConversationFeedbackMap = Map<string, AnswerFeedbackState>

/**
 * Per-conversation hydration cache: many AnswerFeedback rows mount per chat,
 * but the GET hydration endpoint is per-conversation — dedupe to ONE fetch
 * per conversation (module-level, in-flight-promise keyed). Successful writes
 * mutate the resolved map so remounts (e.g. re-opening a session) keep the
 * latest local state without refetching.
 */
const conversationCache = new Map<string, Promise<ConversationFeedbackMap>>()

/** Test hook: reset the module-level hydration cache between specs. */
export function __clearAnswerFeedbackCache(): void {
  conversationCache.clear()
}

async function loadConversationFeedback(conversationId: string): Promise<ConversationFeedbackMap> {
  try {
    const res = await fetch(
      `/api/feedback/answers?conversationId=${encodeURIComponent(conversationId)}`,
      { credentials: 'same-origin' },
    )
    if (!res.ok) return new Map()
    const data = (await res.json()) as {
      feedback?: {
        messageId: string
        verdict: AnswerFeedbackVerdict
        reason: AnswerFeedbackReason | null
        comment?: string | null
      }[]
    }
    return new Map(
      (data.feedback ?? []).map((f) => [
        f.messageId,
        { verdict: f.verdict, reason: f.reason ?? null, comment: f.comment ?? null },
      ]),
    )
  } catch {
    // Silent: feedback is a progressive enhancement, never a blocking error.
    return new Map()
  }
}

/** Keep the shared hydration map in sync with a confirmed server write. */
function updateCache(conversationId: string | null | undefined, messageId: string, next: AnswerFeedbackState | null): void {
  if (!conversationId) return
  void conversationCache.get(conversationId)?.then((map) => {
    if (next) map.set(messageId, next)
    else map.delete(messageId)
  })
}

export interface UseAnswerFeedbackResult {
  /** The caller's current vote (null = no vote). */
  state: AnswerFeedbackState | null
  /**
   * Optimistically apply `next` (null = retract) and persist it via the
   * feedback API; reverts to the previous state when the request fails.
   */
  setFeedback: (next: AnswerFeedbackState | null) => void
}

/**
 * State + persistence for one answer's thumbs feedback (WS-7).
 * Hydrates from GET /api/feedback/answers (once per conversation), then
 * POSTs upserts / DELETEs retractions with optimistic revert-on-error.
 */
export function useAnswerFeedback(
  messageId: string,
  conversationId: string | null | undefined,
  projectId: string | null | undefined,
): UseAnswerFeedbackResult {
  const [state, setState] = useState<AnswerFeedbackState | null>(null)

  useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    let promise = conversationCache.get(conversationId)
    if (!promise) {
      promise = loadConversationFeedback(conversationId)
      conversationCache.set(conversationId, promise)
    }
    void promise.then((map) => {
      if (cancelled) return
      const existing = map.get(messageId)
      if (existing) setState(existing)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, messageId])

  const setFeedback = useCallback(
    (next: AnswerFeedbackState | null): void => {
      setState((previous) => {
        void (async () => {
          try {
            const res = next
              ? await fetch('/api/feedback/answers', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    messageId,
                    verdict: next.verdict,
                    reason: next.reason,
                    comment: next.comment,
                    conversationId: conversationId ?? null,
                    projectId: projectId ?? null,
                  }),
                })
              : await fetch(`/api/feedback/answers?messageId=${encodeURIComponent(messageId)}`, {
                  method: 'DELETE',
                  credentials: 'same-origin',
                })
            if (res.ok) {
              updateCache(conversationId, messageId, next)
            } else {
              setState(previous) // revert the optimistic update
            }
          } catch {
            setState(previous)
          }
        })()
        return next // optimistic
      })
    },
    [messageId, conversationId, projectId],
  )

  return { state, setFeedback }
}

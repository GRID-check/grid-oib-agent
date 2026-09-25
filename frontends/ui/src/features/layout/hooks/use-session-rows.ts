/**
 * The sessions panel's rows, selected so that a streamed answer does not
 * re-render the layout.
 *
 * Every delta flush replaces the open conversation in `conversations`, so a
 * list derived from that array is a new list on every frame of an answer even
 * though nothing a row shows has changed. Here each row is reused while its
 * fields are the same, and the list is compared item by item: the layout and
 * the panel re-render when a row actually changes (a new session, a title, a
 * run starting or finishing), not with every delta.
 */

import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/features/chat'
import type { Conversation } from '@/features/chat/types'
import { hasFinishedRun, hasLiveRun } from '@/features/chat/lib/session-activity'
import { conversationMatchesProject } from '@/features/chat/lib/project-scope'

export interface SessionRow {
  id: string
  title: string
  date: Date
  /** A run is still going in this thread (read off its stored ledger). */
  hasActiveDeepResearch: boolean
  /** A run in this thread finished with a report. */
  hasCompletedReport: boolean
}

interface RowCache {
  /** The row last built for a conversation object, so an unchanged one costs nothing. */
  byConversation: WeakMap<Conversation, SessionRow>
  /** The row last shown for an id, reused when a new object yields the same row. */
  byId: Map<string, SessionRow>
}

const sameRow = (a: SessionRow, b: SessionRow): boolean =>
  a.title === b.title &&
  +new Date(a.date) === +new Date(b.date) &&
  a.hasActiveDeepResearch === b.hasActiveDeepResearch &&
  a.hasCompletedReport === b.hasCompletedReport

const rowFor = (conversation: Conversation, cache: RowCache): SessionRow => {
  const known = cache.byConversation.get(conversation)
  if (known) return known
  const built: SessionRow = {
    id: conversation.id,
    title: conversation.title,
    date: conversation.updatedAt,
    hasActiveDeepResearch: hasLiveRun(conversation.messages),
    hasCompletedReport: hasFinishedRun(conversation.messages),
  }
  const previous = cache.byId.get(conversation.id)
  const row = previous && sameRow(previous, built) ? previous : built
  cache.byConversation.set(conversation, row)
  cache.byId.set(conversation.id, row)
  return row
}

/**
 * The current user's sessions in the active project context, newest first.
 * Legacy sessions without a projectId fail open (always visible) so users
 * never lose sight of pre-scoping history.
 */
export function useSessionRows(): SessionRow[] {
  const cache = useRef<RowCache>({ byConversation: new WeakMap(), byId: new Map() })
  return useChatStore(
    useShallow((s) => {
      if (!s.currentUserId) return []
      return (
        s.conversations
          .filter((c) => c.userId === s.currentUserId && conversationMatchesProject(c, s.projectId))
          // The store keeps creation order; sort newest-first so date groups
          // and rows in the sessions panel come out most-recently-updated first.
          .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
          .map((c) => rowFor(c, cache.current))
      )
    })
  )
}

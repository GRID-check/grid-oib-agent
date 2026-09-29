/**
 * The composer's Aufwand dial: how hard Piloti thinks, chosen per chat.
 *
 * A chat starts at the organization's default (`settings.chatReasoningEffort`,
 * Organisation → Einstellungen) and keeps whatever its reader turns the dial
 * to. The level travels with every question (`user_message.reasoning_effort`),
 * so the backend never has to know the default: the composer always sends the
 * level it shows.
 *
 * Kept in this reader's browser, like the composer drafts, rather than on the
 * conversation row: it is a preference about how long *I* want to wait, and a
 * shared thread must not change speed under a colleague because I dialled it.
 *
 * A dial turned before the chat has an id (a fresh composer) is held as the
 * draft's level and handed to the conversation on its first send.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { DEFAULT_CHAT_EFFORT, isChatEffort, type ChatEffort } from '@/lib/reasoning-settings/catalog'

/** Enough chats to cover anyone's working set; the oldest choice goes first. */
const MAX_REMEMBERED = 200

interface EffortState {
  /** The organization's default, loaded once per session. */
  orgDefault: ChatEffort
  /** A level chosen before the chat had an id. */
  draft: ChatEffort | null
  /** `{conversationId: level}`, insertion-ordered so the oldest is evicted first. */
  byConversation: Record<string, ChatEffort>
  setOrgDefault: (effort: ChatEffort) => void
  choose: (conversationId: string | null | undefined, effort: ChatEffort) => void
  /** The level a send from this chat carries; claims the draft's level for it. */
  levelForSend: (conversationId: string | null | undefined) => ChatEffort
}

/** The level a chat shows: its own choice, the draft's, then the organization's. */
export function effectiveEffort(
  state: Pick<EffortState, 'orgDefault' | 'draft' | 'byConversation'>,
  conversationId: string | null | undefined
): ChatEffort {
  const own = conversationId ? state.byConversation[conversationId] : undefined
  return own ?? state.draft ?? state.orgDefault
}

function remember(
  byConversation: Record<string, ChatEffort>,
  conversationId: string,
  effort: ChatEffort
): Record<string, ChatEffort> {
  const { [conversationId]: _previous, ...rest } = byConversation
  const entries = Object.entries(rest)
  const kept = entries.length >= MAX_REMEMBERED ? entries.slice(entries.length - MAX_REMEMBERED + 1) : entries
  return { ...Object.fromEntries(kept), [conversationId]: effort }
}

export const useEffortStore = create<EffortState>()(
  persist(
    (set, get) => ({
      orgDefault: DEFAULT_CHAT_EFFORT,
      draft: null,
      byConversation: {},
      setOrgDefault: (effort) => set({ orgDefault: effort }),
      choose: (conversationId, effort) =>
        set((state) =>
          conversationId
            ? { byConversation: remember(state.byConversation, conversationId, effort) }
            : { draft: effort }
        ),
      levelForSend: (conversationId) => {
        const state = get()
        const level = effectiveEffort(state, conversationId)
        if (conversationId && state.draft && !state.byConversation[conversationId]) {
          set({ draft: null, byConversation: remember(state.byConversation, conversationId, level) })
        }
        return level
      },
    }),
    {
      name: 'piloti-chat-effort',
      version: 1,
      // The org default is re-read every session; persisting it would pin a
      // stale one after an admin changes it.
      partialize: (state) => ({ draft: state.draft, byConversation: state.byConversation }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<EffortState>
        const byConversation = Object.fromEntries(
          Object.entries(stored.byConversation ?? {}).filter(([, value]) => isChatEffort(value))
        ) as Record<string, ChatEffort>
        return {
          ...current,
          draft: isChatEffort(stored.draft) ? stored.draft : null,
          byConversation,
        }
      },
    }
  )
)

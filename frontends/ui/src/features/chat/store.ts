/**
 * Chat Store
 *
 * Combined Zustand store composed from 3 slices:
 * - Messages slice (streaming, thinking, file cards)
 * - Sessions slice (conversations CRUD, persistence)
 * - Interaction slice (the open HITL prompt and its send path)
 *
 * A deep-research run keeps no state here: it is a message in the thread
 * (ADR-0062) and its block subscribes to its own stream (`features/runs`).
 */

import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { ChatStore } from './types'

/**
 * The persisted chat store plus a client-only hydration flag (C5). `hasHydrated`
 * is NOT part of the persisted `ChatStore` union (owned in types.ts) — it is a
 * transient boolean layered on here so ChatArea can show a message-list skeleton
 * until the persisted store has finished rehydrating from storage.
 */
export type ChatStoreWithHydration = ChatStore & {
  /** True once persist rehydration has settled (or found nothing to restore). */
  hasHydrated: boolean
}
import {
  createMessagesSlice,
  createSessionsSlice,
  createInteractionSlice,
} from './stores'
import { chatIndexKey, createResilientStorage } from './stores/chat-storage'
import {
  logStoreHydration,
  logExternalStorageEvent,
} from './lib/storage-logger'

const CHAT_STORE_NAME = 'aiq-chat-store'

export const useChatStore = create<ChatStoreWithHydration>()(
  devtools(
    persist(
      (set, get, store) => ({
        ...createMessagesSlice(set, get, store),
        ...createSessionsSlice(set, get, store),
        ...createInteractionSlice(set, get, store),
        // Client-only hydration flag (C5); flipped true in onRehydrateStorage.
        hasHydrated: false,
      }),
      {
        // The prefix of every key the chat store writes (`stores/chat-storage.ts`).
        name: CHAT_STORE_NAME,
        storage: typeof window === 'undefined' ? undefined : createResilientStorage(),
        partialize: (state) => ({
          currentUserId: state.currentUserId,
          conversations: state.conversations,
          currentConversation: state.currentConversation,
          composerDrafts: state.composerDrafts,
        }),
        onRehydrateStorage: () => (state) => {
          // Mark hydration settled regardless of whether persisted data existed
          // (or the rehydrate errored) so ChatArea's skeleton always resolves to
          // the real thread / WelcomeState instead of hanging on the skeleton.
          useChatStore.setState({ hasHydrated: true })
          if (!state || typeof window === 'undefined') return
          queueMicrotask(() => {
            const store = useChatStore.getState()
            // Rehydration is async and can land AFTER a project page has set
            // projectId; re-apply it so setProjectId's guard clears a
            // persisted currentConversation from another project (UX-8).
            if (store.projectId) store.setProjectId(store.projectId)
          })
        },
      }
    ),
    { name: 'ChatStore' }
  )
)

// ============================================================
// Selectors
// ============================================================

/**
 * A connection error the backend's health can clear (`useConnectionRecovery`).
 * `connection.server_incompatible` is not one: an agent rolled back to an
 * older socket answers `/health` like any other, so a healthy poll would
 * dismiss a true message and start a ladder that ends the same way. That card
 * goes when a socket says hello (`dismissConnectionErrors` on open), which the
 * reader's next question tries.
 */
export const selectHasRecoverableConnectionError = (state: ChatStore): boolean =>
  state.currentConversation?.messages.some(
    (m) =>
      m.messageType === 'error' &&
      m.errorData?.errorCode?.startsWith('connection.') &&
      m.errorData.errorCode !== 'connection.server_incompatible'
  ) ?? false

// ============================================================
// Storage Event Monitoring (for debugging session clearing)
// ============================================================

if (typeof window !== 'undefined') {
  const initialState = useChatStore.getState()
  logStoreHydration(true, initialState.conversations?.length ?? 0, initialState.currentUserId)

  window.addEventListener('storage', (event) => {
    if (event.key === chatIndexKey(CHAT_STORE_NAME)) {
      logExternalStorageEvent(event.key, event.oldValue, event.newValue)

      if (event.oldValue !== null && event.newValue === null) {
        console.error(
          '[SessionsStore] ❌ CRITICAL: Storage cleared by external source (browser extension, dev tools, or another tab)'
        )
      }
    }
  })
}

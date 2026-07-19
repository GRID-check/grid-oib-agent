/**
 * Chat Store
 *
 * Combined Zustand store composed from 3 slices:
 * - Messages slice (streaming, thinking, file cards)
 * - Sessions slice (conversations CRUD, persistence)
 * - Deep Research slice (SSE streaming, HITL, jobs)
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
  createDeepResearchSlice,
} from './stores'
import { createResilientStorage } from './stores/sessions-store'
import {
  logStoreHydration,
  logExternalStorageEvent,
} from './lib/storage-logger'

export const useChatStore = create<ChatStoreWithHydration>()(
  devtools(
    persist(
      (set, get, store) => ({
        ...createMessagesSlice(set, get, store),
        ...createSessionsSlice(set, get, store),
        ...createDeepResearchSlice(set, get, store),
        // Client-only hydration flag (C5); flipped true in onRehydrateStorage.
        hasHydrated: false,
      }),
      {
        name: 'aiq-chat-store',
        storage: typeof window === 'undefined' ? undefined : createResilientStorage(),
        partialize: (state) => ({
          currentUserId: state.currentUserId,
          conversations: state.conversations,
          currentConversation: state.currentConversation,
          pendingInteraction: state.pendingInteraction,
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
            void store.refreshDeepResearchSessionStatuses()
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

export const selectHasConnectionError = (state: ChatStore): boolean =>
  state.currentConversation?.messages.some(
    (m) => m.messageType === 'error' && m.errorData?.errorCode?.startsWith('connection.')
  ) ?? false

// ============================================================
// Storage Event Monitoring (for debugging session clearing)
// ============================================================

if (typeof window !== 'undefined') {
  const initialState = useChatStore.getState()
  logStoreHydration(true, initialState.conversations?.length ?? 0, initialState.currentUserId)

  window.addEventListener('storage', (event) => {
    if (event.key === 'aiq-chat-store') {
      logExternalStorageEvent(event.key, event.oldValue, event.newValue)

      if (event.oldValue !== null && event.newValue === null) {
        console.error(
          '[SessionsStore] ❌ CRITICAL: Storage cleared by external source (browser extension, dev tools, or another tab)'
        )
      }
    }
  })
}

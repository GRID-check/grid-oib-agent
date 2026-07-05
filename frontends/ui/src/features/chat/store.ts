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

export const useChatStore = create<ChatStore>()(
  devtools(
    persist(
      (set, get, store) => ({
        ...createMessagesSlice(set, get, store),
        ...createSessionsSlice(set, get, store),
        ...createDeepResearchSlice(set, get, store),
      }),
      {
        name: 'aiq-chat-store',
        storage: typeof window === 'undefined' ? undefined : createResilientStorage(),
        partialize: (state) => ({
          currentUserId: state.currentUserId,
          conversations: state.conversations,
          currentConversation: state.currentConversation,
          pendingInteraction: state.pendingInteraction,
        }),
        onRehydrateStorage: () => (state) => {
          if (!state || typeof window === 'undefined') return
          queueMicrotask(() => {
            void useChatStore.getState().refreshDeepResearchSessionStatuses()
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

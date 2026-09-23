/**
 * Interaction slice: the one HITL prompt the agent is waiting on, and the
 * send path that answers it.
 *
 * `pendingInteraction` is persisted (see `partialize` in `../store.ts`) so a
 * reload lands on the same open question; `respondToInteractionFn` is the
 * socket's own callback, registered by the composer while it holds the
 * connection, and is deliberately not.
 */

import type { StateCreator } from 'zustand'
import type { ChatStore, PendingInteraction } from '../types'

export type InteractionSlice = {
  pendingInteraction: PendingInteraction | null
  respondToInteractionFn: ((response: string) => void) | null
  setPendingInteraction: (interaction: PendingInteraction | null) => void
  clearPendingInteraction: () => void
  setRespondToInteractionFn: (fn: ((response: string) => void) | null) => void
}

export const initialInteractionState = {
  pendingInteraction: null as PendingInteraction | null,
  respondToInteractionFn: null as ((response: string) => void) | null,
}

export const createInteractionSlice: StateCreator<
  ChatStore,
  [['zustand/devtools', never]],
  [],
  InteractionSlice
> = (set) => ({
  ...initialInteractionState,

  setPendingInteraction: (interaction) => {
    set({ pendingInteraction: interaction }, false, 'setPendingInteraction')
  },

  clearPendingInteraction: () => {
    set({ pendingInteraction: null }, false, 'clearPendingInteraction')
  },

  setRespondToInteractionFn: (fn) => {
    set({ respondToInteractionFn: fn }, false, 'setRespondToInteractionFn')
  },
})

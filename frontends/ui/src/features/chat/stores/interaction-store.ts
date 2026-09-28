/**
 * Interaction slice: the one HITL prompt the agent is waiting on, and the
 * send path that answers it.
 *
 * `pendingInteraction` is derived from the running turn's view
 * (`turnStateFor`): a reload re-attaches the turn, and its replayed
 * `interaction_request` opens the question again. `respondToInteractionFn` is
 * the socket's own callback, registered by the composer while it holds the
 * connection.
 */

import type { StateCreator } from 'zustand'
import type { ChatStore, PendingInteraction } from '../types'

export type InteractionSlice = {
  pendingInteraction: PendingInteraction | null
  respondToInteractionFn: ((response: string) => void) | null
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

  setRespondToInteractionFn: (fn) => {
    set({ respondToInteractionFn: fn }, false, 'setRespondToInteractionFn')
  },
})

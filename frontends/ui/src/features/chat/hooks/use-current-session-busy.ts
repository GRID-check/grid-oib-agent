/**
 * useIsCurrentSessionBusy Hook
 *
 * Is the CURRENT session mid-operation? Disables file operations, data source
 * changes, exports and session management while:
 * - the socket is streaming a turn (shallow thinking), or
 * - a HITL prompt is waiting for the person's answer.
 *
 * A deep-research run is NOT busy-ness. It is a message in the thread with
 * its own stop control (ADR-0062), the person keeps chatting beside it, and a
 * lock keyed to it is how a run whose terminal event was lost used to hold a
 * whole session hostage.
 *
 * For per-session checks (e.g., session deletion), use store.isSessionBusy() instead.
 */

'use client'

import { useChatStore } from '../store'

export const useIsCurrentSessionBusy = (): boolean => {
  const isStreaming = useChatStore((state) => state.isStreaming)
  // Persisted (part of `partialize`), so it survives the reload gap.
  const hasPendingInteraction = useChatStore((state) => state.pendingInteraction !== null)
  return isStreaming || hasPendingInteraction
}

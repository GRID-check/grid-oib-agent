/**
 * Which answer is still being revealed on screen: streaming, or finishing the
 * text its pace held back after the turn ended (`usePacedText`).
 *
 * The answer owns this, because only it knows when its text is all on screen.
 * The turn's store says when the STREAM ended, which is up to half a second
 * earlier; whatever belongs to a finished answer outside the answer itself
 * (the Herleitung's collapse, in `ChatArea`) waits for this instead, so the
 * turn settles in one step rather than collapsing while the text still grows.
 *
 * Not persisted, and not part of the chat store: it is a fact about what is
 * drawn, and a reload draws every answer settled.
 */

import { create } from 'zustand'

interface AnswerRevealState {
  /** The message id of the answer being revealed, or `null`. */
  revealingId: string | null
  begin: (messageId: string) => void
  /** Clears `messageId`, and only it: a later answer may already have begun. */
  end: (messageId: string) => void
}

export const useAnswerRevealStore = create<AnswerRevealState>()((set) => ({
  revealingId: null,
  begin: (messageId) => set({ revealingId: messageId }),
  end: (messageId) => set((s) => (s.revealingId === messageId ? { revealingId: null } : s)),
}))

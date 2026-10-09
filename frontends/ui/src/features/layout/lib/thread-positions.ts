/**
 * Where the reader was in each thread, for the session.
 *
 * Switching away from a thread and back used to land at its bottom whatever
 * the reader had been reading. A thread is reopened where it was left: the
 * first message row the reader could see, and how far below the top of the
 * viewport its top edge sat. A row rather than a scroll offset, because the
 * thread above it can change height while it is closed (a Herleitung restored
 * folded, a card that loaded), and the row is what the reader remembers.
 *
 * A reader who was at the end of the thread is remembered as being at the
 * end: what arrived since is what they would have followed.
 *
 * In memory only: a reload is a fresh visit and opens as one.
 */

export type ThreadPosition =
  { atEnd: true } | { atEnd: false; messageId: string; offsetTop: number }

const positions = new Map<string, ThreadPosition>()

export const rememberThreadPosition = (conversationId: string, position: ThreadPosition): void => {
  positions.set(conversationId, position)
}

export const readThreadPosition = (conversationId: string): ThreadPosition | undefined =>
  positions.get(conversationId)

export const forgetThreadPosition = (conversationId: string): void => {
  positions.delete(conversationId)
}

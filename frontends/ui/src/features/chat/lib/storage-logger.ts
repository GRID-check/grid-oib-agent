/**
 * Storage Logger
 *
 * Logging for the persisted chat store's localStorage (`stores/chat-storage.ts`).
 * What only a developer needs is gated on `NODE_ENV`; an eviction and a
 * write that could not be stored are always logged, because they explain a
 * conversation that opens with a fetch instead of at once.
 */

const LOG_PREFIX = '[SessionsStore]'

const getTimestamp = (): string => new Date().toISOString()

/** One conversation's messages were written (dev-only). */
export const logStorageWrite = (conversationId: string, chars: number): void => {
  if (process.env.NODE_ENV !== 'development') return

  console.debug(`${LOG_PREFIX} localStorage write: ${conversationId}, ${Math.round(chars / 1024)}K chars`, {
    conversationId,
    chars,
    timestamp: getTimestamp(),
  })
}

/**
 * An old conversation's messages left storage, or were not written, to make
 * room (ALWAYS logged). Nothing is lost: the server holds them, and opening
 * the conversation reads them.
 */
export const logStorageEviction = (conversationId: string, chars: number): void => {
  console.warn(`${LOG_PREFIX} Evicted the stored messages of ${conversationId} to make room; the server holds them`, {
    conversationId,
    chars,
    timestamp: getTimestamp(),
  })
}

/** A write did not fit even with nothing left to evict (ALWAYS logged). */
export const logStorageFailure = (key: string, chars: number, error: unknown): void => {
  console.error(`${LOG_PREFIX} Could not store ${key}: nothing left to evict`, {
    key,
    chars,
    timestamp: getTimestamp(),
    error: error instanceof Error ? error.message : String(error),
  })
}

/** The single-key history was split into one key per conversation (dev-only). */
export const logStorageMigration = (conversationCount: number): void => {
  if (process.env.NODE_ENV !== 'development') return

  console.debug(`${LOG_PREFIX} Moved ${conversationCount} conversations to one key each`, {
    timestamp: getTimestamp(),
  })
}

/**
 * Log storage event from another tab or extension (dev-only)
 */
export const logExternalStorageEvent = (
  key: string | null,
  oldValue: string | null,
  newValue: string | null
): void => {
  if (process.env.NODE_ENV !== 'development') return

  console.warn(`${LOG_PREFIX} 🔍 Storage event detected: external modification`, {
    key,
    cleared: oldValue !== null && newValue === null,
    modified: oldValue !== null && newValue !== null,
    timestamp: getTimestamp(),
  })
}

/**
 * Log store hydration on initialization (dev-only)
 */
export const logStoreHydration = (
  success: boolean,
  sessionCount: number,
  userId: string | null
): void => {
  if (process.env.NODE_ENV !== 'development') return

  if (success) {
    console.debug(`${LOG_PREFIX} Store hydrated from localStorage: ${sessionCount} sessions`, {
      userId,
      timestamp: getTimestamp(),
    })
  } else {
    console.warn(`${LOG_PREFIX} Store hydration failed - starting with empty state`, {
      timestamp: getTimestamp(),
    })
  }
}

/**
 * Log localStorage availability check (dev-only)
 */
export const logStorageAvailability = (available: boolean): void => {
  if (process.env.NODE_ENV !== 'development') return

  if (!available) {
    console.warn(`${LOG_PREFIX} localStorage not available - persistence disabled`, {
      timestamp: getTimestamp(),
    })
  }
}

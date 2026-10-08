/**
 * Tear down the browser's documents state for a chat session id.
 * Used when abandoning upload-only sessions (no user chat messages).
 *
 * Client state only. The server side — the attachment rows, their objects and
 * chunks, and the chat's `s_` collection — is erased by the conversation delete
 * the caller issues next (`DELETE /api/conversations/[id]`), which owns that
 * erasure. The collection is not deleted here: a collection delete sent
 * alongside the conversation delete races it, and one that lands after the row
 * is refused (it authorizes on the row), which orphans the collection.
 */

import { removePersistedJobForCollection, unmarkSessionCollection } from './persistence'
import { UploadOrchestrator } from './orchestrator'
import { useDocumentsStore } from './store'

export const discardSessionDocumentsResources = (sessionId: string): void => {
  UploadOrchestrator.stopPollingIfCollection(sessionId)
  unmarkSessionCollection(sessionId)
  removePersistedJobForCollection(sessionId)

  const docs = useDocumentsStore.getState()
  docs.clearFilesForCollection(sessionId)
  if (docs.currentCollectionName === sessionId) {
    docs.setCurrentCollection(null)
    docs.setCollectionInfo(null)
  }
}

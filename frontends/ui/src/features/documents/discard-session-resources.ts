/**
 * Tear down documents state and delete the backend collection for a chat session id.
 * Used when abandoning upload-only sessions (no user chat messages).
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

  // Use the orchestrator's authenticated client: a token-less client 401s in
  // auth-required deployments and the orphaned collection persists forever.
  void UploadOrchestrator.getAuthenticatedClient()
    .deleteCollection(sessionId)
    .catch((err) => {
      console.warn('Failed to delete documents collection for discarded session:', sessionId, err)
    })
}

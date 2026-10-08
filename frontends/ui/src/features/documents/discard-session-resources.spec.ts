/**
 * Discarding an abandoned upload-only chat is ONE server call: the conversation
 * delete, which erases the attachments and the `s_` collection itself.
 *
 * The helper clears browser state and sends nothing. A collection delete fired
 * through the v1 proxy alongside the conversation delete would race it: that
 * request authorizes on the conversation row, so whenever the row goes first the
 * collection delete is refused and the collection is orphaned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deleteCollection = vi.hoisted(() => vi.fn())
const stopPollingIfCollection = vi.hoisted(() => vi.fn())

vi.mock('./orchestrator', () => ({
  UploadOrchestrator: {
    stopPollingIfCollection,
    getAuthenticatedClient: () => ({ deleteCollection }),
  },
}))

import { discardSessionDocumentsResources } from './discard-session-resources'
import { useDocumentsStore } from './store'

const SESSION_ID = 's_11111111_2222_4333_8444_555555555555'

describe('discardSessionDocumentsResources', () => {
  beforeEach(() => {
    deleteCollection.mockReset()
    stopPollingIfCollection.mockReset()
    vi.stubGlobal('fetch', vi.fn())
    useDocumentsStore.setState({
      currentCollectionName: SESSION_ID,
      trackedFiles: [
        {
          id: 'f1',
          fileName: 'plan.pdf',
          fileSize: 1,
          status: 'success',
          progress: 100,
          collectionName: SESSION_ID,
        },
      ],
    })
  })

  it('clears the browser state for the chat', () => {
    discardSessionDocumentsResources(SESSION_ID)

    expect(stopPollingIfCollection).toHaveBeenCalledWith(SESSION_ID)
    expect(useDocumentsStore.getState().trackedFiles).toEqual([])
    expect(useDocumentsStore.getState().currentCollectionName).toBeNull()
  })

  it('sends no collection delete of its own; the conversation delete owns that erasure', () => {
    discardSessionDocumentsResources(SESSION_ID)

    expect(deleteCollection).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

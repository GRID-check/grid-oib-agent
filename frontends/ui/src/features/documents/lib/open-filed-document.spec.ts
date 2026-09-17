/**
 * A filed artifact opens BESIDE the conversation.
 *
 * The thing being tested is mostly a set of refusals: no second document type,
 * no composer subject bound to a document nothing indexed, no pane opened
 * underneath a panel that would hide it, and no dead control when the row
 * cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import { useLayoutStore } from '@/features/layout/store'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { resetFilePeekBinding } from './open-file-peek'
import { openFiledDocument } from './open-filed-document'

const ROW = {
  id: 'doc-9',
  filename: 'Tiefenrecherche_Brandschutz.pdf',
  displayName: null,
  status: 'stored',
  contentType: 'application/pdf',
  fileSize: 1048576,
  createdAt: '2026-01-01T00:00:00.000Z',
  authoredBy: 'agent',
}

function answerWith(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)),
  )
}

beforeEach(() => {
  resetFilePeekBinding()
  useFilePreviewStore.setState({ file: null, mode: 'modal', hidden: false, context: {} })
  useLayoutStore.setState({ rightPanel: null })
  useChatStore.setState({ composerSubject: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('opening the artifact Piloti just filed', () => {
  it('puts it in the peek pane rather than navigating away', async () => {
    answerWith(ROW)
    await expect(openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })).resolves.toBe(true)
    const state = useFilePreviewStore.getState()
    expect(state.file?.id).toBe('doc-9')
    expect(state.mode).toBe('peek')
    expect(state.hidden).toBe(false)
  })

  it('reads the row through the status call the chat route already uses', async () => {
    answerWith(ROW)
    await openFiledDocument({ documentId: 'doc 9/x', projectId: 'proj-1' })
    // One document shape, one endpoint. A parallel fetch is a second thing that
    // can disagree about what a file is called or whether it is indexed.
    expect(fetch).toHaveBeenCalledWith('/api/documents/doc%209%2Fx/status')
  })

  it('carries the byline into the pane', async () => {
    // Provenance is the reason it looks like a report Piloti wrote rather than
    // an ordinary upload once it is open.
    answerWith(ROW)
    await openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })
    expect(useFilePreviewStore.getState().file?.authoredBy).toBe('agent')
  })

  it('does not bind it as the composer subject', async () => {
    // An agent-authored file is `stored`: never dispatched to `/v1/ingest`, so
    // Ask is disabled on its own preview. Binding it would promise a retrieval
    // the retrieval path cannot perform.
    answerWith(ROW)
    await openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })
    expect(useChatStore.getState().composerSubject).toBeNull()
  })

  it('closes the research panel, which would otherwise hide the pane', async () => {
    // `FilePreviewHost` refuses to peek while the research panel is open, and
    // that panel is exactly where a reader watching a deep-research run is.
    answerWith(ROW)
    useLayoutStore.setState({ rightPanel: 'research' })
    await openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })
    expect(useLayoutStore.getState().rightPanel).toBeNull()
  })
})

describe('when the row cannot be read', () => {
  it('says so instead of opening an empty pane', async () => {
    answerWith(null, false)
    await expect(openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })).resolves.toBe(false)
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  it('refuses a body that is not a document', async () => {
    answerWith({ error: 'nope' })
    await expect(openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })).resolves.toBe(false)
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  it('leaves the research panel alone when it is not going to open anything', async () => {
    answerWith(null, false)
    useLayoutStore.setState({ rightPanel: 'research' })
    await openFiledDocument({ documentId: 'doc-9', projectId: 'proj-1' })
    expect(useLayoutStore.getState().rightPanel).toBe('research')
  })
})

import { describe, expect, it, vi, beforeEach } from 'vitest'

const startNewSessionDraft = vi.fn()
const setComposerPrefill = vi.fn()
const peek = vi.fn()
const open = vi.fn()
const beginHandoff = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: {
    getState: () => ({
      currentUserId: 'user-1',
      currentConversation: null,
      startNewSessionDraft,
      setComposerPrefill,
    }),
  },
}))

vi.mock('../stores/file-preview-store', () => ({
  useFilePreviewStore: {
    getState: () => ({
      file: null,
      peek,
      open,
      beginHandoff,
    }),
  },
}))

import { askAboutFile } from './ask-about-file'

describe('askAboutFile', () => {
  beforeEach(() => {
    startNewSessionDraft.mockClear()
    setComposerPrefill.mockClear()
    peek.mockClear()
    open.mockClear()
    beginHandoff.mockClear()
  })

  it('holds the viewer open until the conversation it is navigating to exists', () => {
    askAboutFile({
      projectId: 'proj-1',
      file: {
        id: 'doc-9',
        filename: 'Brandschutz.pdf',
        displayName: null,
        fileSize: 1,
        contentType: 'application/pdf',
        status: 'ready',
        folderId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        errorMessage: null,
        summary: null,
        pageCount: null,
        chunkCount: null,
        contentTypes: null,
        tags: null,
      },
      navigate: vi.fn(),
    })

    // THE JOIN. The mode set above is the destination's, and this function is
    // what knows a navigation is about to happen — drop this call and the pane
    // goes back to parking itself at the click, which is invisible to every
    // other test here because the store state is identical either way.
    expect(beginHandoff).toHaveBeenCalledTimes(1)
  })

  it('lands on a new chat that names the file, with project shelf', () => {
    const navigate = vi.fn()
    askAboutFile({
      projectId: 'proj-1',
      file: {
        id: 'doc-9',
        filename: 'Brandschutz.pdf',
        displayName: 'Brandschutzkonzept',
        fileSize: 1,
        contentType: 'application/pdf',
        status: 'completed',
        folderId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        errorMessage: null,
        summary: null,
        pageCount: 1,
        chunkCount: 1,
        contentTypes: null,
        tags: null,
      },
      navigate,
    })

    expect(open).toHaveBeenCalled()
    expect(startNewSessionDraft).toHaveBeenCalled()
    expect(setComposerPrefill).toHaveBeenCalledWith(
      '',
      undefined,
      expect.objectContaining({
        resourceId: 'doc-9',
        filename: 'Brandschutz.pdf',
        title: 'Brandschutzkonzept',
        shelf: 'project',
      }),
    )
    expect(navigate).toHaveBeenCalledWith(
      '/app/projects/proj-1/chat?new=1&doc=doc-9&file=Brandschutz.pdf',
    )
  })
})

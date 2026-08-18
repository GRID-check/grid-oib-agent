import { describe, expect, it, vi, beforeEach } from 'vitest'

const startNewSessionDraft = vi.fn()
const setComposerPrefill = vi.fn()
const peek = vi.fn()
const open = vi.fn()

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

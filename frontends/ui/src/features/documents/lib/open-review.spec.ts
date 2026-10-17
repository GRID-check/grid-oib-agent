/**
 * Into a document's Prüfansicht at one mark, over the chat, and nowhere else.
 *
 * What is held here: the chat's link carries `review` and `mark` and nothing
 * the chat page reads as something else (`doc` starts an ask there); every
 * other param and the hash survive, so the thread on screen stays; the
 * document is in the peek BEFORE the link lands, because the pane takes the
 * link for the document it shows; and a surface with no pane goes to Dateien
 * rather than doing nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import type { FileItem } from '../components/project-file-workspace'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { resetFilePeekBinding } from './open-file-peek'
import {
  clearReviewParams,
  hrefWithParams,
  isProjectChatPath,
  readReviewParams,
  openReviewAt,
  reviewFilesHref,
  reviewHrefAt,
  showDocumentBeside,
} from './open-review'

const DOC = '00000000-0000-4000-8000-0000000000d1'
const CHAT = { pathname: '/app/projects/p1/chat', search: '?session=s1', hash: '#message-m1' }

const ROW = {
  id: DOC,
  filename: 'Grundriss EG.pdf',
  displayName: null,
  status: 'ready',
  contentType: 'application/pdf',
  fileSize: 2048,
  createdAt: '2026-10-01T00:00:00.000Z',
}

function answerWith(body: unknown, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)))
}

beforeEach(() => {
  resetFilePeekBinding()
  useFilePreviewStore.setState({ file: null, mode: 'modal', hidden: false, context: {} })
  useChatStore.setState({ composerSubject: null })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the review link', () => {
  it('puts review and mark on the chat url and keeps the session and the anchor', () => {
    expect(reviewHrefAt(CHAT, { documentId: DOC, annotationId: 'ann-7' })).toBe(
      '/app/projects/p1/chat?session=s1&review=1&mark=ann-7#message-m1'
    )
  })

  it('never carries doc on the chat, where doc is an ask', () => {
    expect(reviewHrefAt(CHAT, { documentId: DOC, annotationId: 'ann-7' })).not.toContain('doc=')
  })

  it('opens the review at its start when no mark is named, dropping a stale one', () => {
    const href = reviewHrefAt({ ...CHAT, search: '?session=s1&mark=old' }, { documentId: DOC })
    expect(href).toBe('/app/projects/p1/chat?session=s1&review=1#message-m1')
  })

  it('names the document on the Dateien link, whose page has to be told which file', () => {
    expect(reviewFilesHref('p1', { documentId: DOC, annotationId: 'ann-7' })).toBe(
      `/app/projects/p1/files?doc=${DOC}&review=1&mark=ann-7`
    )
  })

  it('knows the project chat from the other routes', () => {
    expect(isProjectChatPath('/app/projects/p1/chat')).toBe(true)
    expect(isProjectChatPath('/app/projects/p1/files')).toBe(false)
    expect(isProjectChatPath('/app/platform/cards')).toBe(false)
  })
})

describe('the review in the url', () => {
  it('reads the document, the mark and the armed tool', () => {
    expect(readReviewParams(new URLSearchParams(`doc=${DOC}&review=1&mark=ann-7&tool=point`))).toEqual({
      documentId: DOC,
      open: true,
      annotationId: 'ann-7',
      tool: 'point',
    })
  })

  it('opens nothing from a mark or a tool without review, and arms no tool it does not know', () => {
    expect(readReviewParams(new URLSearchParams('mark=ann-7&tool=point'))).toMatchObject({
      open: false,
      annotationId: null,
      tool: null,
    })
    expect(readReviewParams(new URLSearchParams('review=1&tool=delete')).tool).toBeNull()
    expect(readReviewParams(null).open).toBe(false)
  })

  it('arms a tool on the Dateien link, and drops a stale one on the chat', () => {
    expect(reviewFilesHref('p1', { documentId: DOC, tool: 'point' })).toBe(`/app/projects/p1/files?doc=${DOC}&review=1&tool=point`)
    expect(reviewHrefAt({ ...CHAT, search: '?session=s1&tool=region' }, { documentId: DOC })).toBe(
      '/app/projects/p1/chat?session=s1&review=1#message-m1'
    )
  })

  it('takes the review off and leaves the document open', () => {
    const params = clearReviewParams(new URLSearchParams(`doc=${DOC}&review=1&mark=ann-2&tool=point&session=s1`))
    expect(params.toString()).toBe(`doc=${DOC}&session=s1`)
    expect(hrefWithParams('/app/projects/p1/chat', clearReviewParams(new URLSearchParams('review=1')))).toBe(
      '/app/projects/p1/chat'
    )
  })
})

describe('opening it', () => {
  it('puts the document in the peek first, then replaces the url', async () => {
    answerWith(ROW)
    const navigate = vi.fn((_href: string, _how: 'replace' | 'push') => {
      // The pane takes the link for the file it shows: by now it must be ours.
      expect(useFilePreviewStore.getState().file?.id).toBe(DOC)
    })

    await expect(
      openReviewAt({ documentId: DOC, annotationId: 'ann-7' }, { projectId: 'p1', navigate, location: CHAT })
    ).resolves.toBe('beside')

    expect(navigate).toHaveBeenCalledWith('/app/projects/p1/chat?session=s1&review=1&mark=ann-7#message-m1', 'replace')
    const state = useFilePreviewStore.getState()
    expect(state.mode).toBe('peek')
    // Looking at a mark is not asking about the document.
    expect(useChatStore.getState().composerSubject).toBeNull()
  })

  it('reuses the open document without reading it again, and brings a hidden peek back', async () => {
    answerWith(ROW)
    useFilePreviewStore.setState({ file: { id: DOC } as FileItem, mode: 'peek', hidden: true })

    await expect(showDocumentBeside(DOC, { projectId: 'p1' })).resolves.toBe(true)

    expect(fetch).not.toHaveBeenCalled()
    expect(useFilePreviewStore.getState().hidden).toBe(false)
  })

  it('writes no link when the document cannot be read', async () => {
    answerWith({}, false)
    const navigate = vi.fn()

    await expect(
      openReviewAt({ documentId: DOC, annotationId: 'ann-7' }, { projectId: 'p1', navigate, location: CHAT })
    ).resolves.toBe('unavailable')

    expect(navigate).not.toHaveBeenCalled()
  })

  it('goes to Dateien from a surface with no pane beside it', async () => {
    answerWith(ROW)
    const navigate = vi.fn()

    await expect(
      openReviewAt(
        { documentId: DOC, annotationId: 'ann-7' },
        { projectId: 'p1', navigate, location: { pathname: '/app/platform/cards', search: '', hash: '' } }
      )
    ).resolves.toBe('files')

    expect(navigate).toHaveBeenCalledWith(`/app/projects/p1/files?doc=${DOC}&review=1&mark=ann-7`, 'push')
    expect(fetch).not.toHaveBeenCalled()
  })
})

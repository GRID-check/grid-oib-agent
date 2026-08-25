import { describe, expect, it, beforeEach } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import {
  FILE_PEEK_WIDTH_MAX,
  FILE_PEEK_WIDTH_MIN,
  FILE_PEEK_WIDTH_STORAGE_KEY,
  isFilePeekVisible,
  readStoredPeekWidth,
  useFilePreviewStore,
} from './file-preview-store'
import type { FileItem } from '../components/project-file-workspace'

const FILE: FileItem = {
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 12,
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
}

describe('file-preview-store', () => {
  beforeEach(() => {
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekWidth: 320,
      context: {},
    })
    useChatStore.setState({ composerSubject: null })
    window.localStorage.clear()
  })

  it('peeks the same file without dropping it', () => {
    useFilePreviewStore.getState().open(FILE, 'modal', { projectId: 'p1' })
    useFilePreviewStore.getState().peek()
    const state = useFilePreviewStore.getState()
    expect(state.file?.id).toBe('doc-1')
    expect(state.mode).toBe('peek')
    expect(state.hidden).toBe(false)
  })

  it('expand and hide keep the file so coming back can restore the peek', () => {
    useFilePreviewStore.getState().open(FILE, 'peek')
    useFilePreviewStore.getState().expand()
    expect(useFilePreviewStore.getState().mode).toBe('expanded')
    useFilePreviewStore.getState().hide()
    expect(useFilePreviewStore.getState().file?.id).toBe('doc-1')
    expect(useFilePreviewStore.getState().hidden).toBe(true)
    useFilePreviewStore.getState().peek()
    expect(useFilePreviewStore.getState().hidden).toBe(false)
    expect(useFilePreviewStore.getState().mode).toBe('peek')
  })

  it('hide keeps an Ask subject so the pill can dismiss it; close still clears', () => {
    useFilePreviewStore.getState().open(FILE, 'peek')
    const subject = {
      resourceType: 'document' as const,
      resourceId: 'doc-1',
      filename: 'plan.pdf',
    }
    useChatStore.setState({ composerSubject: subject })
    useFilePreviewStore.getState().hide()
    expect(useChatStore.getState().composerSubject).toEqual(subject)

    useFilePreviewStore.getState().peek()
    useFilePreviewStore.getState().close()
    expect(useChatStore.getState().composerSubject).toBeNull()
    expect(useFilePreviewStore.getState().file).toBeNull()
  })

  it('hide does not clear a subject that is a different file', () => {
    const other = {
      resourceType: 'document' as const,
      resourceId: 'doc-other',
      filename: 'other.pdf',
    }
    useFilePreviewStore.getState().open(FILE, 'peek')
    useChatStore.setState({ composerSubject: other })
    useFilePreviewStore.getState().hide()
    expect(useChatStore.getState().composerSubject).toEqual(other)
  })

  it('isFilePeekVisible is only true for an unhidden peek or expanded pane', () => {
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'peek' })).toBe(true)
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'expanded' })).toBe(true)
    expect(isFilePeekVisible({ file: FILE, hidden: true, mode: 'peek' })).toBe(false)
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'modal' })).toBe(false)
    expect(isFilePeekVisible({ file: null, hidden: false, mode: 'peek' })).toBe(false)
  })

  describe('the peek width belongs to the reader, so it outlives the session', () => {
    it('remembers a width the reader dragged to', () => {
      useFilePreviewStore.getState().setPeekWidth(512)

      expect(useFilePreviewStore.getState().peekWidth).toBe(512)
      expect(window.localStorage.getItem(FILE_PEEK_WIDTH_STORAGE_KEY)).toBe('512')
    })

    it('adopts the remembered width on the next mount, and reports it back', () => {
      window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, '640')

      // The caller needs the value returned, not just stored: it sizes the panel
      // in the same commit, before anything renders at the default.
      expect(useFilePreviewStore.getState().restorePeekWidth()).toBe(640)
      expect(useFilePreviewStore.getState().peekWidth).toBe(640)
    })

    it('leaves the default alone when nothing is remembered', () => {
      expect(useFilePreviewStore.getState().restorePeekWidth()).toBeNull()
      expect(useFilePreviewStore.getState().peekWidth).toBe(320)
    })

    it('lets the pane past the old 560px ceiling', () => {
      // The cap used to sit at 560, which is narrower than an A3 plan at any
      // readable zoom: the seam hit a wall a third of the way across the window.
      useFilePreviewStore.getState().setPeekWidth(700)

      expect(useFilePreviewStore.getState().peekWidth).toBe(700)
    })

    it('clamps to the bounds, coming and going', () => {
      useFilePreviewStore.getState().setPeekWidth(5000)
      expect(useFilePreviewStore.getState().peekWidth).toBe(FILE_PEEK_WIDTH_MAX)

      useFilePreviewStore.getState().setPeekWidth(10)
      expect(useFilePreviewStore.getState().peekWidth).toBe(FILE_PEEK_WIDTH_MIN)

      window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, '5000')
      expect(readStoredPeekWidth()).toBe(FILE_PEEK_WIDTH_MAX)
    })

    it('refuses a stored value that is not a usable width', () => {
      window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, 'wide-ish')
      expect(readStoredPeekWidth()).toBeNull()

      // `Number('')` is 0, which would restore as the minimum rather than as
      // "nothing stored" — the pane would open narrow for no stated reason.
      window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, '')
      expect(readStoredPeekWidth()).toBeNull()
    })
  })
})

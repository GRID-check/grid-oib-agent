import { describe, expect, it, beforeEach } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import {
  FILE_PEEK_RATIO_DEFAULT,
  FILE_PEEK_RATIO_MAX,
  FILE_PEEK_RATIO_MIN,
  filePeekSize,
  isFilePeekVisible,
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
      peekRatio: 38,
      context: {},
    })
    useChatStore.setState({ composerSubject: null })
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

  it('keeps the peek width as a share of the row, clamped to its bounds', () => {
    const { setPeekRatio } = useFilePreviewStore.getState()

    setPeekRatio(62.34)
    // Tenths, not whole percent: on a wide row a 1% step is a visible jump
    // under the cursor, and the drag should not feel notched.
    expect(useFilePreviewStore.getState().peekRatio).toBe(62.3)

    setPeekRatio(200)
    expect(useFilePreviewStore.getState().peekRatio).toBe(FILE_PEEK_RATIO_MAX)

    setPeekRatio(1)
    expect(useFilePreviewStore.getState().peekRatio).toBe(FILE_PEEK_RATIO_MIN)

    // A zero-width group divides by nothing; the panel reports NaN and the pane
    // must not inherit it as a width.
    setPeekRatio(Number.NaN)
    expect(useFilePreviewStore.getState().peekRatio).toBe(FILE_PEEK_RATIO_DEFAULT)
  })

  it('renders the width with an explicit percent unit', () => {
    // Bare numbers mean PIXELS to the panel library, so an unqualified 38 would
    // be a 38px pane that reads as "the resize did nothing".
    expect(filePeekSize(38)).toBe('38%')
    expect(filePeekSize(1000)).toBe(`${FILE_PEEK_RATIO_MAX}%`)
  })

  it('isFilePeekVisible is only true for an unhidden peek or expanded pane', () => {
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'peek' })).toBe(true)
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'expanded' })).toBe(true)
    expect(isFilePeekVisible({ file: FILE, hidden: true, mode: 'peek' })).toBe(false)
    expect(isFilePeekVisible({ file: FILE, hidden: false, mode: 'modal' })).toBe(false)
    expect(isFilePeekVisible({ file: null, hidden: false, mode: 'peek' })).toBe(false)
  })
})

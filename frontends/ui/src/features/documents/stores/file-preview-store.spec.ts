import { describe, expect, it, beforeEach } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import { isFilePeekVisible, useFilePreviewStore } from './file-preview-store'
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

  it('hide and close clear composerSubject when it is this file', () => {
    useFilePreviewStore.getState().open(FILE, 'peek')
    useChatStore.setState({
      composerSubject: {
        resourceType: 'document',
        resourceId: 'doc-1',
        filename: 'plan.pdf',
      },
    })
    useFilePreviewStore.getState().hide()
    expect(useChatStore.getState().composerSubject).toBeNull()

    useFilePreviewStore.getState().peek()
    useChatStore.setState({
      composerSubject: {
        resourceType: 'document',
        resourceId: 'doc-1',
        filename: 'plan.pdf',
      },
    })
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
})

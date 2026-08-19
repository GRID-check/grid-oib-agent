import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '@/features/chat/store'
import type { FileItem } from '../components/project-file-workspace'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { openFilePeek, resetFilePeekBinding } from './open-file-peek'

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

describe('openFilePeek', () => {
  beforeEach(() => {
    resetFilePeekBinding()
    useFilePreviewStore.setState({
      file: null,
      mode: 'modal',
      hidden: false,
      peekRatio: 38,
      context: {},
    })
    useChatStore.setState({ composerSubject: null })
  })

  afterEach(() => {
    resetFilePeekBinding()
    useFilePreviewStore.setState({ file: null, hidden: false, mode: 'modal', context: {} })
    useChatStore.setState({ composerSubject: null })
  })

  it('opens the peek and binds composerSubject to the filename', () => {
    openFilePeek({ file: FILE, source: 'projekt', projectId: 'p1' })
    const preview = useFilePreviewStore.getState()
    expect(preview.file?.id).toBe('doc-1')
    expect(preview.mode).toBe('peek')
    expect(preview.hidden).toBe(false)
    expect(useChatStore.getState().composerSubject).toEqual({
      resourceType: 'document',
      resourceId: 'doc-1',
      title: 'plan.pdf',
      filename: 'plan.pdf',
      shelf: 'project',
    })
  })

  it('keeps a bound subject when the peek is hidden so the composer bar stays', () => {
    openFilePeek({ file: FILE, source: 'projekt', projectId: 'p1' })
    useFilePreviewStore.getState().hide()
    expect(useFilePreviewStore.getState().hidden).toBe(true)
    expect(useChatStore.getState().composerSubject?.resourceId).toBe('doc-1')
  })

  it('clears a bound subject when the peek is closed', () => {
    openFilePeek({ file: FILE, source: 'projekt', projectId: 'p1' })
    useFilePreviewStore.getState().close()
    expect(useFilePreviewStore.getState().file).toBeNull()
    expect(useChatStore.getState().composerSubject).toBeNull()
  })

  it('does not steal an Ask-Piloti subject that was not bound by this helper', () => {
    useChatStore.getState().setComposerSubject({
      resourceType: 'document',
      resourceId: 'other',
      filename: 'other.pdf',
    })
    useFilePreviewStore.getState().open(FILE, 'peek')
    useFilePreviewStore.getState().hide()
    expect(useChatStore.getState().composerSubject?.resourceId).toBe('other')
  })
})

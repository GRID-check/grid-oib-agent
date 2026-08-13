/**
 * The file that is currently open — one instance, three presentations.
 *
 * Files opens it as a modal. Chat keeps it as a peek of the file you are
 * talking about (not a half-screen split). Expand uses the same pane.
 *
 * hide() / close() drop composerSubject when it is this file so a dismissed
 * peek cannot leave a silent retrieval focus. The send path also ignores
 * focus unless the peek is actually visible (`isFilePeekVisible`).
 */

import { create } from 'zustand'
import { useChatStore } from '@/features/chat/store'
import type { DocumentScope } from '../components/document-actions'
import type { FileItem } from '../components/project-file-workspace'

export type FilePreviewMode = 'modal' | 'peek' | 'expanded'

export const FILE_PEEK_WIDTH_MIN = 280
export const FILE_PEEK_WIDTH_MAX = 560
export const FILE_PEEK_WIDTH_DEFAULT = 320

/** Retrieval follows the file the user can see, not a leftover composer chip. */
export function isFilePeekVisible(state?: {
  file: FileItem | null
  hidden: boolean
  mode: FilePreviewMode
}): boolean {
  const current = state ?? useFilePreviewStore.getState()
  return current.file != null && !current.hidden && (current.mode === 'peek' || current.mode === 'expanded')
}

function clearMatchingComposerSubject(file: FileItem | null): void {
  if (!file) return
  const chat = useChatStore.getState()
  if (chat.composerSubject?.resourceId === file.id) {
    chat.setComposerSubject(null)
  }
}

export interface FilePreviewContext {
  projectId?: string
  projectName?: string
  canManage?: boolean
  scope?: DocumentScope
  canCollaborate?: boolean
  showMetadataPanel?: boolean
  onRenamed?: (fileId: string, displayName: string | null) => void
  onDeleted?: (fileId: string) => void
  onReingested?: (fileId: string, status: string) => void
  onTagsUpdated?: (fileId: string, tags: string[]) => void
}

interface FilePreviewState {
  file: FileItem | null
  mode: FilePreviewMode
  /** Peek dismissed; the conversation still knows the file. */
  hidden: boolean
  peekWidth: number
  context: FilePreviewContext
  open: (file: FileItem, mode: FilePreviewMode, context?: FilePreviewContext) => void
  peek: () => void
  expand: () => void
  hide: () => void
  close: () => void
  setPeekWidth: (width: number) => void
  patchFile: (patch: Partial<FileItem>) => void
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  file: null,
  mode: 'modal',
  hidden: false,
  peekWidth: FILE_PEEK_WIDTH_DEFAULT,
  context: {},

  open: (file, mode, context) =>
    set({
      file,
      mode,
      hidden: false,
      context: { ...get().context, ...context },
    }),

  peek: () => {
    if (!get().file) return
    set({ mode: 'peek', hidden: false })
  },

  expand: () => {
    if (!get().file) return
    set({ mode: 'expanded', hidden: false })
  },

  hide: () => {
    set({ hidden: true, mode: get().mode === 'modal' ? 'modal' : 'peek' })
    // Do not clear composerSubject here. Peek-bound subjects are dropped by
    // `openFilePeek`'s subscriber. Ask-Piloti subjects are user intent: hiding
    // the preview must leave the pill so the user can restore or dismiss it.
  },

  close: () => {
    const file = get().file
    set({ file: null, hidden: false, mode: 'modal' })
    clearMatchingComposerSubject(file)
  },

  setPeekWidth: (width) =>
    set({
      peekWidth: Math.min(FILE_PEEK_WIDTH_MAX, Math.max(FILE_PEEK_WIDTH_MIN, Math.round(width))),
    }),

  patchFile: (patch) => {
    const current = get().file
    if (!current) return
    set({ file: { ...current, ...patch } })
  },
}))

/**
 * The file that is currently open — one instance, three presentations.
 *
 * Files opens it as a modal. Chat keeps it as a resizable peek pane of the
 * file you are talking about. Expand uses the same pane as a dialog.
 *
 * close() drops composerSubject when it is this file. hide() does not —
 * the composer bar is the commitment, and "Show file" restores the peek.
 */

import { create } from 'zustand'
import { useChatStore } from '@/features/chat/store'
import type { DocumentScope } from '../components/document-actions'
import type { FileItem } from '../components/project-file-workspace'

export type FilePreviewMode = 'modal' | 'peek' | 'expanded'

/**
 * The peek's width is a SHARE OF THE ROW, not a pixel count.
 *
 * Pixels were the wrong unit twice over. A 560px ceiling is a third of a
 * 1600px display and most of a 900px laptop — the same drawing is "half the
 * screen" on one desk and a strip on the other — and a plan, a Schnitt or an
 * IFC viewport is read at the width the reader gives it, so the ceiling was
 * the complaint. Percentages of the split group travel: the pane keeps its
 * share when the window resizes, and `preserve-relative-size` on the panel is
 * what makes that true rather than a re-clamp on every resize.
 *
 * 75% is a real ceiling — the chat column still has to hold a message — and it
 * is more than double what the old 560px ever bought on a wide screen.
 */
export const FILE_PEEK_RATIO_MIN = 20
export const FILE_PEEK_RATIO_MAX = 75
export const FILE_PEEK_RATIO_DEFAULT = 38

/** Percentages the panel library accepts verbatim (`"38%"`), not bare numbers — those mean pixels. */
export function filePeekSize(ratio: number): string {
  return `${clampFilePeekRatio(ratio)}%`
}

/** Tenths of a percent: on a 1400px row that is ~1.4px, so the drag stays smooth. */
export function clampFilePeekRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return FILE_PEEK_RATIO_DEFAULT
  const bounded = Math.min(FILE_PEEK_RATIO_MAX, Math.max(FILE_PEEK_RATIO_MIN, ratio))
  return Math.round(bounded * 10) / 10
}

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
  /** Share of the split group the peek occupies, in percent (see the constants above). */
  peekRatio: number
  context: FilePreviewContext
  open: (file: FileItem, mode: FilePreviewMode, context?: FilePreviewContext) => void
  peek: () => void
  expand: () => void
  hide: () => void
  close: () => void
  setPeekRatio: (ratio: number) => void
  patchFile: (patch: Partial<FileItem>) => void
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  file: null,
  mode: 'modal',
  hidden: false,
  peekRatio: FILE_PEEK_RATIO_DEFAULT,
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
    // The composer bar stays. Hiding is "put the viewer away", not "stop
    // asking about this file". X on the bar (or close()) drops the subject.
  },

  close: () => {
    const file = get().file
    set({ file: null, hidden: false, mode: 'modal' })
    clearMatchingComposerSubject(file)
  },

  setPeekRatio: (ratio) => set({ peekRatio: clampFilePeekRatio(ratio) }),

  patchFile: (patch) => {
    const current = get().file
    if (!current) return
    set({ file: { ...current, ...patch } })
  },
}))

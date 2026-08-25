/**
 * The file that is currently open — one instance, three presentations.
 *
 * Files opens it as a modal. Chat keeps it as a resizable peek pane of the
 * file you are talking about. Expand uses the same pane as a dialog.
 *
 * The peek width is the reader's, so it outlives the session: `setPeekWidth`
 * writes it to localStorage and `restorePeekWidth` adopts it on the next mount.
 * It is committed once per drag (see `FilePreviewSplit`), never per frame.
 *
 * close() drops composerSubject when it is this file. hide() does not —
 * the composer bar is the commitment, and "Show file" restores the peek.
 */

import { create } from 'zustand'
import { useChatStore } from '@/features/chat/store'
import type { DocumentScope } from '../components/document-actions'
import type { FileItem } from '../components/project-file-workspace'

export type FilePreviewMode = 'modal' | 'peek' | 'expanded'

export const FILE_PEEK_WIDTH_MIN = 280
/**
 * The ceiling was 560px, which is narrower than an A3 plan at any readable
 * zoom: the reader dragged the seam out, hit a wall a third of the way across
 * a 1600px window, and the pane stopped being something they could size to the
 * document. The chat column keeps its own floor (the chat panel's `minSize` is
 * 40% of the split), so on a small window that constraint still binds first —
 * this only lifts the cap on the displays where there was room all along.
 */
export const FILE_PEEK_WIDTH_MAX = 960
export const FILE_PEEK_WIDTH_DEFAULT = 320

/** Where the dragged width is remembered between sessions. */
export const FILE_PEEK_WIDTH_STORAGE_KEY = 'grid.filePeek.width'

export function clampPeekWidth(width: number): number {
  return Math.min(FILE_PEEK_WIDTH_MAX, Math.max(FILE_PEEK_WIDTH_MIN, Math.round(width)))
}

/**
 * The remembered width, or null when there is none / it is not a usable number.
 *
 * Read on mount rather than in the store's initializer: the initializer runs on
 * the server too, and a client-only value there would make the first client
 * render disagree with the SSR markup it is hydrating.
 */
export function readStoredPeekWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(FILE_PEEK_WIDTH_STORAGE_KEY)
    // `Number('')` is 0, which would come back as the minimum width rather than
    // as "nothing stored".
    if (stored === null || stored.trim() === '') return null
    const parsed = Number(stored)
    return Number.isFinite(parsed) ? clampPeekWidth(parsed) : null
  } catch {
    // Storage unavailable (privacy mode) — fail soft to the default.
    return null
  }
}

function persistPeekWidth(width: number): void {
  try {
    window.localStorage.setItem(FILE_PEEK_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Storage unavailable — the width still holds for this session.
  }
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
  /**
   * The file is being CARRIED from one route to the other — Ask Piloti, which
   * turns a modal on Files into a peek beside a chat that has not loaded yet.
   *
   * Without it the viewer vanished at the click: `askAboutFile` sets `peek`
   * and then navigates, and a `peek` on Files belongs nowhere, so the pane
   * parked itself and the reader watched their document disappear, looked at
   * the file grid for as long as the router took, and then found it again on
   * the right of a chat. Nothing was broken and every frame was wrong.
   *
   * Intent is why this is a flag rather than something derived: "the file is
   * following me to the conversation" and "I walked away from it to another
   * section" produce the identical store state, and only the caller that is
   * about to navigate knows which one is happening.
   */
  handoff: boolean
  peekWidth: number
  context: FilePreviewContext
  open: (file: FileItem, mode: FilePreviewMode, context?: FilePreviewContext) => void
  peek: () => void
  expand: () => void
  hide: () => void
  close: () => void
  /** Set and remember the peek width, clamped to the bounds. */
  /** Hold the current presentation until the destination route arrives. */
  beginHandoff: () => void
  endHandoff: () => void
  setPeekWidth: (width: number) => void
  /**
   * Adopt the width remembered from a previous session, if there is one, and
   * return it so the caller can size the panel in the same commit.
   */
  restorePeekWidth: () => number | null
  patchFile: (patch: Partial<FileItem>) => void
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  file: null,
  mode: 'modal',
  hidden: false,
  handoff: false,
  peekWidth: FILE_PEEK_WIDTH_DEFAULT,
  context: {},

  open: (file, mode, context) =>
    set({
      file,
      mode,
      hidden: false,
      context: { ...get().context, ...context },
    }),

  beginHandoff: () => {
    if (get().file) set({ handoff: true })
  },

  endHandoff: () => set({ handoff: false }),

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
    set({ file: null, hidden: false, mode: 'modal', handoff: false })
    clearMatchingComposerSubject(file)
  },

  setPeekWidth: (width) => {
    const next = clampPeekWidth(width)
    set({ peekWidth: next })
    persistPeekWidth(next)
  },

  restorePeekWidth: () => {
    const stored = readStoredPeekWidth()
    if (stored === null) return null
    set({ peekWidth: stored })
    return stored
  },

  patchFile: (patch) => {
    const current = get().file
    if (!current) return
    set({ file: { ...current, ...patch } })
  },
}))

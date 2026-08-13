/**
 * Open a stored file as the chat peek and, optionally, bind it as the
 * composer's retrieval subject.
 *
 * Retrieval follows the visible peek (`use-websocket-chat`). When this helper
 * SETS composerSubject it is only for that visible window — hide/close of
 * THIS peek drops the subject. The preview store also clears a matching
 * subject on hide/close, so Ask-Piloti (`?doc=`) cannot leave a silent
 * focus after the user dismisses the file.
 *
 * See `file-preview-store` hide/close and `messages-store` setComposerSubject.
 */

import { useChatStore } from '@/features/chat/store'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem } from '../components/project-file-workspace'
import { useFilePreviewStore } from '../stores/file-preview-store'

/** Resource id of the subject this helper last bound to a peek, or null. */
let boundSubjectId: string | null = null
let unsubscribe: (() => void) | null = null

const clearBoundSubject = (): void => {
  if (!boundSubjectId) return
  const subject = useChatStore.getState().composerSubject
  if (subject?.resourceId === boundSubjectId) {
    useChatStore.getState().setComposerSubject(null)
  }
  boundSubjectId = null
}

const ensureHideClearsSubject = (): void => {
  if (unsubscribe) return
  unsubscribe = useFilePreviewStore.subscribe((state, previous) => {
    if (!boundSubjectId) return
    const hid = !previous.hidden && state.hidden
    const closed = previous.file != null && state.file == null
    if (hid || closed) clearBoundSubject()
  })
}

export interface OpenFilePeekOptions {
  file: FileItem
  source: 'projekt' | 'buero' | null
  projectId?: string | null
  projectName?: string | null
  canCollaborate?: boolean
  /**
   * Bind composerSubject to this file for retrieval focus while the peek is
   * visible. Default true. Hide/close of this peek clears that subject.
   * Pass false only when the caller already owns the subject (Ask Piloti).
   */
  bindComposerSubject?: boolean
}

/** Open `file` as a chat peek. Bind/clear of composerSubject is the default. */
export function openFilePeek(options: OpenFilePeekOptions): void {
  const bind = options.bindComposerSubject !== false
  ensureHideClearsSubject()

  useFilePreviewStore.getState().open(options.file, 'peek', {
    projectId: options.source === 'projekt' ? (options.projectId ?? undefined) : undefined,
    projectName: options.projectName ?? undefined,
    scope: options.source === 'buero' ? 'archiv' : 'files',
    canManage: false,
    canCollaborate: options.canCollaborate,
  })

  if (!bind) return

  boundSubjectId = options.file.id
  useChatStore.getState().setComposerSubject({
    resourceType: 'document',
    resourceId: options.file.id,
    title: documentDisplayName(options.file),
    filename: options.file.filename,
  })
}

/** Test hook — drop the hide/close subscription and any bound subject. */
export const resetFilePeekBinding = (): void => {
  boundSubjectId = null
  unsubscribe?.()
  unsubscribe = null
}

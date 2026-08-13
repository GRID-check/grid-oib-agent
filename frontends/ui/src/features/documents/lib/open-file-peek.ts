/**
 * Open a stored file as the chat peek and, optionally, bind it as the
 * composer's retrieval subject.
 *
 * The composer bar is the commitment ("Asking about this file"). Opening a
 * peek binds that subject. Hiding the peek keeps the bar — Show file brings
 * the viewer back; the X on the bar (or close()) is what drops the subject.
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

const ensureCloseClearsSubject = (): void => {
  if (unsubscribe) return
  unsubscribe = useFilePreviewStore.subscribe((state, previous) => {
    if (!boundSubjectId) return
    const closed = previous.file != null && state.file == null
    if (closed) clearBoundSubject()
  })
}

export interface OpenFilePeekOptions {
  file: FileItem
  source: 'projekt' | 'buero' | null
  projectId?: string | null
  projectName?: string | null
  canCollaborate?: boolean
  /**
   * Bind composerSubject to this file so the composer bar says what the
   * next send is about. Default true. Close (not hide) of this peek clears
   * that subject. Pass false only when the caller already owns the subject.
   */
  bindComposerSubject?: boolean
}

/** Open `file` as a chat peek. Bind/clear of composerSubject is the default. */
export function openFilePeek(options: OpenFilePeekOptions): void {
  const bind = options.bindComposerSubject !== false
  ensureCloseClearsSubject()

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

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

import { toast } from 'sonner'
import { useChatStore } from '@/features/chat/store'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { FileItem } from '../components/project-file-workspace'
import { useFilePreviewStore, type FilePreviewMode } from '../stores/file-preview-store'

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
  source: 'projekt' | 'buero' | 'session' | null
  projectId?: string | null
  projectName?: string | null
  canCollaborate?: boolean
  /**
   * Bind composerSubject to this file so the composer bar says what the
   * next send is about. Default true. Close (not hide) of this peek clears
   * that subject. Pass false only when the caller already owns the subject.
   */
  bindComposerSubject?: boolean
  /**
   * How the document is presented. `peek` — the split pane beside the
   * conversation — is what this helper is for and the default.
   *
   * `modal` exists for the one case where the pane is not available: on a
   * narrow screen `FilePreviewHost` refuses to peek (there is no room for two
   * panes), and a caller that opened one there would have done nothing at all.
   * The shelf/scope mapping below is the same either way, which is the reason
   * this is a parameter rather than a second call site with its own copy of it.
   */
  presentation?: FilePreviewMode
}

/** Open `file` as a chat peek. Bind/clear of composerSubject is the default. */
export function openFilePeek(options: OpenFilePeekOptions): void {
  const bind = options.bindComposerSubject !== false
  ensureCloseClearsSubject()

  useFilePreviewStore.getState().open(options.file, options.presentation ?? 'peek', {
    projectId: options.source === 'projekt' ? (options.projectId ?? undefined) : undefined,
    projectName: options.projectName ?? undefined,
    scope: options.source === 'buero' ? 'archiv' : 'files',
    canManage: false,
    canCollaborate: options.canCollaborate,
  })

  if (!bind) return

  boundSubjectId = options.file.id
  const shelf =
    options.source === 'buero' ? 'archiv' : options.source === 'session' ? 'session' : options.source === 'projekt' ? 'project' : undefined
  useChatStore.getState().setComposerSubject({
    resourceType: 'document',
    resourceId: options.file.id,
    title: documentDisplayName(options.file),
    filename: options.file.filename,
    ...(shelf ? { shelf } : {}),
  })
}

/**
 * Stop asking about the open file — and hand back the way to undo it.
 *
 * The ✕ on the composer's "Asking about …" bar is the only control in this
 * flow that ENDS things rather than putting them away: it drops the retrieval
 * subject and closes the viewer together, and the way back used to be
 * remembering which document it had been and finding it again in Dateien.
 * Everything it destroys is in memory at the moment it is pressed, so the undo
 * is a snapshot and two setters.
 *
 * It lives here because this module already owns the other half of the
 * relationship — `openFilePeek` is what BINDS a subject to a peek, and the
 * rule that close (not hide) clears it is stated at the top of this file.
 */
export function dropFileSubject(labels: { cleared: string; undo: string }): void {
  const preview = useFilePreviewStore.getState()
  const previous = {
    file: preview.file,
    mode: preview.mode,
    context: preview.context,
    subject: useChatStore.getState().composerSubject,
  }

  useChatStore.getState().setComposerSubject(null)
  preview.close()

  toast(labels.cleared, {
    action: {
      label: labels.undo,
      onClick: () => {
        if (previous.file) {
          useFilePreviewStore.getState().open(previous.file, previous.mode, previous.context)
        }
        if (previous.subject) useChatStore.getState().setComposerSubject(previous.subject)
      },
    },
  })
}

/** Test hook — drop the hide/close subscription and any bound subject. */
export const resetFilePeekBinding = (): void => {
  boundSubjectId = null
  unsubscribe?.()
  unsubscribe = null
}

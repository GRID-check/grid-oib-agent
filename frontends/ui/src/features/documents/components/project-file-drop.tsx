'use client'

/**
 * A file dropped anywhere in a project lands in its Dateien.
 *
 * Only Dateien took a drop. Everywhere else in the project, Einstellungen
 * included, a file let go over the page did nothing, or the browser opened it
 * in place of the app, because the window guard was mounted only by the file
 * workspaces. This wraps every project page: it guards the window, and a drop
 * no inner zone claimed opens Dateien, which uploads it through its own path
 * (`dropped-file-handover`).
 *
 * The sections that answer a drop themselves are left to it, a drop beside
 * their zone included: the chat attaches to the conversation, research to its
 * run, the intake binds to a slot, and Dateien is the destination already.
 * Taking a near miss there to another page would lose what the reader was in
 * the middle of. Inner zones built on `useFileDragDrop` stop the event, so they
 * win wherever this one is active.
 */

import type { ReactNode } from 'react'
import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from '@/i18n'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { handOverDroppedFiles } from '../lib/dropped-file-handover'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'

/** Project sections with a drop target of their own. */
const SECTIONS_WITH_OWN_DROP = new Set(['chat', 'files', 'intake', 'research'])

/** Whether a drop on this path is the project's to route to Dateien. */
export function routesDropToFiles(pathname: string, projectId: string): boolean {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'app' || parts[1] !== 'projects' || parts[2] !== projectId) return false
  return !SECTIONS_WITH_OWN_DROP.has(parts[3] ?? '')
}

export function ProjectFileDrop({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string
  /** No drop target at all: a closed project takes no files (ADR-0090). */
  disabled?: boolean
  children: ReactNode
}) {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const t = useTranslations('files')
  const active = !disabled && routesDropToFiles(pathname, projectId)

  const sendToFiles = useCallback(
    (files: File[]) => {
      handOverDroppedFiles(projectId, files)
      router.push(`/app/projects/${projectId}/files`)
    },
    [projectId, router]
  )
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: sendToFiles,
    disabled: !active,
    acceptZip: true,
  })
  useWindowDragGuard()

  // `contents`: no box of its own, so no page's layout changes under it, and
  // the same element on every path, so navigating never remounts the page. The
  // overlay is placed against the project's panel, which is positioned.
  return (
    <div className="contents" {...(active ? dragHandlers : {})} data-testid="project-file-drop">
      {active && isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('workspace.dropToUpload')}
          unsupportedLabel={t('workspace.dropUnsupported')}
          testId="project-drop-overlay"
        />
      )}
      {children}
    </div>
  )
}

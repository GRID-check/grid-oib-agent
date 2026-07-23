'use client'

import { useEffect, type ReactNode } from 'react'
import { useTranslations } from '@/i18n'
import type { FileItem } from './project-file-workspace'
import { FilePreviewPane } from './file-preview-pane'

interface FilePreviewDialogProps {
  /** The document to preview; `null` closes the dialog. */
  file: FileItem | null
  onClose: () => void
  projectId?: string
  projectName?: string
  canManage?: boolean
  onReingested?: (fileId: string, status: string) => void
  onTagsUpdated?: (fileId: string, tags: string[]) => void
  showMetadataPanel?: boolean
  /** Extra action controls (e.g. a Delete affordance) rendered in the pane. */
  extraActions?: ReactNode
}

/**
 * The ONE way a document preview opens across the app — a centered modal hosting
 * {@link FilePreviewPane}. Previously the Files workspace opened a centered modal
 * while the Archiv opened a docked side column, so the same file looked different
 * depending on where you clicked it. This unifies both onto one focused dialog:
 * a dimmed backdrop that closes on click or Escape, a panel capped at 920px with
 * the split preview, and full keyboard dismissal. Opening a file now looks and
 * behaves identically everywhere.
 */
export function FilePreviewDialog({
  file,
  onClose,
  projectId,
  projectName,
  canManage,
  onReingested,
  onTagsUpdated,
  showMetadataPanel,
  extraActions,
}: FilePreviewDialogProps) {
  const t = useTranslations('files')

  // Escape closes the dialog (a11y — the hand-rolled modal must honor Escape the
  // way a native dialog would).
  useEffect(() => {
    if (!file) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [file, onClose])

  if (!file) return null

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={t('preview.dialogLabel', { name: file.filename })}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 pt-[max(1rem,env(safe-area-inset-top))] md:p-10"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-[920px] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <FilePreviewPane
          file={file}
          projectId={projectId}
          projectName={projectName}
          canManage={canManage}
          onClose={onClose}
          onReingested={onReingested}
          onTagsUpdated={onTagsUpdated}
          showMetadataPanel={showMetadataPanel}
          extraActions={extraActions}
        />
      </div>
    </div>
  )
}

'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import type { FileItem } from './project-file-workspace'
import { Download, FileQuestion, RotateCcw, X } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button, buttonVariants } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { DocumentStatusBadge, fileTypeIcon } from './document-status'

interface FilePreviewPaneProps {
  file: FileItem
  projectId: string
  onClose?: () => void
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

export function FilePreviewPane({ file, projectId, onClose }: FilePreviewPaneProps) {
  const t = useTranslations('files')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '')
  const Icon = fileTypeIcon(file.contentType, file.filename)

  const loadPreview = useCallback(() => {
    setPreviewFailed(false)
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    fetch(`/api/documents/${file.id}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.url) setPreviewUrl(data.url)
        else setPreviewFailed(true)
      })
      .catch(() => {
        setPreviewUrl(null)
        setPreviewFailed(true)
      })
      .finally(() => setIsLoading(false))
  }, [file.id, canPreview])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h3 className="truncate text-sm font-semibold text-foreground">{file.filename}</h3>
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onClose} aria-label={t('preview.closePreview')}>
            <X className="size-4" />
          </Button>
        )}
      </div>

      {/* Preview */}
      <div className="flex-1 overflow-auto bg-muted/30">
        {canPreview && isLoading && (
          <div className="space-y-4 p-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {canPreview && !isLoading && previewUrl && (
          file.contentType === 'application/pdf' ? (
            <iframe src={previewUrl} className="h-full w-full" title={file.filename} />
          ) : (
            <img src={previewUrl} alt={file.filename} className="w-full object-contain" />
          )
        )}
        {canPreview && !isLoading && previewFailed && (
          <PreviewMessage
            message={t('preview.loadFailed')}
            action={
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={loadPreview}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('preview.tryAgain')}
              </Button>
            }
          />
        )}
        {!canPreview && (
          <PreviewMessage message={t('preview.noInlinePreview')} />
        )}
      </div>

      {/* Metadata */}
      <div className="space-y-2.5 border-t px-4 py-3">
        <MetaRow label={t('preview.status')}>
          <DocumentStatusBadge status={file.status} />
        </MetaRow>
        <MetaRow label={t('preview.type')}>
          <span className="font-mono text-xs text-foreground">{file.contentType ?? t('preview.unknownType')}</span>
        </MetaRow>
        <MetaRow label={t('preview.size')}>
          <span className="text-xs font-medium tabular-nums text-foreground">{formatFileSize(file.fileSize)}</span>
        </MetaRow>
      </div>

      {/* Actions */}
      <div className="border-t px-4 py-3">
        <a
          href={`/api/documents/${file.id}/download`}
          className={cn(buttonVariants({ variant: 'outline' }), 'w-full gap-2')}
        >
          <Download className="size-4" aria-hidden />
          {t('preview.download')}
        </a>
      </div>
    </div>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function PreviewMessage({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground text-balance">{message}</p>
      {action}
    </div>
  )
}

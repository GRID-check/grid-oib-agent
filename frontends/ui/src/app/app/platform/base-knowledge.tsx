'use client'

/**
 * Platform base-knowledge manager (ADR-0016) — the platform owner's corpus
 * explorer. Lists every base-corpus document with its live index state,
 * uploads new PDFs straight into the corpus (synchronous ingest), removes
 * uploaded documents, triggers a re-sync, and opens sources in the PDF viewer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertCircle, BookOpenCheck, Eye, FileText, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import type { KnowledgeBaseStatus, KnowledgeFile, KnowledgeFileState } from '@/lib/knowledge/service'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'

const STATE_VARIANT: Record<KnowledgeFileState, 'success' | 'info' | 'warning' | 'destructive' | 'secondary'> = {
  ingested: 'success',
  snapshot: 'success',
  pending: 'info',
  stale: 'warning',
  removed: 'secondary',
  inconsistent: 'destructive',
}

export function BaseKnowledge() {
  const t = useTranslations('platform')
  const tk = useTranslations('knowledge')
  const { locale } = useLocale()

  const [status, setStatus] = useState<KnowledgeBaseStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [query, setQuery] = useState('')
  const [isUploading, setIsUploading] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<KnowledgeFile | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [viewerFile, setViewerFile] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    return fetch('/api/knowledge-base')
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load knowledge base (${r.status})`)
        return r.json() as Promise<KnowledgeBaseStatus>
      })
      .then(setStatus)
      .catch(() => {
        setStatus(null)
        setHasError(true)
      })
      .finally(() => setIsLoading(false))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const files = useMemo(() => {
    const all = status?.files ?? []
    const needle = query.trim().toLowerCase()
    return needle ? all.filter((f) => f.fileName.toLowerCase().includes(needle)) : all
  }, [status, query])

  const handleUpload = useCallback(
    (file: File) => {
      setIsUploading(true)
      const form = new FormData()
      form.append('file', file)
      fetch('/api/platform/knowledge/documents', { method: 'POST', body: form })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}))
          if (r.ok && body.status === 'success') {
            toast.success(t('knowledge.uploadSuccess', { name: file.name }))
          } else if (body.status === 'timeout') {
            toast.info(t('knowledge.uploadTimeout', { name: file.name }))
          } else {
            toast.error(body.error ?? t('knowledge.uploadFailed', { name: file.name }))
          }
        })
        .catch(() => toast.error(t('knowledge.uploadFailed', { name: file.name })))
        .finally(() => {
          setIsUploading(false)
          void load()
        })
    },
    [load, t],
  )

  const handleSync = useCallback(() => {
    setIsSyncing(true)
    fetch('/api/platform/knowledge/sync', { method: 'POST' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Sync failed (${r.status})`)
        const body = await r.json()
        toast.success(t('knowledge.syncDone', { added: body.filesAdded ?? 0, total: body.filesTotal ?? 0 }))
      })
      .catch(() => toast.error(t('knowledge.syncFailed')))
      .finally(() => {
        setIsSyncing(false)
        void load()
      })
  }, [load, t])

  const handleDelete = useCallback(() => {
    if (!pendingDelete) return
    const name = pendingDelete.fileName
    setIsDeleting(true)
    fetch(`/api/platform/knowledge/documents/${encodeURIComponent(name)}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok) throw new Error(`Delete failed (${r.status})`)
        toast.success(t('knowledge.deleteSuccess', { name }))
      })
      .catch(() => toast.error(t('knowledge.deleteFailed', { name })))
      .finally(() => {
        setIsDeleting(false)
        setPendingDelete(null)
        void load()
      })
  }, [pendingDelete, load, t])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpenCheck className="size-4 text-muted-foreground" aria-hidden />
          {t('knowledge.title')}
        </CardTitle>
        <CardDescription>{t('knowledge.description')}</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing || isUploading}>
            {isSyncing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
            {isSyncing ? t('knowledge.syncing') : t('knowledge.sync')}
          </Button>
          <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={isUploading || isSyncing}>
            {isUploading ? <Spinner className="size-3.5" /> : <Upload className="size-3.5" aria-hidden />}
            {isUploading ? t('knowledge.uploading') : t('knowledge.upload')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            data-testid="knowledge-upload-input"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) handleUpload(file)
            }}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading && <Skeleton className="h-48 w-full rounded-xl" data-testid="knowledge-admin-loading" />}

        {!isLoading && hasError && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>{t('knowledge.loadError')}</AlertTitle>
            <AlertDescription>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('knowledge.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!isLoading && !hasError && status && (
          <>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('knowledge.search')}
              aria-label={t('knowledge.search')}
            />
            {files.length === 0 ? (
              <EmptyState variant="bare" icon={FileText} title={t('knowledge.empty')} />
            ) : (
              <div className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {files.map((file) => (
                  <div key={file.fileName} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {file.chunkCount > 0 ? tk('corpus.chunkCount', { count: file.chunkCount }) : '—'}
                          {file.sizeBytes !== null ? ` · ${formatFileSize(file.sizeBytes, locale)}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {file.origin === 'uploaded' && <Badge variant="outline">{tk('origin.uploaded')}</Badge>}
                      <Badge variant={STATE_VARIANT[file.state]} title={tk(`stateHints.${file.state}`)}>
                        {tk(`states.${file.state}`)}
                      </Badge>
                      {file.origin !== 'index_only' && (
                        <Button
                          variant="ghost"
                          size="icon" className="size-8"
                          aria-label={`${tk('viewer.view')}: ${file.fileName}`}
                          onClick={() => setViewerFile(file.fileName)}
                        >
                          <Eye className="size-4" aria-hidden />
                        </Button>
                      )}
                      {file.origin === 'uploaded' && (
                        <Button
                          variant="ghost"
                          size="icon" className="size-8"
                          aria-label={`${t('knowledge.delete')}: ${file.fileName}`}
                          onClick={() => setPendingDelete(file)}
                        >
                          <Trash2 className="size-4 text-destructive" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>

      {viewerFile && (
        <PdfViewerDialog open onOpenChange={(open) => !open && setViewerFile(null)} fileName={viewerFile} />
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && !isDeleting && setPendingDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('knowledge.deleteTitle', { name: pendingDelete?.fileName ?? '' })}</DialogTitle>
            <DialogDescription>{t('knowledge.deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={isDeleting}>
              {t('knowledge.deleteCancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" aria-hidden />}
              {t('knowledge.deleteConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

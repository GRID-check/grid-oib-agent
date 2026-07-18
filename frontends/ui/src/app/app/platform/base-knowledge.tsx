'use client'

/**
 * Platform base-knowledge manager (ADR-0016, Phase C) — the base-corpus manager
 * built for a NON-TECHNICAL owner. Plain-language framing, a drag-and-drop
 * PDF/ZIP upload that reports background progress instead of a silent spinner,
 * a clear split between the binding OIB foundations and other base documents,
 * and — the core capability — an inline Dokumentart (document-type) dropdown on
 * every row so a human can confirm or correct "what this document is".
 *
 * The backend ingests uploads in the background, so an upload returns promptly
 * (`pending`); we then poll the corpus status until the new file(s) reach a
 * terminal lifecycle, so they appear and progress from pending → indexed with
 * no page reload.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertCircle,
  BookOpenCheck,
  Eye,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import type { KnowledgeBaseStatus, KnowledgeFile, KnowledgeFileState } from '@/lib/knowledge/service'
import type { KnowledgeUploadResult } from '@/lib/knowledge/service'
import {
  DOC_CLASSES,
  DOC_CLASS_LABELS,
  docClassAuthority,
  docClassSignal,
  isOibBinding,
  resolveDocClass,
  type DocClass,
} from '@/lib/knowledge/doc-class'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'

const STATE_VARIANT: Record<KnowledgeFileState, 'success' | 'info' | 'warning' | 'destructive' | 'secondary'> = {
  ingested: 'success',
  snapshot: 'success',
  pending: 'info',
  stale: 'warning',
  removed: 'secondary',
  inconsistent: 'destructive',
}

// Poll cadence + ceiling while a freshly-uploaded document ingests in the
// background. 3.5s × 60 ≈ 3.5 minutes, then we stop and let the owner refresh.
const POLL_INTERVAL_MS = 3_500
const MAX_POLLS = 60

/** A watched file is still working while it is missing or explicitly pending. */
function isWorking(status: KnowledgeBaseStatus | null, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false
  const byName = new Map((status?.files ?? []).map((f) => [f.fileName, f]))
  for (const name of names) {
    const file = byName.get(name)
    if (!file || file.state === 'pending') return true
  }
  return false
}

export function BaseKnowledge() {
  const t = useTranslations('platform')
  const tk = useTranslations('knowledge')
  const { locale } = useLocale()

  const [status, setStatus] = useState<KnowledgeBaseStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [query, setQuery] = useState('')
  const [classFilter, setClassFilter] = useState<DocClass | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [lastUpload, setLastUpload] = useState<KnowledgeUploadResult | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isDragActive, setIsDragActive] = useState(false)
  // Optimistic doc_class edits, applied over the fetched status until a refetch
  // confirms them (keyed by filename).
  const [docClassOverrides, setDocClassOverrides] = useState<Record<string, DocClass>>({})
  const [pendingDelete, setPendingDelete] = useState<KnowledgeFile | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [viewerFile, setViewerFile] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchRef = useRef<Set<string>>(new Set())

  const fetchStatus = useCallback(async (): Promise<KnowledgeBaseStatus> => {
    const res = await fetch('/api/knowledge-base')
    if (!res.ok) throw new Error(`Failed to load knowledge base (${res.status})`)
    return (await res.json()) as KnowledgeBaseStatus
  }, [])

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    return fetchStatus()
      .then((next) => {
        setStatus(next)
        // Drop any optimistic override the backend now agrees with.
        setDocClassOverrides((prev) => {
          if (Object.keys(prev).length === 0) return prev
          const remaining: Record<string, DocClass> = {}
          const byName = new Map(next.files.map((f) => [f.fileName, f]))
          for (const [name, cls] of Object.entries(prev)) {
            if (byName.get(name)?.docClass !== cls) remaining[name] = cls
          }
          return remaining
        })
      })
      .catch(() => {
        setStatus(null)
        setHasError(true)
      })
      .finally(() => setIsLoading(false))
  }, [fetchStatus])

  useEffect(() => {
    void load()
  }, [load])

  // Tear down any in-flight poll timer on unmount.
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
    }
  }, [])

  // Poll the corpus status until the watched uploads reach a terminal state.
  const startPolling = useCallback(
    (names: string[]) => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      watchRef.current = new Set(names)
      if (watchRef.current.size === 0) return
      setIsProcessing(true)

      let polls = 0
      const tick = async () => {
        polls += 1
        let next: KnowledgeBaseStatus | null = null
        try {
          next = await fetchStatus()
          setStatus(next)
        } catch {
          // Transient fetch failure — keep trying until the poll ceiling.
        }
        if (!isWorking(next, watchRef.current) || polls >= MAX_POLLS) {
          watchRef.current = new Set()
          pollTimerRef.current = null
          setIsProcessing(false)
          return
        }
        pollTimerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
      }
      pollTimerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
    },
    [fetchStatus],
  )

  const handleUpload = useCallback(
    (file: File) => {
      setIsUploading(true)
      setLastUpload(null)
      const form = new FormData()
      form.append('file', file)
      fetch('/api/platform/knowledge/documents', { method: 'POST', body: form })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as Partial<KnowledgeUploadResult> & { error?: string }
          if (!r.ok || (body.status !== 'pending' && body.status !== 'success')) {
            toast.error(body.error ?? t('knowledge.uploadFailed', { name: file.name }))
            return
          }
          setLastUpload(body as KnowledgeUploadResult)
          if (body.kind === 'zip') {
            toast.success(
              t('knowledge.zipQueued', { accepted: body.accepted ?? 0, rejected: body.rejected ?? 0 }),
            )
          } else {
            toast.success(t('knowledge.uploadPending', { name: body.fileName ?? file.name }))
          }
          // Watch the accepted member(s) and poll until they finish indexing.
          const watched =
            body.kind === 'zip'
              ? (body.members ?? []).filter((m) => m.status === 'pending').map((m) => m.fileName)
              : body.fileName
                ? [body.fileName]
                : []
          await load()
          startPolling(watched)
        })
        .catch(() => toast.error(t('knowledge.uploadFailed', { name: file.name })))
        .finally(() => setIsUploading(false))
    },
    [load, startPolling, t],
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

  const handleReclassify = useCallback(
    (file: KnowledgeFile, nextClass: DocClass) => {
      const current = resolveDocClass(file.docClass)
      if (nextClass === current) return
      // Optimistic: reflect the new class immediately, revert on failure.
      setDocClassOverrides((prev) => ({ ...prev, [file.fileName]: nextClass }))
      fetch(`/api/platform/knowledge/documents/${encodeURIComponent(file.fileName)}/doc-class`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_class: nextClass }),
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(`Reclassify failed (${r.status})`)
          toast.success(
            t('knowledge.docClassUpdated', { name: file.fileName, label: DOC_CLASS_LABELS[nextClass] }),
          )
          await load()
        })
        .catch(() => {
          setDocClassOverrides((prev) => {
            const next = { ...prev }
            delete next[file.fileName]
            return next
          })
          toast.error(t('knowledge.docClassUpdateFailed', { name: file.fileName }))
        })
    },
    [load, t],
  )

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

  // Files with any optimistic doc_class edit applied.
  const files = useMemo<KnowledgeFile[]>(() => {
    const all = status?.files ?? []
    if (Object.keys(docClassOverrides).length === 0) return all
    return all.map((f) =>
      docClassOverrides[f.fileName] ? { ...f, docClass: docClassOverrides[f.fileName] } : f,
    )
  }, [status, docClassOverrides])

  // Dokumentart filter chips — the classes actually present, in canonical order
  // (OIB foundations first), each with a live count. Nothing invented.
  const presentClasses = useMemo(() => {
    const counts = new Map<DocClass, number>()
    for (const f of files) {
      const cls = resolveDocClass(f.docClass)
      counts.set(cls, (counts.get(cls) ?? 0) + 1)
    }
    return DOC_CLASSES.filter((cls) => counts.has(cls)).map((cls) => ({ cls, count: counts.get(cls)! }))
  }, [files])

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return files.filter((f) => {
      if (classFilter && resolveDocClass(f.docClass) !== classFilter) return false
      if (needle && !f.fileName.toLowerCase().includes(needle)) return false
      return true
    })
  }, [files, query, classFilter])

  const bindingFiles = useMemo(() => visibleFiles.filter((f) => isOibBinding(f.docClass)), [visibleFiles])
  const otherFiles = useMemo(() => visibleFiles.filter((f) => !isOibBinding(f.docClass)), [visibleFiles])

  const renderRow = (file: KnowledgeFile) => {
    const cls = resolveDocClass(file.docClass)
    const authority = docClassAuthority(cls)
    return (
      <div key={file.fileName} className="flex flex-col gap-2.5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <SourceSignalChip
                signal={docClassSignal(cls)}
                title={authority ? `${DOC_CLASS_LABELS[cls]} · ${authority}` : DOC_CLASS_LABELS[cls]}
              >
                {DOC_CLASS_LABELS[cls]}
                {authority ? ` · ${authority}` : ''}
              </SourceSignalChip>
              {file.origin === 'uploaded' && <Badge variant="outline">{tk('origin.uploaded')}</Badge>}
              <Badge variant={STATE_VARIANT[file.state]} title={tk(`stateHints.${file.state}`)}>
                {tk(`states.${file.state}`)}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {file.chunkCount > 0 ? tk('corpus.chunkCount', { count: file.chunkCount }) : '—'}
              {file.sizeBytes !== null ? ` · ${formatFileSize(file.sizeBytes, locale)}` : ''}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:pl-3">
          <Select value={cls} onValueChange={(value) => handleReclassify(file, value as DocClass)}>
            <SelectTrigger
              size="sm"
              className="w-[13.5rem]"
              aria-label={t('knowledge.docClassFor', { name: file.fileName })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOC_CLASSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {DOC_CLASS_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {file.origin !== 'index_only' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`${t('knowledge.viewPdf')}: ${file.fileName}`}
              onClick={() => setViewerFile(file.fileName)}
            >
              <Eye className="size-4" aria-hidden />
            </Button>
          )}
          {file.origin === 'uploaded' && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`${t('knowledge.delete')}: ${file.fileName}`}
              onClick={() => setPendingDelete(file)}
            >
              <Trash2 className="size-4 text-destructive" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    )
  }

  const renderSection = (
    titleKey: 'bindingTitle' | 'otherTitle',
    hintKey: 'bindingHint' | 'otherHint',
    sectionFiles: KnowledgeFile[],
  ) => (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-foreground">
          {t(`knowledge.${titleKey}`)}
          <span className="ml-1.5 font-normal text-muted-foreground">({sectionFiles.length})</span>
        </h3>
        <p className="text-xs text-muted-foreground">{t(`knowledge.${hintKey}`)}</p>
      </div>
      {sectionFiles.length > 0 ? (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {sectionFiles.map(renderRow)}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {t('knowledge.empty')}
        </p>
      )}
    </section>
  )

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragActive(false)
    if (isUploading || isSyncing) return
    const file = event.dataTransfer.files?.[0]
    if (file) handleUpload(file)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpenCheck className="size-4 text-muted-foreground" aria-hidden />
          {t('knowledge.title')}
        </CardTitle>
        <CardDescription>{t('knowledge.explainer')}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing || isUploading}>
            {isSyncing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
            {isSyncing ? t('knowledge.syncing') : t('knowledge.sync')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Drag-and-drop upload zone (PDF + ZIP). */}
        <div
          role="button"
          tabIndex={0}
          aria-label={t('knowledge.dropTitle')}
          aria-disabled={isUploading || isSyncing}
          onClick={() => !isUploading && !isSyncing && fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if ((event.key === 'Enter' || event.key === ' ') && !isUploading && !isSyncing) {
              event.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          onDragOver={(event) => {
            event.preventDefault()
            if (!isUploading && !isSyncing) setIsDragActive(true)
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={onDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
            isDragActive ? 'border-primary bg-accent' : 'border-border hover:border-primary/60 hover:bg-accent/40',
            (isUploading || isSyncing) && 'pointer-events-none opacity-60',
          )}
          data-testid="knowledge-dropzone"
        >
          {isUploading ? (
            <Spinner className="size-5 text-muted-foreground" />
          ) : (
            <Upload className="size-5 text-muted-foreground" aria-hidden />
          )}
          <p className="text-sm font-medium text-foreground">
            {isUploading ? t('knowledge.uploading') : isDragActive ? t('knowledge.dropActive') : t('knowledge.dropTitle')}
          </p>
          <p className="text-xs text-muted-foreground">{t('knowledge.dropHint')}</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.zip,application/zip,application/pdf"
            className="hidden"
            data-testid="knowledge-upload-input"
            // The input lives inside the click-to-upload zone; without this its
            // own (programmatic) click would bubble to the zone and re-open it
            // in an infinite loop.
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) handleUpload(file)
            }}
          />
        </div>

        {/* Background-processing banner — makes waiting obvious and safe. */}
        {isProcessing && (
          <Alert>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <AlertTitle>{t('knowledge.processing')}</AlertTitle>
            <AlertDescription>{t('knowledge.processingHint')}</AlertDescription>
          </Alert>
        )}

        {/* ZIP member summary (accepted / rejected). */}
        {lastUpload?.kind === 'zip' && (lastUpload.rejected ?? 0) > 0 && lastUpload.members && (
          <Alert variant="warning">
            <AlertCircle className="size-4" aria-hidden />
            <AlertTitle>{t('knowledge.zipRejectedTitle')}</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {lastUpload.members
                  .filter((m) => m.status === 'rejected')
                  .map((m) => (
                    <li key={m.fileName}>
                      <span className="font-medium">{m.fileName}</span>
                      {m.reason ? ` — ${m.reason}` : ''}
                    </li>
                  ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

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

            {/* Dokumentart filter chips. */}
            {presentClasses.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label={t('knowledge.docClassLabel')}
              >
                <FilterChip
                  label={t('knowledge.docClassFilterAll')}
                  active={classFilter === null}
                  onClick={() => setClassFilter(null)}
                />
                {presentClasses.map(({ cls, count }) => (
                  <FilterChip
                    key={cls}
                    label={`${DOC_CLASS_LABELS[cls]} (${count})`}
                    active={classFilter === cls}
                    onClick={() => setClassFilter((current) => (current === cls ? null : cls))}
                  />
                ))}
              </div>
            )}

            {status.files.length === 0 ? (
              <EmptyState variant="bare" icon={FileText} title={t('knowledge.empty')} />
            ) : visibleFiles.length === 0 ? (
              <EmptyState
                variant="bare"
                icon={FileText}
                title={t('knowledge.noMatch')}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery('')
                      setClassFilter(null)
                    }}
                  >
                    {t('knowledge.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <div className="flex flex-col gap-5">
                {renderSection('bindingTitle', 'bindingHint', bindingFiles)}
                {renderSection('otherTitle', 'otherHint', otherFiles)}
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

/** A quiet, toggleable Dokumentart filter chip (mirrors the Archiv pattern). */
function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md border px-3 text-[0.78125rem] transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        active
          ? 'border-border bg-card font-medium text-foreground shadow-xs'
          : 'border-border/50 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}

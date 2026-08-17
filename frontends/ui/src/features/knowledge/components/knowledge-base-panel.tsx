'use client'

/**
 * Knowledge-base transparency panel — shows the user exactly what the RAG
 * knows: every document of the shared OIB Richtlinien corpus with its live
 * index state (indexed / outdated / pending / removed / inconsistent), plus
 * the project's own uploaded documents that join the retrieval scope.
 *
 * Data sources: `GET /api/knowledge-base` (base corpus, served by the
 * dedicated BFF service) and `GET /api/documents?projectId=…` (project docs).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Eye, FileSearch, FileText, FolderOpen, Layers, RotateCcw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DocumentStatusBadge, documentStatusVariant, fileTypeIcon } from '@/features/documents/components/document-status'
import { useLocale, useTranslations } from '@/i18n'
import type { KnowledgeBaseStatus, KnowledgeFile, KnowledgeFileState } from '@/lib/knowledge/service'
import { PdfViewerDialog } from './pdf-viewer-dialog'
import { formatBytes } from '@/lib/format'

interface ProjectDocument {
  id: string
  filename: string
  fileSize: number | null
  contentType: string | null
  status: string | null
  createdAt: string
}

interface KnowledgeBasePanelProps {
  projectId: string
}

/** Badge color per corpus state — success only when the RAG really knows it. */
const STATE_VARIANT: Record<KnowledgeFileState, 'success' | 'info' | 'warning' | 'destructive' | 'secondary'> = {
  ingested: 'success',
  snapshot: 'success',
  pending: 'info',
  stale: 'warning',
  removed: 'secondary',
  inconsistent: 'destructive',
}

function useDateFormatter(): (iso: string | null) => string {
  const { locale } = useLocale()
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    [locale],
  )
  return useCallback(
    (iso: string | null) => {
      if (!iso) return '—'
      const date = new Date(iso)
      return Number.isNaN(date.getTime()) ? '—' : formatter.format(date)
    },
    [formatter],
  )
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className={tone === 'warning' ? 'text-2xl font-semibold text-warning' : 'text-2xl font-semibold text-foreground'}>
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function CorpusRow({ file, onView }: { file: KnowledgeFile; onView: (fileName: string) => void }) {
  const t = useTranslations('knowledge')
  const { locale } = useLocale()
  const formatDate = useDateFormatter()
  const checksum = file.currentSha256 ?? file.ingestedSha256

  return (
    <div
      className="flex items-start justify-between gap-3 px-4 py-3 transition-colors duration-200 ease-out hover:bg-muted/40 sm:items-center sm:gap-4"
      title={checksum ? t('corpus.checksum', { hash: checksum }) : undefined}
    >
      <div className="flex min-w-0 items-start gap-3 sm:items-center">
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground sm:mt-0" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{file.fileName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {file.summary ?? t(`stateHints.${file.state}`)}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-4">
        <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
          {file.chunkCount > 0 ? t('corpus.chunkCount', { count: file.chunkCount }) : '—'}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground md:inline">
          {file.sizeBytes !== null ? formatBytes(file.sizeBytes, locale) : '—'}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground lg:inline">
          {formatDate(file.ingestedAt)}
        </span>
        <Badge variant={STATE_VARIANT[file.state]} title={t(`stateHints.${file.state}`)}>
          {t(`states.${file.state}`)}
        </Badge>
        {file.origin !== 'index_only' && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={`${t('viewer.view')}: ${file.fileName}`}
            onClick={() => onView(file.fileName)}
          >
            <Eye className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}

function ProjectDocumentRow({ doc }: { doc: ProjectDocument }) {
  const { locale } = useLocale()
  const formatDate = useDateFormatter()
  const Icon = fileTypeIcon(doc.contentType, doc.filename)

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-200 ease-out hover:bg-muted/40 sm:gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="truncate text-sm font-medium text-foreground">{doc.filename}</p>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <span className="hidden text-xs tabular-nums text-muted-foreground md:inline">
          {doc.fileSize !== null ? formatBytes(doc.fileSize, locale) : '—'}
        </span>
        <span className="hidden text-xs tabular-nums text-muted-foreground lg:inline">{formatDate(doc.createdAt)}</span>
        <DocumentStatusBadge status={doc.status} />
      </div>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3" data-testid="knowledge-loading">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  )
}

export function KnowledgeBasePanel({ projectId }: KnowledgeBasePanelProps) {
  const t = useTranslations('knowledge')
  const formatDate = useDateFormatter()

  const [status, setStatus] = useState<KnowledgeBaseStatus | null>(null)
  const [documents, setDocuments] = useState<ProjectDocument[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [viewerFile, setViewerFile] = useState<string | null>(null)

  const load = useCallback(() => {
    setIsLoading(true)
    setHasError(false)
    const corpusRequest = fetch('/api/knowledge-base').then((r) => {
      if (!r.ok) throw new Error(`Failed to load knowledge base (${r.status})`)
      return r.json() as Promise<KnowledgeBaseStatus>
    })
    // Project documents are complementary; their failure must not blank the
    // corpus view, so they resolve to an empty list instead of rejecting.
    const documentsRequest = fetch(`/api/documents?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : { documents: [] }))
      .then((data) => (data.documents ?? []) as ProjectDocument[])
      .catch(() => [] as ProjectDocument[])

    return Promise.all([corpusRequest, documentsRequest])
      .then(([corpus, docs]) => {
        setStatus(corpus)
        setDocuments(docs)
      })
      .catch(() => {
        setStatus(null)
        setHasError(true)
      })
      .finally(() => setIsLoading(false))
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const attention = status
    ? status.summary.pending + status.summary.stale + status.summary.removed + status.summary.inconsistent
    : 0
  // "Indexed" = everything the assistant can actually search: verified corpus
  // files, snapshot-restored corpus files, and successfully ingested project docs.
  const readyProjectDocs = documents.filter((doc) => documentStatusVariant(doc.status) === 'success').length
  const indexed = status ? status.summary.ingested + status.summary.snapshot + readyProjectDocs : 0

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:px-8">
      {isLoading && <LoadingSkeleton />}

      {!isLoading && hasError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('error.title')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            {t('error.description')}
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RotateCcw className="size-3.5" aria-hidden />
              {t('error.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !hasError && status && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={t('title')}>
            <SummaryTile label={t('summary.documents')} value={status.summary.totalFiles + documents.length} />
            <SummaryTile label={t('summary.indexed')} value={indexed} />
            <SummaryTile label={t('summary.chunks')} value={status.summary.totalChunks} />
            <SummaryTile label={t('summary.attention')} value={attention} tone={attention > 0 ? 'warning' : undefined} />
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="size-4 text-muted-foreground" aria-hidden />
                {t('corpus.title')}
              </CardTitle>
              <CardDescription>
                {t('corpus.description')}
                {status.collectionUpdatedAt && (
                  <> {t('summary.lastUpdated', { date: formatDate(status.collectionUpdatedAt) })}</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {status.files.length === 0 ? (
                <EmptyState
                  variant="bare"
                  icon={FileSearch}
                  title={status.collectionExists ? t('corpus.empty') : t('corpus.notSynced')}
                />
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {status.files.map((file) => (
                    <CorpusRow key={file.fileName} file={file} onView={setViewerFile} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="size-4 text-muted-foreground" aria-hidden />
                {t('project.title')}
              </CardTitle>
              <CardDescription>{t('project.description')}</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {documents.length === 0 ? (
                <EmptyState
                  variant="bare"
                  icon={FolderOpen}
                  title={t('project.empty')}
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/app/projects/${projectId}/files`}>{t('project.goToFiles')}</Link>
                    </Button>
                  }
                />
              ) : (
                <div className="divide-y divide-border border-t border-border">
                  {documents.map((doc) => (
                    <ProjectDocumentRow key={doc.id} doc={doc} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {viewerFile && (
        <PdfViewerDialog open onOpenChange={(open) => !open && setViewerFile(null)} fileName={viewerFile} />
      )}
    </div>
  )
}

'use client'

import { useState, type FC } from 'react'
import { FileWarning, FolderSearch } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale, useTranslations } from '@/i18n'
import { Skeleton } from '@/components/ui/skeleton'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { FileCard } from '@/features/documents/components/file-card'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import {
  useSurfacedDocuments,
  type ResolvedSurfacedDocument,
  type SurfacedDocument,
} from '@/features/documents/hooks/use-surfaced-documents'

interface DocumentGridCardProps {
  title: string
  query?: string | null
  documents: SurfacedDocument[]
  projectId?: string | null
}

/** PDF + images open in the inline viewer; every other type is a download. */
function isPreviewable(contentType: string | null | undefined): boolean {
  const ct = (contentType ?? '').toLowerCase()
  return ct === 'application/pdf' || ct.startsWith('image/')
}

/**
 * Open controller for a surfaced document. Project uploads and Büroarchiv files
 * both resolve through the scope-aware `/api/documents/{id}` routes. Previewable
 * types (PDF, images) open inline in the shared PdfViewerDialog; everything else
 * — the .docx/.xlsx/.dwg the user "worked on" — downloads via a presigned URL
 * instead of dead-ending on a toast. A failed presign surfaces as a toast, never
 * a broken viewer.
 */
function useSurfacedPreview() {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  const [src, setSrc] = useState<string | null>(null)
  const [active, setActive] = useState<FileItem | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const openPreview = async (file: FileItem): Promise<void> => {
    setResolvingId(file.id)
    try {
      if (isPreviewable(file.contentType)) {
        const res = await fetch(`/api/documents/${file.id}/preview`)
        const data = res.ok ? await res.json() : null
        if (data?.url) {
          setSrc(data.url)
          setActive(file)
          setOpen(true)
        } else {
          toast.error(t('documentGrid.loadFailed'))
        }
      } else {
        // Non-previewable (docx/xlsx/dwg/…): open the presigned download so the
        // click still does something useful rather than failing.
        const res = await fetch(`/api/documents/${file.id}/download`)
        const data = res.ok ? await res.json() : null
        if (data?.downloadUrl) {
          window.open(data.downloadUrl, '_blank', 'noopener,noreferrer')
        } else {
          toast.error(t('documentGrid.loadFailed'))
        }
      }
    } catch {
      toast.error(t('documentGrid.loadFailed'))
    } finally {
      setResolvingId(null)
    }
  }

  const isImage = (active?.contentType ?? '').toLowerCase().startsWith('image/')
  const dialog = active ? (
    <PdfViewerDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSrc(null)
      }}
      fileName={active.filename}
      title={active.filename}
      src={src ?? undefined}
      isImage={isImage}
    />
  ) : null

  return { openPreview, resolvingId, dialog }
}

/** A surfaced file whose row no longer resolves — a lean, honest, non-clickable card. */
const UnresolvedCard: FC<{ entry: ResolvedSurfacedDocument }> = ({ entry }) => {
  const t = useTranslations('chat')
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-dashed bg-muted/40 text-left">
      <div className="w-full overflow-hidden rounded-b-[10px] bg-card/60 shadow-2xs">
        <div className="flex h-[124px] w-full items-center justify-center border-b bg-card/40">
          <FileWarning className="size-7 text-muted-foreground/40" aria-hidden />
        </div>
        <div className="px-3.5 pb-3 pt-[11px]">
          <p className="truncate text-[12.5px] font-medium text-muted-foreground" title={entry.surfaced.file_name}>
            {entry.surfaced.file_name}
          </p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground/60">
            {t('documentGrid.unavailable')}
          </p>
        </div>
      </div>
    </div>
  )
}

/**
 * Renders a grid of REAL documents the assistant surfaced from the project and
 * Büroarchiv corpus (the `document_grid` card). Each entry resolves to its live
 * document row and renders in the raised "project selector" card anatomy — a
 * thumbnail, provenance chip, name and one-line description — that opens the
 * document on click. Search internals (relevance scores) are deliberately not
 * shown: the user cares about the documents, not the ranking.
 */
export const DocumentGridCard: FC<DocumentGridCardProps> = ({ title, query, documents, projectId }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const { resolved, isLoading } = useSurfacedDocuments(documents, projectId ?? null)
  const { openPreview, resolvingId, dialog } = useSurfacedPreview()

  if (documents.length === 0) return null

  const countLabel =
    documents.length === 1 ? t('documentGrid.countOne') : t('documentGrid.countOther', { count: documents.length })

  return (
    <section
      data-testid="document-grid-card"
      className="w-full overflow-hidden rounded-2xl border bg-gradient-to-b from-primary/[0.04] to-transparent"
    >
      {/* Header — accent icon, title + query, and a count pill. */}
      <header className="flex items-center gap-3 border-b bg-background/50 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15">
          <FolderSearch className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-semibold leading-tight text-foreground" title={title}>
            {title}
          </h3>
          {query && (
            <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground" title={query}>
              {t('documentGrid.forQuery', { query })}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
          {countLabel}
        </span>
      </header>

      {/* Grid — raised document cards; min-w-0 cells so long names truncate cleanly. */}
      <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(178px,1fr))]">
        {isLoading
          ? Array.from({ length: Math.min(documents.length, 4) }).map((_, i) => (
              <div key={i} className="min-w-0 overflow-hidden rounded-xl border bg-muted/50">
                <div className="overflow-hidden rounded-b-[10px] bg-card shadow-2xs">
                  <Skeleton className="h-[124px] w-full rounded-none" />
                  <div className="space-y-2 p-3.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
                <div className="p-3">
                  <Skeleton className="ml-auto h-3 w-20" />
                </div>
              </div>
            ))
          : resolved.map((entry) =>
              entry.file ? (
                <FileCard
                  key={entry.key}
                  file={{
                    ...entry.file,
                    // Prefer the live row's AI summary; fall back to the tool's
                    // summary, then a plain matched passage — never a relevance score.
                    summary: entry.file.summary ?? entry.surfaced.summary ?? entry.surfaced.snippet ?? null,
                  }}
                  isSelected={false}
                  locale={locale}
                  onSelect={() => void openPreview(entry.file as FileItem)}
                  source={entry.docSource}
                  sourceLabel={entry.docSource ? t(`documentGrid.source.${entry.docSource}`) : undefined}
                  hideStatusWhenReady
                  ariaLabel={t('documentGrid.openAria', { label: entry.file.filename })}
                  isBusy={resolvingId === entry.file.id}
                />
              ) : (
                <UnresolvedCard key={entry.key} entry={entry} />
              )
            )}
      </div>
      {dialog}
    </section>
  )
}

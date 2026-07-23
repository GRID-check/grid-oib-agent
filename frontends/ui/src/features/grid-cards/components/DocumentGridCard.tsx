'use client'

import { useState, type FC } from 'react'
import { FileWarning, FolderSearch } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { FileCard } from '@/features/documents/components/file-card'
import { FileGrid, FileCardSkeleton } from '@/features/documents/components/file-grid'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import { CountPill } from '@/components/ui/count-pill'
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
  // Clicking a surfaced document opens the SAME preview dialog the Files and
  // Archiv workspaces use — read-only here (no delete / re-ingest), and the
  // pane handles preview vs download for every file type itself.
  const [openFile, setOpenFile] = useState<{ file: FileItem; source: 'projekt' | 'buero' | null } | null>(null)

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
        <CountPill>{countLabel}</CountPill>
      </header>

      {/* Grid — raised document cards; min-w-0 cells so long names truncate cleanly. */}
      <div className="p-4">
        <FileGrid>
        {isLoading
          ? Array.from({ length: Math.min(documents.length, 4) }).map((_, i) => <FileCardSkeleton key={i} />)
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
                  onSelect={() => setOpenFile({ file: entry.file as FileItem, source: entry.docSource })}
                  source={entry.docSource}
                  sourceLabel={entry.docSource ? t(`documentGrid.source.${entry.docSource}`) : undefined}
                  hideStatusWhenReady
                  ariaLabel={t('documentGrid.openAria', { label: entry.file.filename })}
                />
              ) : (
                <UnresolvedCard key={entry.key} entry={entry} />
              )
            )}
        </FileGrid>
      </div>
      <FilePreviewDialog
        file={openFile?.file ?? null}
        // Only a project-sourced file gets the project context row; an Archiv
        // file is org-scoped, so leave projectId unset.
        projectId={openFile?.source === 'projekt' ? (projectId ?? undefined) : undefined}
        canManage={false}
        onClose={() => setOpenFile(null)}
      />
    </section>
  )
}

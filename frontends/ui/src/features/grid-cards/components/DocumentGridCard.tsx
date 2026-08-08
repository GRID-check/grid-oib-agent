'use client'

import { useMemo, useState, type FC } from 'react'
import { ArrowUpRight, CloudAlert, FileSearch, FolderSearch, RotateCcw } from 'lucide-react'
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

/**
 * A surfaced file whose row no longer resolves to a live document (removed, or
 * beyond the bounded list window — see the `TODO(backend)` in the hook). Not a
 * dead grey tile: an honest, actionable card that says the assistant referenced
 * the file and links to where it can be found (the org Archiv for a Büro file,
 * the project's files otherwise).
 */
const UnresolvedCard: FC<{ entry: ResolvedSurfacedDocument; projectId?: string | null }> = ({
  entry,
  projectId,
}) => {
  const t = useTranslations('chat')
  const isBuero = entry.surfaced.source === 'buero'
  const href = isBuero ? '/app/archiv' : projectId ? `/app/projects/${projectId}/files` : '/app/archiv'
  const actionLabel = isBuero || !projectId ? t('documentGrid.openInArchive') : t('documentGrid.openInFiles')

  return (
    <a
      href={href}
      data-testid="document-grid-unresolved"
      className="group flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-dashed bg-muted/40 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="w-full overflow-hidden rounded-b-[10px] bg-card/60 shadow-2xs">
        <div className="flex h-[124px] w-full items-center justify-center border-b bg-card/40 text-muted-foreground/45">
          <FileSearch className="size-7" aria-hidden />
        </div>
        <div className="px-3.5 pb-3 pt-[11px]">
          <p className="truncate text-[12.5px] font-medium text-foreground/80" title={entry.surfaced.file_name}>
            {entry.surfaced.file_name}
          </p>
          <p className="mt-1 line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
            {t('documentGrid.unresolvedHint')}
          </p>
          <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary group-hover:underline">
            {actionLabel}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </span>
        </div>
      </div>
    </a>
  )
}

/** Resolve failed (network / 5xx) — a retry affordance, never a wall of dead tiles. */
const ResolveErrorState: FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const t = useTranslations('chat')
  return (
    <div
      data-testid="document-grid-error"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center"
    >
      <CloudAlert className="size-7 text-muted-foreground/50" aria-hidden />
      <p className="text-[12.5px] text-muted-foreground">{t('documentGrid.loadError')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        {t('documentGrid.retry')}
      </button>
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
  const { resolved, isLoading, error, retry } = useSurfacedDocuments(documents, projectId ?? null)

  // Stabilize the per-card display file (the summary remap) so its identity only
  // changes when the resolution does — no thumbnail-fetch thrash on every render.
  const cells = useMemo(
    () =>
      resolved.map((entry) => ({
        entry,
        file: entry.file
          ? {
              ...entry.file,
              // Prefer the live row's AI summary; fall back to the tool's summary,
              // then a plain matched passage — never a relevance score.
              summary: entry.file.summary ?? entry.surfaced.summary ?? entry.surfaced.snippet ?? null,
            }
          : null,
      })),
    [resolved]
  )
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

      {/* Grid — raised document cards; min-w-0 cells so long names truncate cleanly.
          Loading shows a skeleton (never the dead-tile state); a genuine resolve
          failure shows a retry affordance instead of a wall of unresolved cards. */}
      <div className="p-4">
        {isLoading ? (
          <FileGrid>
            {Array.from({ length: Math.min(documents.length, 4) }).map((_, i) => (
              <FileCardSkeleton key={i} />
            ))}
          </FileGrid>
        ) : error ? (
          <ResolveErrorState onRetry={retry} />
        ) : (
          <FileGrid>
            {cells.map(({ entry, file }) =>
              file ? (
                <FileCard
                  key={entry.key}
                  file={file}
                  isSelected={false}
                  locale={locale}
                  onSelect={() => setOpenFile({ file, source: entry.docSource })}
                  source={entry.docSource}
                  sourceLabel={entry.docSource ? t(`documentGrid.source.${entry.docSource}`) : undefined}
                  hideStatusWhenReady
                  ariaLabel={t('documentGrid.openAria', { label: file.filename })}
                />
              ) : (
                <UnresolvedCard key={entry.key} entry={entry} projectId={projectId} />
              )
            )}
          </FileGrid>
        )}
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

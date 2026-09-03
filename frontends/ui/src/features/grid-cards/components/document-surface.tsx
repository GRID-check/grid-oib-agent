'use client'

import type { FC } from 'react'
import { ArrowUpRight, CloudAlert, FileSearch, RotateCcw } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { openFilePeek } from '@/features/documents/lib/open-file-peek'
import type { FileItem } from '@/features/documents/components/project-file-workspace'
import type { ResolvedSurfacedDocument } from '@/features/documents/hooks/use-surfaced-documents'

/** Open the cited/surfaced file in the chat peek. */
export function peekFile(
  file: FileItem,
  source: 'projekt' | 'buero' | null,
  projectId?: string | null,
): void {
  openFilePeek({ file, source, projectId })
}

/**
 * A surfaced file whose row no longer resolves to a live document. Honest
 * and actionable: says the assistant referenced the file and links to
 * where it can be found.
 */
export const UnresolvedCard: FC<{ entry: ResolvedSurfacedDocument; projectId?: string | null }> = ({
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
      <div className="w-full flex-1 overflow-hidden rounded-b-lg bg-card/60 shadow-2xs">
        <div className="flex h-[124px] w-full items-center justify-center border-b bg-card/40 text-muted-foreground/45">
          <FileSearch className="size-7" aria-hidden />
        </div>
        <div className="px-3.5 pb-3 pt-[11px]">
          <p className="truncate text-xs font-medium text-foreground/80" title={entry.surfaced.file_name}>
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
export const ResolveErrorState: FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const t = useTranslations('chat')
  return (
    <div
      data-testid="document-grid-error"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center"
    >
      <CloudAlert className="size-7 text-muted-foreground/50" aria-hidden />
      <p className="text-xs text-muted-foreground">{t('documentGrid.loadError')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <RotateCcw className="size-3.5" aria-hidden />
        {t('documentGrid.retry')}
      </button>
    </div>
  )
}

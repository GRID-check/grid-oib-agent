'use client'

/**
 * Archiv library pane (WS-6) — the org Archiv's curated presentation of the
 * office knowledge store: a card grid of archive documents with content-aware
 * skeleton thumbnails, a category-chip filter row driven by the REAL controlled
 * ingestion tags present on the loaded documents, and a search field over
 * name / AI summary / tags (mirroring the Files workspace behavior).
 *
 * Honesty rules (spec §2.3, "detail library" caveat):
 *   - Category chips only ever show tags that actually exist on the loaded
 *     documents — no custom-category creation (that needs product work).
 *   - The provenance footer renders only when a document carries real
 *     ingestion tags; documents without tags get no fake source line.
 *   - No "verified / Geprüft" markers — that review workflow does not exist.
 *
 * Gold (`--source-office`) is the Büroarchiv provenance signal (spec §4),
 * always paired with the archive icon + label so color is never the only
 * carrier (a11y). Tokens only; the fallbacks keep the pane correct even
 * before the WS-1 token retune is applied.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, Search, X } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { DocumentStatusBadge } from './document-status'

/** Büroarchiv signal tint — semantic tokens with pre-retune fallbacks, no hex. */
const OFFICE_TINT: CSSProperties = {
  backgroundColor: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
  color: 'var(--source-office-text, var(--source-office, var(--text-color-feedback-warning)))',
}

const OFFICE_TEXT: CSSProperties = {
  color: 'var(--source-office-text, var(--source-office, var(--text-color-feedback-warning)))',
}

interface ArchivLibraryPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** Upload control rendered inside the first-run empty state (managers only). */
  uploadControl?: ReactNode
}

export function ArchivLibraryPane({
  files,
  selectedFileId,
  onSelectFile,
  isLoading,
  uploadControl,
}: ArchivLibraryPaneProps) {
  const t = useTranslations('archiv')
  const { locale } = useLocale()
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  // Category chips = the distinct controlled ingestion tags actually present on
  // the loaded documents, most frequent first (ties: locale alphabetical).
  // Nothing is invented: an Archiv without tagged documents shows no chip row.
  const categories = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>()
    for (const file of files) {
      for (const tag of file.tags ?? []) {
        const key = tag.toLowerCase()
        const entry = counts.get(key)
        if (entry) entry.count += 1
        else counts.set(key, { label: tag, count: 1 })
      }
    }
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, locale),
    )
  }, [files, locale])

  // Combined filter: category chip (exact tag match, case-insensitive) AND the
  // search query over filename, AI summary, and tags — same fields the Files
  // workspace searches.
  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    return files.filter((f) => {
      if (selectedTag && !(f.tags ?? []).some((tag) => tag.toLowerCase() === selectedTag)) {
        return false
      }
      if (!q) return true
      return (
        f.filename.toLowerCase().includes(q) ||
        (f.summary ?? '').toLowerCase().includes(q) ||
        (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      )
    })
  }, [files, search, selectedTag])

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-9 w-full" />
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border">
              <Skeleton className="h-[132px] w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // First-run empty state — the Archiv holds no documents yet.
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={Archive}
          title={t('library.emptyTitle')}
          description={t('library.emptyDescription')}
          action={uploadControl}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Search bar */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('library.searchPlaceholder')}
            aria-label={t('library.searchLabel')}
            className="pl-8 pr-8"
          />
          {search !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('library.resetSearch')}
              className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Category chips — filter over the tags that really exist. */}
      {categories.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2"
          role="group"
          aria-label={t('library.categoriesLabel')}
        >
          <CategoryChip
            label={t('library.allCategories')}
            active={selectedTag === null}
            onClick={() => setSelectedTag(null)}
          />
          {categories.map((category) => (
            <CategoryChip
              key={category.label.toLowerCase()}
              label={category.label}
              active={selectedTag === category.label.toLowerCase()}
              onClick={() =>
                setSelectedTag((current) =>
                  current === category.label.toLowerCase() ? null : category.label.toLowerCase(),
                )
              }
            />
          ))}
        </div>
      )}

      {/* Card grid */}
      {filteredFiles.length === 0 ? (
        <div className="p-8">
          <EmptyState
            variant="bare"
            icon={Search}
            title={t('library.noMatchTitle')}
            description={t('library.noMatchDescription')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('')
                  setSelectedTag(null)
                }}
              >
                {t('library.clearFilters')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {filteredFiles.map((file) => (
            <ArchivDocumentCard
              key={file.id}
              file={file}
              isSelected={selectedFileId === file.id}
              onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
              locale={locale}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={active ? OFFICE_TINT : undefined}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        active
          ? 'border-transparent font-semibold'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
}

/**
 * One archive-document card: content-aware skeleton thumbnail, name, one-line
 * AI summary (only when the backend generated one — nothing fake), tinted
 * extension chip, size + relative time, ingestion-status badge (kept — critical
 * operational info the click dummy lacks), and a provenance footer showing the
 * document's real ingestion tags with the gold Büroarchiv mark. Documents
 * without tags get no provenance line, and there is deliberately no
 * "verified/Geprüft" marker — that workflow does not exist (spec §2.3).
 */
function ArchivDocumentCard({
  file,
  isSelected,
  onSelect,
  locale,
}: {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
}) {
  const t = useTranslations('archiv')
  const tFiles = useTranslations('files')
  const kind = inferDocumentKind(file)
  const ext = fileExtensionLabel(file.filename)
  const isFailed = file.status === 'failed'
  const failureReason = isFailed ? file.errorMessage || tFiles('preview.ingestionFailedGeneric') : undefined
  const provenance = (file.tags ?? []).slice(0, 3).join(' · ')

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      data-testid="archiv-document-card"
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-2xs transition-shadow duration-200 ease-out hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        isSelected && 'ring-2 ring-ring',
      )}
    >
      {/* Thumbnail header — skeleton sketch by inferred kind, hairline divider. */}
      <div className="relative flex h-[132px] w-full shrink-0 items-center justify-center border-b bg-card">
        <DocumentKindThumbnail kind={kind} className="h-20 w-auto text-muted-foreground" />
        <DocumentStatusBadge status={file.status} className="absolute right-2 top-2" />
      </div>

      {/* Body */}
      <div className="flex w-full flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium text-foreground" title={file.filename}>
          {file.filename}
        </p>
        {isFailed ? (
          <p className="line-clamp-2 text-xs text-destructive" title={failureReason}>
            {failureReason}
          </p>
        ) : (
          file.summary && (
            <p className="line-clamp-1 text-xs leading-relaxed text-muted-foreground" title={file.summary}>
              {file.summary}
            </p>
          )
        )}
        <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1.5 text-xs text-muted-foreground/80">
          {ext !== '' && (
            <span
              className="inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none"
              style={extChipTint(ext)}
            >
              {ext}
            </span>
          )}
          <span className="shrink-0 tabular-nums">{formatFileSize(file.fileSize, locale)}</span>
          <span aria-hidden>·</span>
          <span className="truncate" title={formatAbsoluteTime(file.createdAt, locale)}>
            {formatRelativeTime(file.createdAt, locale)}
          </span>
        </div>
        {/* Provenance footer — only real tag data; rendered not at all otherwise. */}
        {provenance !== '' && (
          <p
            className="flex min-w-0 items-center gap-1 border-t pt-1.5 text-[0.6875rem] font-medium"
            style={OFFICE_TEXT}
            data-testid="archiv-provenance"
          >
            <Archive className="size-3 shrink-0" aria-hidden />
            <span className="truncate" title={t('library.provenance', { source: provenance })}>
              {t('library.provenance', { source: provenance })}
            </span>
          </p>
        )}
      </div>
    </button>
  )
}

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

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, Loader2, Search, Sparkles, X } from 'lucide-react'
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
import { useSemanticSearch } from '../hooks/use-semantic-search'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { DocumentStatusBadge } from './document-status'
import { SemanticMatch } from './semantic-match'

/** Büroarchiv signal tint — semantic tokens with pre-retune fallbacks, no hex. */
const OFFICE_TINT: CSSProperties = {
  backgroundColor: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
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

  const semantic = useSemanticSearch({ endpoint: '/api/archiv/documents/search' })

  const runSemantic = () => semantic.run(search)
  // Any edit to the query drops back to the live substring filter so the two
  // modes never show a stale mix; the reset control does the same explicitly.
  const handleSearchChange = (value: string) => {
    setSearch(value)
    if (semantic.active) semantic.reset()
  }
  const clearSearch = () => {
    setSearch('')
    setSelectedTag(null)
    semantic.reset()
  }

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
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border bg-secondary shadow-sm">
              <div className="overflow-hidden rounded-b-[10px] bg-card shadow-xs">
                <Skeleton className="h-[190px] w-full rounded-none" />
                <div className="space-y-2.5 px-4 pb-[13px] pt-3.5">
                  <Skeleton className="h-[30px] w-full" />
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <div className="px-4 pb-2.5 pt-[9px]">
                <Skeleton className="h-3 w-1/2" />
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
      {/* Search bar — instant substring filter as you type; Enter (or the search
          button) runs the semantic search over the Archiv collection. */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            runSemantic()
          }}
        >
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="text"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('library.semantic.searchPlaceholder')}
              aria-label={t('library.searchLabel')}
              className="pl-8 pr-8"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={t('library.resetSearch')}
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="shrink-0 gap-1.5"
            disabled={search.trim() === '' || semantic.isSearching}
          >
            {semantic.isSearching ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-3.5" aria-hidden />
            )}
            {t('library.semantic.run')}
          </Button>
        </form>
      </div>

      {/* Semantic-mode banner — transparent about which mode is active, with a
          clear reset back to the normal list. */}
      {semantic.active && (
        <div
          className="flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs"
          role="status"
          data-testid="archiv-semantic-banner"
        >
          {semantic.isSearching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-foreground">
            {semantic.isSearching
              ? t('library.semantic.searching', { query: semantic.query ?? '' })
              : t('library.semantic.banner', {
                  count: String(semantic.hits.length),
                  query: semantic.query ?? '',
                })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            onClick={clearSearch}
          >
            <X className="size-3.5" aria-hidden />
            {t('library.semantic.reset')}
          </Button>
        </div>
      )}

      {/* Category chips — filter over the tags that really exist. Hidden in
          semantic mode (the query is the context). */}
      {!semantic.active && categories.length > 0 && (
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

      {semantic.active ? (
        // Semantic results — one card per matched file, each showing the match
        // evidence (snippet + page + relevance). A backend error/timeout fails
        // open to an empty result set (never a crash).
        semantic.isSearching ? (
          <div className="grid grid-cols-1 gap-3.5 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border bg-secondary shadow-sm">
                <div className="overflow-hidden rounded-b-[10px] bg-card shadow-xs">
                  <Skeleton className="h-[190px] w-full rounded-none" />
                  <div className="space-y-2.5 px-4 pb-[13px] pt-3.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-12 w-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : semantic.hits.length === 0 ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={Sparkles}
              title={t('library.semantic.noResults', { query: semantic.query ?? '' })}
              description={t('library.semantic.noResultsDescription')}
              action={
                <Button variant="outline" size="sm" onClick={clearSearch}>
                  {t('library.semantic.reset')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {semantic.hits.map((hit) => (
              <ArchivDocumentCard
                key={hit.id}
                file={hit}
                isSelected={selectedFileId === hit.id}
                onSelect={() => onSelectFile(selectedFileId === hit.id ? null : hit.id)}
                locale={locale}
                match={{ snippet: hit.snippet, page: hit.page, score: hit.score }}
              />
            ))}
          </div>
        )
      ) : /* Substring-filtered card grid (instant, as you type). */
      filteredFiles.length === 0 ? (
        <div className="p-8">
          <EmptyState
            variant="bare"
            icon={Search}
            title={t('library.noMatchTitle')}
            description={t('library.noMatchDescription')}
            action={
              <Button variant="outline" size="sm" onClick={clearSearch}>
                {t('library.clearFilters')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 p-4 sm:grid-cols-2 lg:grid-cols-3">
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

/**
 * Lazy-load the thumbnail image for an Archiv card, falling back to the
 * content-aware SVG sketch when no thumbnail exists or on error.
 */
function ArchivThumbnailWithFallback({ file }: { file: FileItem }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [imgError, setImgError] = useState(false)
  const kind = inferDocumentKind(file)
  const canHaveThumbnail = file.contentType === 'application/pdf' || (file.contentType ?? '').startsWith('image/')

  useEffect(() => {
    if (!canHaveThumbnail) return
    let cancelled = false
    fetch(`/api/documents/${file.id}/thumbnail`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.url) setImgUrl(data.url)
      })
      .catch(() => { /* fallback to SVG sketch */ })
    return () => { cancelled = true }
  }, [file.id, canHaveThumbnail])

  if (imgUrl && !imgError) {
    return (
      <img
        src={imgUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        onError={() => setImgError(true)}
      />
    )
  }

  return <DocumentKindThumbnail kind={kind} className="h-[88px] w-auto text-muted-foreground/70" />
}

/**
 * One archive-document card (click-dummy detail-card anatomy): an inner white
 * block — h190 skeleton thumbnail by inferred kind + hairline divider, a gold
 * Büroarchiv kind chip (`--source-office`) beside a 30×30 tinted extension tile,
 * the name, and a one-line AI summary (only when the backend generated one) —
 * sitting proud of a subtle outer surface, with a footer tab carrying the real
 * tag provenance (left) and the operational size · time (right). The
 * ingestion-status badge is kept (critical operational info the dummy lacks).
 * Documents without tags get no provenance line, and there is deliberately no
 * "verified/Geprüft" marker — that workflow does not exist (spec §2.3).
 */
function ArchivDocumentCard({
  file,
  isSelected,
  onSelect,
  locale,
  match,
}: {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
  /** Present on a semantic result: the snippet + page + score to show WHY it matched. */
  match?: { snippet: string; page: number | null; score: number }
}) {
  const t = useTranslations('archiv')
  const tFiles = useTranslations('files')
  const kind = inferDocumentKind(file)
  const kindLabel = t(`library.kind.${kind}` as 'library.kind.document')
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
        'group flex flex-col overflow-hidden rounded-xl border bg-secondary text-left shadow-sm transition-shadow duration-200 ease-out hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
        isSelected && 'ring-2 ring-ring',
      )}
    >
      {/* Inner white block: thumbnail + metadata, sitting proud of the subtle
          outer surface so the footer reads as a separate tab (dummy anatomy). */}
      <div className="w-full overflow-hidden rounded-b-[10px] bg-card shadow-xs">
        {/* Thumbnail — lazy-loaded real thumbnail or fallback sketch. */}
        <div className="relative flex h-[190px] w-full items-center justify-center border-b bg-card overflow-hidden">
          <ArchivThumbnailWithFallback file={file} />
          <DocumentStatusBadge status={file.status} className="absolute right-2.5 top-2.5" />
        </div>

        {/* Metadata block */}
        <div className="px-4 pb-[13px] pt-3.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex shrink-0 items-center rounded-[6px] px-2 py-[3px] text-[11px] font-semibold leading-none tracking-[0.03em]"
              style={OFFICE_TINT}
            >
              {kindLabel}
            </span>
            <span className="flex-1" />
            {ext !== '' && (
              <span
                className="flex size-[30px] shrink-0 items-center justify-center rounded-[6px] text-[9px] font-bold leading-none tracking-[0.03em]"
                style={extChipTint(ext)}
              >
                {ext}
              </span>
            )}
          </div>
          <p className="mt-[11px] truncate text-[0.84375rem] font-medium leading-[1.4] text-foreground" title={file.filename}>
            {file.filename}
          </p>
          {match ? (
            // Semantic result: show WHY it matched (snippet + page + relevance)
            // rather than the generic one-line summary.
            <SemanticMatch snippet={match.snippet} page={match.page} score={match.score} />
          ) : isFailed ? (
            <p className="mt-[3px] line-clamp-2 text-xs text-destructive" title={failureReason}>
              {failureReason}
            </p>
          ) : (
            file.summary && (
              <p className="mt-[3px] line-clamp-1 text-xs text-muted-foreground" title={file.summary}>
                {file.summary}
              </p>
            )
          )}
        </div>
      </div>

      {/* Footer tab on the subtle outer surface: real provenance (left) and the
          operational size/time (right). Provenance renders only from real tag
          data — no fake source, and deliberately no "verified/Geprüft" marker. */}
      <div className="flex w-full items-center gap-2 px-4 pb-2.5 pt-[9px] text-[0.71875rem]">
        {provenance !== '' ? (
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground/80"
            data-testid="archiv-provenance"
            title={t('library.provenance', { source: provenance })}
          >
            {t('library.provenance', { source: provenance })}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {formatFileSize(file.fileSize, locale)}
        </span>
        <span aria-hidden className="text-muted-foreground/40">
          ·
        </span>
        <span
          className="shrink-0 truncate text-muted-foreground/70"
          title={formatAbsoluteTime(file.createdAt, locale)}
        >
          {formatRelativeTime(file.createdAt, locale)}
        </span>
      </div>
    </button>
  )
}

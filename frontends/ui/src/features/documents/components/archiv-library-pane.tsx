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

import { useMemo, useState, type ReactNode } from 'react'
import { Archive, Loader2, Search, Sparkles, X } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'
import { inferDocumentKind } from '../document-kind'
import { useSemanticSearch } from '../hooks/use-semantic-search'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FilterChip } from './filter-chip'

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
        <FileGrid>
          {Array.from({ length: 6 }).map((_, i) => (
            <FileCardSkeleton key={i} />
          ))}
        </FileGrid>
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
          <FilterChip
            label={t('library.allCategories')}
            active={selectedTag === null}
            onClick={() => setSelectedTag(null)}
          />
          {categories.map((category) => (
            <FilterChip
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
          <div className="p-4">
            <FileGrid>
              {Array.from({ length: 6 }).map((_, i) => (
                <FileCardSkeleton key={i} />
              ))}
            </FileGrid>
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
          <div className="p-4">
            <FileGrid>
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
            </FileGrid>
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
        <div className="p-4">
          <FileGrid>
            {filteredFiles.map((file) => (
              <ArchivDocumentCard
                key={file.id}
                file={file}
                isSelected={selectedFileId === file.id}
                onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                locale={locale}
              />
            ))}
          </FileGrid>
        </div>
      )}
    </div>
  )
}

/**
 * One Archiv document card — the shared raised {@link FileCard} with Archiv
 * content mapping: the gold Büroarchiv-tinted chip carries the inferred document
 * KIND, and the footer lead carries the real tag provenance (only when tags
 * exist). A thin wrapper on purpose — the card STYLE lives once in FileCard,
 * shared with the Files browser and the chat surfacing grid.
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
  match?: { snippet: string; page: number | null; score: number }
}) {
  const t = useTranslations('archiv')
  const kind = inferDocumentKind(file)
  const kindLabel = t(`library.kind.${kind}` as 'library.kind.document')
  const provenance = (file.tags ?? []).slice(0, 3).join(' · ')

  return (
    <FileCard
      file={file}
      isSelected={isSelected}
      onSelect={onSelect}
      locale={locale}
      match={match}
      testId="archiv-document-card"
      source="buero"
      sourceLabel={kindLabel}
      footerLead={
        provenance !== '' ? (
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground/80"
            data-testid="archiv-provenance"
            title={t('library.provenance', { source: provenance })}
          >
            {t('library.provenance', { source: provenance })}
          </span>
        ) : undefined
      }
    />
  )
}

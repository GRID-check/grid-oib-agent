'use client'

/**
 * Archiv library pane (WS-6) — the org Archiv's curated presentation of the
 * office knowledge store: a card grid of archive documents with content-aware
 * skeleton thumbnails and a category-chip filter row driven by the REAL
 * controlled ingestion tags present on the loaded documents. The search over
 * name / AI summary / tags is the same one the Files workspace runs, owned by
 * {@link ArchivWorkspace} because its field sits in the header band above.
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
import { Archive, Search, SearchX, Sparkles } from 'lucide-react'
import type { FileItem } from './project-file-workspace'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'
import { inferDocumentKind } from '../document-kind'
import type { FileSearchState } from '../hooks/use-file-search'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { SemanticSearchBanner } from './file-search'
import { FilterChip } from './filter-chip'

/** The kinds of result region the pane can show (see `view` below). */
type ArchivResultView =
  | 'grid'
  | 'no-match'
  | 'semantic-searching'
  | 'semantic-results'
  | 'semantic-empty'
  | 'semantic-error'

interface ArchivLibraryPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** Upload control rendered inside the first-run empty state (managers only). */
  uploadControl?: ReactNode
  /** Per-file rename / delete / download on the card. */
  renderActions?: (file: FileItem) => ReactNode
  /**
   * The search field, for the narrow window where the Archiv's header band
   * cannot hold it beside the identity mark and the upload button (below `lg`).
   * Rendered as the top band of the listing and hidden from `lg`, where the copy
   * in the header takes over — the two are one control, only one ever shown.
   */
  searchField?: ReactNode
  /**
   * The query, the semantic run and the instant filter. Owned by the workspace,
   * because the field itself sits in the Archiv's header band — see
   * {@link import('../hooks/use-file-search').useFileSearch}.
   */
  search: FileSearchState
}

export function ArchivLibraryPane({
  files,
  selectedFileId,
  onSelectFile,
  isLoading,
  uploadControl,
  renderActions,
  searchField,
  search,
}: ArchivLibraryPaneProps) {
  const t = useTranslations('archiv')
  const { locale } = useLocale()
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const { semantic } = search

  // The reset offered by every empty state clears BOTH narrowings. A reader who
  // asks to see everything again after a fruitless search means it, and leaving
  // a category chip pressed would answer them with a still-filtered Archiv.
  const clearFilters = () => {
    setSelectedTag(null)
    search.clear()
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
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, locale)
    )
  }, [files, locale])

  // Combined filter: category chip (exact tag match, case-insensitive) AND the
  // search query over filename, AI summary, and tags — same fields the Files
  // workspace searches.
  const filteredFiles = useMemo(
    () =>
      search.filter(
        selectedTag === null
          ? files
          : files.filter((f) => (f.tags ?? []).some((tag) => tag.toLowerCase() === selectedTag))
      ),
    [files, search, selectedTag]
  )

  /**
   * Which kind of result the pane is showing. Named rather than inlined into
   * nested ternaries because it is also the animation key below — the crossfade
   * has to run on a change of KIND, not on every change of the query.
   */
  const view: ArchivResultView = semantic.active
    ? semantic.isSearching
      ? 'semantic-searching'
      : // A SEARCH THAT NEVER RAN IS NOT A SEARCH THAT FOUND NOTHING.
        // The hook fails open to an empty result set so the pane cannot crash,
        // and it says which of the two happened — but nothing read that flag,
        // so a backend timeout rendered as "no semantic matches for
        // 'Brandschutz'": the surface told the reader their own corpus does not
        // contain the thing they are looking for, and offered them a reset.
        semantic.error
        ? 'semantic-error'
        : semantic.hits.length === 0
          ? 'semantic-empty'
          : 'semantic-results'
    : filteredFiles.length === 0
      ? 'no-match'
      : 'grid'

  // The loading state is the loaded layout with its content not yet in it:
  // search row, chip row, card grid, at the same heights and in the same
  // bordered bands. The previous skeleton was a bare stack in a padded box, so
  // the arrival of the real pane moved every row on the screen — the jump read
  // as the page reloading rather than as content settling in.
  if (isLoading) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        {/* Only below `lg`, where the loaded pane carries the search band too. */}
        {searchField && (
          <div className="shrink-0 border-b px-4 py-2.5 lg:hidden">
            <Skeleton className="h-9 min-h-9 w-full" />
          </div>
        )}
        <div className="flex min-h-12 gap-1.5 border-b px-4 py-2">
          {['all', 'one', 'two', 'three'].map((key) => (
            <Skeleton key={key} className="h-8 w-20 shrink-0 rounded-lg" />
          ))}
        </div>
        <div className="p-4">
          <FileGrid size="roomy">
            {Array.from({ length: 8 }).map((_, i) => (
              <FileCardSkeleton key={i} size="roomy" />
            ))}
          </FileGrid>
        </div>
      </div>
    )
  }

  // First-run empty state — the Archiv holds no documents yet.
  if (files.length === 0) {
    return (
      <div className="animate-in fade-in-0 flex h-full items-center justify-center p-8 duration-base ease-out motion-reduce:animate-none">
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
    <div className="animate-in fade-in-0 flex h-full flex-col duration-base ease-out motion-reduce:animate-none">
      {/* From `lg` the search FIELD is up in the Archiv's header band, with the
          upload button; below that it is this band, where it used to live for
          every window. What stays here either way is the band that describes
          the result set. */}
      {searchField && (
        <div className="bg-background/95 shrink-0 border-b px-4 py-2.5 lg:hidden">
          {searchField}
        </div>
      )}

      {semantic.active && (
        <SemanticSearchBanner
          variant="band"
          isSearching={semantic.isSearching}
          bannerText={
            semantic.isSearching
              ? t('library.semantic.searching', { query: semantic.query ?? '' })
              : // The count is a claim about the corpus, and a search that never
                // ran has not counted anything. Reporting "0 results" above a
                // panel that says the search failed is the same lie twice, in the
                // one line the reader takes at face value.
                semantic.error
                ? t('library.semantic.failedBanner', { query: semantic.query ?? '' })
                : t('library.semantic.banner', {
                    count: String(semantic.hits.length),
                    query: semantic.query ?? '',
                  })
          }
          resetLabel={t('library.semantic.reset')}
          onReset={clearFilters}
          testId="archiv-semantic-banner"
        />
      )}

      {/* Category chips — filter over the tags that really exist. Hidden in
          semantic mode (the query is the context). */}
      {!semantic.active && categories.length > 0 && (
        <div
          className="flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2"
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
                  current === category.label.toLowerCase() ? null : category.label.toLowerCase()
                )
              }
            />
          ))}
        </div>
      )}

      {/* One results region, keyed on the KIND of result it is showing, so a
          change of kind (browse → searching → results → nothing found) crosses
          over with a fade instead of one block being swapped for a differently
          shaped one mid-frame. Keyed on the kind and NOT on the query or the
          selected chip on purpose: filtering within the grid must leave the
          cards mounted, or every keystroke would remount them and re-request
          their thumbnails. */}
      <div
        key={view}
        className="animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none"
        data-testid="archiv-results"
        data-view={view}
      >
        {view === 'semantic-searching' ? (
          <div className="p-4">
            <FileGrid size="roomy">
              {Array.from({ length: 6 }).map((_, i) => (
                <FileCardSkeleton key={i} size="roomy" />
              ))}
            </FileGrid>
          </div>
        ) : view === 'semantic-error' ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={SearchX}
              title={t('library.semantic.failed')}
              description={t('library.semantic.failedDescription')}
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {/* The retry runs the SAME query. Offering only "show all
                      files" would ask the reader to give up and start again
                      from a search they had already typed. */}
                  <Button size="sm" onClick={() => semantic.run(semantic.query ?? '')}>
                    {t('library.semantic.retry')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    {t('library.semantic.reset')}
                  </Button>
                </div>
              }
            />
          </div>
        ) : view === 'semantic-empty' ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={Sparkles}
              title={t('library.semantic.noResults', { query: semantic.query ?? '' })}
              description={t('library.semantic.noResultsDescription')}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {t('library.semantic.reset')}
                </Button>
              }
            />
          </div>
        ) : view === 'semantic-results' ? (
          // Semantic results — one card per matched file, each showing the match
          // evidence (snippet + page + relevance). A backend error/timeout fails
          // open to an empty result set (never a crash).
          <div className="p-4">
            <FileGrid size="roomy">
              {semantic.hits.map((hit) => (
                <ArchivDocumentCard
                  key={hit.id}
                  file={hit}
                  isSelected={selectedFileId === hit.id}
                  onSelect={() => onSelectFile(selectedFileId === hit.id ? null : hit.id)}
                  locale={locale}
                  match={{ snippet: hit.snippet, page: hit.page, score: hit.score }}
                  actions={renderActions?.(hit)}
                />
              ))}
            </FileGrid>
          </div>
        ) : view === 'no-match' ? (
          <div className="p-8">
            <EmptyState
              variant="bare"
              icon={Search}
              title={t('library.noMatchTitle')}
              description={t('library.noMatchDescription')}
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  {t('library.clearFilters')}
                </Button>
              }
            />
          </div>
        ) : (
          /* Substring-filtered card grid (instant, as you type). */
          <div className="p-4">
            <FileGrid size="roomy">
              {filteredFiles.map((file) => (
                <ArchivDocumentCard
                  key={file.id}
                  file={file}
                  isSelected={selectedFileId === file.id}
                  onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                  locale={locale}
                  actions={renderActions?.(file)}
                />
              ))}
            </FileGrid>
          </div>
        )}
      </div>
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
  actions,
}: {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
  match?: { snippet: string; page: number | null; score: number }
  actions?: ReactNode
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
      size="roomy"
      source="buero"
      sourceLabel={kindLabel}
      actions={actions}
      footerLead={
        provenance !== '' ? (
          <span
            className="text-muted-foreground/80 min-w-0 flex-1 truncate"
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

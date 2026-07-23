'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, FolderOpen, Loader2, Sparkles, UploadCloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useLocale, useTranslations } from '@/i18n'
import { useSemanticSearch } from '../hooks/use-semantic-search'
import { FileCard } from './file-card'
import { FileGrid, FileCardSkeleton } from './file-grid'
import { FilterChip } from './filter-chip'

interface FileBrowserPaneProps {
  files: FileItem[]
  selectedFileId: string | null
  onSelectFile: (id: string | null) => void
  isLoading: boolean
  /** True when a specific folder is selected (vs. the "All Files" root). */
  hasFolderSelected: boolean
  /** Upload control rendered inside the first-run empty state. */
  uploadControl?: ReactNode
  /** Dashed upload card rendered as the last tile of the grid (project corpus). */
  uploadCard?: ReactNode
  /**
   * Top-level folders presented as a quick-filter chip row above the grid
   * (mirrors the sidebar tree — same selection state, no separate data model).
   * Omitted by callers without folders (Archiv).
   */
  folders?: FolderItem[]
  selectedFolderId?: string | null
  onSelectFolder?: (id: string | null) => void
  /**
   * Project whose corpus the explicit-run semantic search queries. When
   * provided, pressing Enter (or the search button) runs a deterministic vector
   * search via `/api/documents/search`; the instant substring filter over the
   * current listing keeps working as the user types. Omit to disable semantic
   * mode (the substring filter still works).
   */
  projectId?: string
}

export function FileBrowserPane({
  files,
  selectedFileId,
  onSelectFile,
  isLoading,
  hasFolderSelected,
  uploadControl,
  uploadCard,
  folders,
  selectedFolderId = null,
  onSelectFolder,
  projectId,
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [search, setSearch] = useState('')

  const semanticBody = useMemo(() => ({ projectId }), [projectId])
  const semantic = useSemanticSearch({ endpoint: '/api/documents/search', extraBody: semanticBody })
  const canSearch = projectId !== undefined

  // Commit the current query to the semantic search (Enter / search button).
  const runSemantic = () => {
    if (canSearch) semantic.run(search)
  }
  // Any edit to the query drops back to the live substring filter so the two
  // modes never show a stale mix; the reset control does the same explicitly.
  const handleSearchChange = (value: string) => {
    setSearch(value)
    if (semantic.active) semantic.reset()
  }
  const clearSearch = () => {
    setSearch('')
    semantic.reset()
  }

  // Client-side filter over the current listing: name, plus AI tags and
  // summary when the backend generated them.
  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter(
      (f) =>
        f.filename.toLowerCase().includes(q) ||
        (f.summary ?? '').toLowerCase().includes(q) ||
        (f.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
    )
  }, [files, search])

  const topLevelFolders = useMemo(
    () => (folders ?? []).filter((f) => f.parentId === null),
    [folders]
  )

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

  // First-run empty state — the whole corpus (or selected folder) has no files.
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        {hasFolderSelected ? (
          <EmptyState
            icon={FolderOpen}
            title={t('browser.folderEmptyTitle')}
            description={t('browser.folderEmptyDescription')}
            action={uploadControl}
          />
        ) : (
          <EmptyState
            icon={UploadCloud}
            title={t('browser.noDocumentsTitle')}
            description={t('browser.noDocumentsDescription')}
            action={uploadControl}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Search bar — instant substring filter as you type; Enter (or the search
          button) runs the semantic search over the project corpus. */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            runSemantic()
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="text"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={canSearch ? t('browser.semantic.searchPlaceholder') : t('browser.searchPlaceholder')}
              aria-label={t('browser.searchLabel')}
              className="pl-8 pr-8"
            />
            {search !== '' && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={t('browser.resetSearch')}
                className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </div>
          {canSearch && (
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
              {t('browser.semantic.run')}
            </Button>
          )}
        </form>
      </div>

      {/* Semantic-mode banner — transparent about which mode is active, with a
          clear reset back to the normal list. */}
      {semantic.active && (
        <div
          className="flex items-center gap-2 border-b border-primary/20 bg-primary/5 px-4 py-2 text-xs"
          role="status"
          data-testid="semantic-banner"
        >
          {semantic.isSearching ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate text-foreground">
            {semantic.isSearching
              ? t('browser.semantic.searching', { query: semantic.query ?? '' })
              : t('browser.semantic.banner', {
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
            {t('browser.semantic.reset')}
          </Button>
        </div>
      )}

      {/* Top-level folder quick filter — chip presentation of the same folder
          selection the sidebar tree drives (no separate navigation model).
          Hidden in semantic mode (the query is the context). */}
      {!semantic.active && onSelectFolder && topLevelFolders.length > 0 && (
        <div
          // Wrap on mobile so the last folder pill is never clipped at the
          // right edge; keep a single scrollable row from md up (where it fits).
          className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 md:flex-nowrap md:overflow-x-auto"
          role="group"
          aria-label={t('folders.heading')}
        >
          <FilterChip
            label={t('folders.allFiles')}
            active={selectedFolderId === null}
            onClick={() => onSelectFolder(null)}
          />
          {topLevelFolders.map((folder) => (
            <FilterChip
              key={folder.id}
              label={folder.name}
              active={selectedFolderId === folder.id}
              onClick={() => onSelectFolder(folder.id)}
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
              title={t('browser.semantic.noResults', { query: semantic.query ?? '' })}
              description={t('browser.semantic.noResultsDescription')}
              action={
                <Button variant="outline" size="sm" onClick={clearSearch}>
                  {t('browser.semantic.reset')}
                </Button>
              }
            />
          </div>
        ) : (
          <div className="p-4">
            <FileGrid>
              {semantic.hits.map((hit) => (
                <FileCard
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
            title={t('browser.noMatch', { query: search })}
            description={t('browser.noMatchDescription')}
            action={
              <Button variant="outline" size="sm" onClick={clearSearch}>
                {t('browser.clearSearch')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="p-4">
          {/* Section label — "Recently uploaded" at the corpus root, matching the
              click-dummy. Hidden inside a folder view (the chip already names it)
              and while searching (the query is the context). */}
          {search === '' && selectedFolderId === null && (
            <p className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {t('browser.recentlyUploaded')}
            </p>
          )}
          <FileGrid>
            {filteredFiles.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                isSelected={selectedFileId === file.id}
                onSelect={() => onSelectFile(selectedFileId === file.id ? null : file.id)}
                locale={locale}
              />
            ))}
            {uploadCard}
          </FileGrid>
        </div>
      )}
    </div>
  )
}

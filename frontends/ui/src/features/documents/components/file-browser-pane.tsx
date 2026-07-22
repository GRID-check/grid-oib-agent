'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, FolderOpen, Loader2, Sparkles, UploadCloud, X } from 'lucide-react'
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
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] md:[grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-xl border">
              <Skeleton className="h-24 w-full rounded-none md:h-[132px]" />
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
          <FolderChip
            label={t('folders.allFiles')}
            active={selectedFolderId === null}
            onClick={() => onSelectFolder(null)}
          />
          {topLevelFolders.map((folder) => (
            <FolderChip
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
          <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-xl border">
                <Skeleton className="h-24 w-full rounded-none md:h-[132px]" />
                <div className="space-y-2 p-3">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-12 w-full" />
                </div>
              </div>
            ))}
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
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
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
            </div>
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
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-3.5 md:[grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
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
          </div>
        </div>
      )}
    </div>
  )
}

function FolderChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-xs font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-foreground/20 bg-foreground text-background'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {label}
    </button>
  )
}

/**
 * Lazy-load the thumbnail image for a file card, falling back to the
 * content-aware SVG sketch when no thumbnail exists or on error.
 */
function ThumbnailWithFallback({ file }: { file: FileItem }) {
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

  return <DocumentKindThumbnail kind={kind} variant="fill" />
}

/**
 * One document card: content-aware skeleton thumbnail, name, one-line AI
 * description (only when the backend generated one — nothing fake), tinted
 * extension chip, size + relative time, and the ingestion-status badge (kept —
 * critical operational info the click dummy lacks).
 */
function FileCard({
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
  const t = useTranslations('files')
  const ext = fileExtensionLabel(file.filename)
  const isFailed = file.status === 'failed'
  const failureReason = isFailed ? file.errorMessage || t('preview.ingestionFailedGeneric') : undefined

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      data-testid="file-card"
      className={cn(
        'group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-2xs transition-shadow duration-200 ease-out hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'ring-2 ring-ring'
      )}
    >
      {/* Thumbnail header — real thumbnail if available, otherwise SVG sketch.
          The ingestion-status badge (kept — the dummy lacks it) rides quietly
          in the top-right corner. */}
      <div className="relative h-24 w-full shrink-0 overflow-hidden border-b bg-card md:h-[132px]">
        <ThumbnailWithFallback file={file} />
        <DocumentStatusBadge
          status={file.status}
          className="absolute right-2 top-2 border-transparent bg-background/80 px-1.5 py-0 text-[10px] font-medium leading-4 shadow-2xs backdrop-blur-sm"
        />
      </div>

      {/* Body */}
      <div className="flex w-full flex-1 flex-col px-3.5 pb-[13px] pt-3">
        <p className="truncate text-[12.5px] font-medium text-foreground" title={file.filename}>
          {file.filename}
        </p>
        {match ? (
          // Semantic result: show WHY it matched (snippet + page + relevance)
          // rather than the generic one-line summary.
          <SemanticMatch snippet={match.snippet} page={match.page} score={match.score} />
        ) : isFailed ? (
          <p className="mt-[3px] line-clamp-2 text-[11.5px] leading-[1.45] text-destructive" title={failureReason}>
            {failureReason}
          </p>
        ) : (
          file.summary && (
            <p className="mt-[3px] line-clamp-2 text-[11.5px] leading-[1.45] text-muted-foreground" title={file.summary}>
              {file.summary}
            </p>
          )
        )}
        <div className="mt-auto flex min-w-0 items-center gap-[7px] pt-[9px] text-[11px] text-muted-foreground/80">
          {ext !== '' && (
            <span
              className="inline-flex shrink-0 items-center rounded px-1.5 py-[2.5px] text-[9px] font-bold uppercase leading-none tracking-[0.04em]"
              style={extChipTint(ext)}
            >
              {ext}
            </span>
          )}
          <span className="min-w-0 truncate tabular-nums" title={formatAbsoluteTime(file.createdAt, locale)}>
            {formatFileSize(file.fileSize, locale)} · {formatRelativeTime(file.createdAt, locale)}
          </span>
        </div>
      </div>
    </button>
  )
}

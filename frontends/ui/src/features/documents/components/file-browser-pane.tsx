'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { FileItem, FolderItem } from './project-file-workspace'
import { Search, FolderOpen, UploadCloud, X } from 'lucide-react'
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
}: FileBrowserPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [search, setSearch] = useState('')

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
      {/* Search bar */}
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2.5 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('browser.searchPlaceholder')}
            aria-label={t('browser.searchLabel')}
            className="pl-8 pr-8"
          />
          {search !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('browser.resetSearch')}
              className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Top-level folder quick filter — chip presentation of the same folder
          selection the sidebar tree drives (no separate navigation model). */}
      {onSelectFolder && topLevelFolders.length > 0 && (
        <div
          className="flex items-center gap-1.5 overflow-x-auto border-b px-4 py-2"
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

      {/* Card grid */}
      {filteredFiles.length === 0 ? (
        <div className="p-8">
          <EmptyState
            variant="bare"
            icon={Search}
            title={t('browser.noMatch', { query: search })}
            description={t('browser.noMatchDescription')}
            action={
              <Button variant="outline" size="sm" onClick={() => setSearch('')}>
                {t('browser.clearSearch')}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
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
        'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
}: {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
}) {
  const t = useTranslations('files')
  const kind = inferDocumentKind(file)
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
      </div>
    </button>
  )
}

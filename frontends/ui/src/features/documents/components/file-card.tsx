'use client'

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { FileItem } from './project-file-workspace'
import { motion, springSnappy } from '@/components/motion'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { sourceTint } from '@/lib/ui/source-tint'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { DocumentStatusBadge } from './document-status'
import { SemanticMatch } from './semantic-match'
import { Skeleton } from '@/components/ui/skeleton'

/** Provenance tint per corpus, from the shared `--source-*` token family. */
const SOURCE_TINT: Record<'projekt' | 'buero', CSSProperties> = {
  projekt: sourceTint('project'),
  buero: sourceTint('office'),
}

/** Thumbnail request lifecycle for a single card. */
type ThumbState = 'loading' | 'ready' | 'none' | 'error'

/**
 * Module-level de-dup cache — one thumbnail resolution per file id for the page
 * lifetime, mirroring the `indexCache` pattern in `use-surfaced-documents`. It
 * stops the request thrashing when a card's file object is remapped each render.
 * A genuine failure rejects and is evicted so a later mount can retry; a
 * resolved "no thumbnail" (null url) stays cached.
 */
const thumbnailCache = new Map<string, Promise<string | null>>()

/** Test hook — clears the module cache between specs. */
export const resetThumbnailCache = (): void => {
  thumbnailCache.clear()
}

/**
 * Resolve a file's thumbnail url. `/api/documents/{id}/thumbnail` returns 200
 * with `{ url: null }` (or 404) when no thumbnail exists — that's NOT a failure,
 * it resolves to `null`. Any other non-ok status (5xx, network) rejects into the
 * genuine-error state so the card can tell "no thumbnail" from "failed to load".
 */
function loadThumbnail(fileId: string): Promise<string | null> {
  const existing = thumbnailCache.get(fileId)
  if (existing) return existing
  const promise = fetch(`/api/documents/${fileId}/thumbnail`)
    .then((r) => {
      if (!r.ok) {
        if (r.status === 404) return null
        throw new Error(`thumbnail ${r.status}`)
      }
      return r.json()
    })
    .then((data) => (data && typeof data.url === 'string' ? data.url : null))
  // Evict a rejected resolution so a later mount can retry (successes stay cached).
  promise.catch(() => thumbnailCache.delete(fileId))
  thumbnailCache.set(fileId, promise)
  return promise
}

/**
 * Lazy-load the thumbnail image for a file card. While the request is in flight
 * a skeleton shows (never a jump straight to the fallback). When no thumbnail
 * exists it falls back to a WARM, content-aware placeholder — an image gets a
 * soft tile + format chip, never a lone glyph that mimics a broken image. Only a
 * GENUINE failure (5xx / network / broken image url) shows a distinct
 * "couldn't load" treatment. The route is scope-aware, so this serves both
 * project uploads and Büroarchiv documents by id.
 */
export function ThumbnailWithFallback({ file }: { file: FileItem }) {
  const t = useTranslations('files')
  const kind = inferDocumentKind(file)
  const canHaveThumbnail = file.contentType === 'application/pdf' || (file.contentType ?? '').startsWith('image/')
  const [state, setState] = useState<ThumbState>(canHaveThumbnail ? 'loading' : 'none')
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!canHaveThumbnail) {
      setState('none')
      return
    }
    let cancelled = false
    setState('loading')
    loadThumbnail(file.id)
      .then((url) => {
        if (cancelled) return
        if (url) {
          setImgUrl(url)
          setState('ready')
        } else {
          setState('none')
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [file.id, canHaveThumbnail])

  if (state === 'ready' && imgUrl) {
    return (
      <img
        src={imgUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        // A url that resolves but won't render is a genuine failure, not "no thumbnail".
        onError={() => setState('error')}
      />
    )
  }

  if (state === 'loading') {
    return <Skeleton className="absolute inset-0 h-full w-full rounded-none" data-testid="thumbnail-skeleton" />
  }

  const ext = fileExtensionLabel(file.filename)
  return (
    <DocumentKindThumbnail
      kind={kind}
      variant="fill"
      formatLabel={ext || t('thumbnail.image')}
      failed={state === 'error'}
      failedLabel={t('thumbnail.unavailable')}
    />
  )
}

export interface FileCardProps {
  file: FileItem
  isSelected: boolean
  onSelect: () => void
  locale: string
  /** Present on a semantic/surfaced result: the snippet + page + score to show WHY it matched. */
  match?: { snippet: string; page: number | null; score: number }
  /** Coarse corpus for a provenance chip in the metadata row (project vs Büroarchiv). */
  source?: 'projekt' | 'buero' | null
  /** Localized label for the provenance chip. */
  sourceLabel?: string
  /** Hide the ingestion-status badge when the document is `ready` (noise in a
   * discovery context where every surfaced document is already ingested). */
  hideStatusWhenReady?: boolean
  /** Accessible label for the click action (defaults to the filename content). */
  ariaLabel?: string
  /** Dim + progress cursor while an action (e.g. opening) resolves. */
  isBusy?: boolean
  /** Extra footer content on the left of the size · time strip. */
  footerLead?: ReactNode
  /** Override the card's test id (e.g. the Archiv surface keeps its own). */
  testId?: string
}

/**
 * One document card in the raised "project-selector" anatomy: a white content
 * block (thumbnail, provenance/extension chips, name, one-line description or
 * match evidence) sitting proud of a subtle outer surface, a footer tab with
 * size · time, and a spring hover-lift. Shared by the Files browser and the chat
 * `document_grid` surfacing card so documents look identical everywhere, and
 * mirrors `ProjectCard` / the Archiv library card.
 */
export function FileCard({
  file,
  isSelected,
  onSelect,
  locale,
  match,
  source,
  sourceLabel,
  hideStatusWhenReady,
  ariaLabel,
  isBusy,
  footerLead,
  testId = 'file-card',
}: FileCardProps) {
  const t = useTranslations('files')
  const ext = fileExtensionLabel(file.filename)
  const isFailed = file.status === 'failed'
  const failureReason = isFailed ? file.errorMessage || t('preview.ingestionFailedGeneric') : undefined
  const showStatus = !!file.status && !(hideStatusWhenReady && file.status === 'ready')

  return (
    <motion.div
      className="h-full min-w-0"
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      transition={springSnappy}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={ariaLabel}
        aria-busy={isBusy}
        data-testid={testId}
        className={cn(
          'group relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border bg-muted/50 text-left shadow-xs transition-shadow duration-200 ease-out hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
          isSelected && 'ring-2 ring-ring',
          isBusy && 'cursor-progress opacity-70'
        )}
      >
        {/* Raised inner block — white surface, rounded bottom, soft divider shadow. */}
        <div className="w-full overflow-hidden rounded-b-[10px] bg-card shadow-xs">
          <div className="relative h-[124px] w-full overflow-hidden border-b bg-card">
            <ThumbnailWithFallback file={file} />
            {showStatus && (
              <DocumentStatusBadge
                status={file.status}
                className="absolute right-2 top-2 border-transparent bg-background/80 px-1.5 py-0 text-[10px] font-medium leading-4 shadow-2xs backdrop-blur-sm"
              />
            )}
          </div>

          <div className="px-3.5 pb-3 pt-[11px]">
            <div className="flex items-center gap-2">
              {source && sourceLabel && (
                <span
                  className="inline-flex shrink-0 items-center rounded-[6px] px-2 py-[3px] text-[10.5px] font-semibold leading-none tracking-[0.02em]"
                  style={SOURCE_TINT[source]}
                >
                  {sourceLabel}
                </span>
              )}
              <span className="flex-1" />
              {ext !== '' && (
                <span
                  className="inline-flex shrink-0 items-center rounded px-1.5 py-[2.5px] text-[9px] font-bold uppercase leading-none tracking-[0.04em]"
                  style={extChipTint(ext)}
                >
                  {ext}
                </span>
              )}
            </div>

            <p className="mt-[10px] truncate text-[12.5px] font-medium leading-[1.4] text-foreground" title={file.filename}>
              {file.filename}
            </p>
            {match ? (
              <SemanticMatch snippet={match.snippet} page={match.page} score={match.score} />
            ) : isFailed ? (
              <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.45] text-destructive" title={failureReason}>
                {failureReason}
              </p>
            ) : (
              file.summary && (
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.45] text-muted-foreground" title={file.summary}>
                  {file.summary}
                </p>
              )
            )}
          </div>
        </div>

        {/* Footer tab on the subtle outer surface: optional lead + size · time. */}
        <div className="flex w-full items-center gap-1.5 px-3.5 pb-2.5 pt-[9px] text-[11px] text-muted-foreground/80">
          {footerLead ?? <span className="flex-1" />}
          <span className="shrink-0 tabular-nums">{formatFileSize(file.fileSize, locale)}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <time
            dateTime={file.createdAt}
            title={formatAbsoluteTime(file.createdAt, locale)}
            suppressHydrationWarning
            className="shrink-0 tabular-nums"
          >
            {formatRelativeTime(file.createdAt, locale)}
          </time>
        </div>
      </button>
    </motion.div>
  )
}

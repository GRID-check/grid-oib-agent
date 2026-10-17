'use client'

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import Image from 'next/image'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import { isOfficeRenditionSource } from '@/lib/documents/preview-types'
import type { FileItem } from './project-file-workspace'
import { formatBytes } from '@/lib/format'
import { TimeAgo } from '@/components/ui/time-ago'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { documentDragProps } from '../hooks/use-document-drag'
import { sourceTint } from '@/lib/ui/source-tint'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { AuthorshipLine } from './authorship-line'
import { SourceDeletedNote } from '@/components/projects/source-deleted-note'
import { DocumentVersionStateBadge } from './document-version-badge'
import { FassungCount, OlderFassungBadge, isOlderFassungEntry } from './fassung-badge'
import { fassungCount } from '../lib/fassung-chain'
import { DocumentStatusBadge, isCitableStatus, isSettlingStatus } from './document-status'
import { SemanticMatch } from './semantic-match'
import { useIngestFailureText } from './ingest-failure-notice'
import { GridTileBody, GridTileFooter, GridTileMedia, GridTileShell } from './grid-tile'
import { FilingSuggestionSlot, useFilingHighlighted } from './filing-suggestion'
import { HIGHLIGHT_OUTLINE } from '@/components/ui/highlight'
import { Check } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { FileName } from './file-name'
import { OpenMarksChip } from './open-marks-chip'

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
 * resolved "no thumbnail" (null url) stays cached — unless the document was
 * still being read when we asked (see {@link loadThumbnail}).
 */
const thumbnailCache = new Map<string, { url: Promise<string | null>; expiresAtMs?: number }>()

/**
 * How long before a signed url's `exp` it stops being handed out: a card that
 * mounts must still be able to fetch it.
 */
const EXPIRY_MARGIN_MS = 60_000

/**
 * When a signed image url stops working, from its `exp` (seconds), or
 * undefined for a url that carries none (a presigned object-store fallback).
 *
 * The cache used to keep a resolved url for the page's lifetime, but a signed
 * url lives an hour or two. A tab left open replayed urls that had expired days
 * earlier (#366: `exp` of Sep 8, requested Sep 18). The route answered 403
 * with a JSON body, and Next's image optimizer, which never looks at the
 * status, logged "isn't a valid image" for it.
 */
export function signedUrlExpiresAtMs(url: string): number | undefined {
  const exp = Number(new URL(url, 'http://relative.invalid').searchParams.get('exp'))
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
}

/** Test hook — clears the module cache between specs. */
export const resetThumbnailCache = (): void => {
  thumbnailCache.clear()
}

/**
 * Resolve a file's thumbnail url. `/api/documents/{id}/thumbnail` returns 200
 * with `{ url: null }` (or 404) when no thumbnail exists — that's NOT a failure,
 * it resolves to `null`. Any other non-ok status (5xx, network) rejects into the
 * genuine-error state so the card can tell "no thumbnail" from "failed to load".
 *
 * `provisional` marks a document that is still being ingested. "No thumbnail"
 * is then an answer about right now, not about the file: the page render lands
 * during ingestion, so a card that asked a second too early would otherwise keep
 * the sketch placeholder for the whole page lifetime and only show the real
 * preview after a reload. Such a miss is evicted so the re-ask that follows the
 * status transition actually reaches the route.
 */
function loadThumbnail(fileId: string, provisional = false): Promise<string | null> {
  const existing = thumbnailCache.get(fileId)
  if (existing && !(existing.expiresAtMs !== undefined && Date.now() >= existing.expiresAtMs - EXPIRY_MARGIN_MS)) {
    return existing.url
  }
  const entry: { url: Promise<string | null>; expiresAtMs?: number } = { url: Promise.resolve(null) }
  const promise = fetch(`/api/documents/${fileId}/thumbnail`)
    .then((r) => {
      if (!r.ok) {
        if (r.status === 404) return null
        throw new Error(`thumbnail ${r.status}`)
      }
      return r.json()
    })
    .then((data) => (data && typeof data.url === 'string' ? data.url : null))
    .then((url) => {
      if (url === null && provisional) thumbnailCache.delete(fileId)
      if (url) entry.expiresAtMs = signedUrlExpiresAtMs(url)
      return url
    })
  // Evict a rejected resolution so a later mount can retry (a success stays
  // cached until its signature expires).
  promise.catch(() => thumbnailCache.delete(fileId))
  entry.url = promise
  thumbnailCache.set(fileId, entry)
  return promise
}

/**
 * Lazy-load the thumbnail image for a file card. While the request is in flight
 * a skeleton shows (never a jump straight to the fallback). When no thumbnail
 * exists it falls back to a WARM, content-aware placeholder — an image gets a
 * soft tile + format chip, never a lone glyph that mimics a broken image. Only a
 * GENUINE failure (5xx / network / broken image url) shows a distinct
 * "couldn't load" treatment. The route is scope-aware, so this serves both
 * project uploads and Büroablage documents by id.
 *
 * `visible` false holds the request (and the skeleton) until the card has been
 * on screen: a folder of two thousand documents asked for two thousand
 * thumbnails on open, nearly all for cards nobody had scrolled to. Absent
 * means asked at once, for a surface that only ever shows a handful.
 */
export function ThumbnailWithFallback({ file, visible = true }: { file: FileItem; visible?: boolean }) {
  const t = useTranslations('files')
  const kind = inferDocumentKind(file)
  // Office files too: ingest renders their `_thumb.jpg` from the PDF rendition
  // (ADR-0070). One uploaded before that, or with conversion off, has none, and
  // the route answers `{ url: null }` — the kind sketch below, not a failure.
  const canHaveThumbnail =
    file.contentType === 'application/pdf' ||
    (file.contentType ?? '').startsWith('image/') ||
    isOfficeRenditionSource(file)
  const [state, setState] = useState<ThumbState>(canHaveThumbnail ? 'loading' : 'none')
  const [imgUrl, setImgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!canHaveThumbnail) {
      setState('none')
      return
    }
    // Off screen so far: stay the skeleton, ask once the card is seen.
    if (!visible) return
    let cancelled = false
    setState('loading')
    loadThumbnail(file.id, isSettlingStatus(file.status))
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
    // `file.status` is a dependency, not noise: it is the signal that a document
    // which had no preview when the page loaded has finished being read, and so
    // the moment to ask the route again.
  }, [file.id, canHaveThumbnail, file.status, visible])

  if (state === 'ready' && imgUrl) {
    return (
      // `fill` against the card's positioned thumbnail well: the URL announces
      // no intrinsic dimensions, and this is the shape next/image gives you for
      // that — it supplies the inset-0 sizing the plain tag used to spell out by
      // hand. `sizes` describes the card's well so the optimizer picks a width
      // for it rather than assuming the viewport.
      //
      // The thumbnail route hands back a same-origin signed path, which is what
      // makes it optimizable at all; `unoptimized` covers the fallback to a
      // presigned object-store URL when signing is unavailable.
      <Image
        src={imgUrl}
        alt=""
        fill
        sizes="(min-width: 1280px) 240px, (min-width: 768px) 33vw, 50vw"
        unoptimized={!isOptimizerEligible(imgUrl)}
        className="object-cover"
        // A url that resolves but won't render is a genuine failure, not "no thumbnail".
        onError={() => {
          // …but the URL itself may be stale rather than the document imageless
          // (a thumbnail object replaced after we resolved it): evict it so a
          // later mount re-resolves instead of replaying the same poisoned URL
          // on every remount (#366, #395).
          thumbnailCache.delete(file.id)
          setState('error')
        }}
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
  /** Coarse corpus for a provenance chip in the metadata row (project vs Büroablage). */
  source?: 'projekt' | 'buero' | null
  /** Localized label for the provenance chip. */
  sourceLabel?: string
  /** Accessible label for the click action (defaults to the filename content). */
  ariaLabel?: string
  /** Dim + progress cursor while an action (e.g. opening) resolves. */
  isBusy?: boolean
  /** Extra footer content on the left of the size · time strip. */
  footerLead?: ReactNode
  /** Drop the size · time footer (chat surfacing — Files-browser chrome). */
  hideFooter?: boolean
  /** Override the card's test id (e.g. the Archiv surface keeps its own). */
  testId?: string
  /**
   * Rename / delete / download, rendered on the card so the reader does not
   * have to open the preview to act on a file (#435). Must be a control of
   * its own — this card is a `<button>`, so the slot sits beside it.
   */
  actions?: ReactNode
  /**
   * Let this card be dragged onto a folder. Off by default: a card that lifts
   * under the finger where nothing can receive it promises a move the surface
   * cannot make — the Archiv, for one, has no folders at all.
   */
  draggable?: boolean
  /**
   * The listing is in selection mode: the card is picked or not, a press
   * toggles it (the caller's `onSelect`), the ⋯ steps aside and nothing drags.
   * Absent is the ordinary card.
   */
  selection?: { checked: boolean }
}

/**
 * The tick on a card in selection mode, where the ⋯ was. Ink when picked, a
 * hollow ring when not: shape and fill, never colour alone, and the card is the
 * target, so the mark is not a control of its own (`pointer-events-none`).
 */
function SelectionMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute right-2 top-2 z-[1] flex size-6 items-center justify-center rounded-full border shadow-2xs transition-colors duration-quick ease-out motion-reduce:transition-none',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background/90'
      )}
      data-testid="file-card-check"
      data-checked={checked ? '' : undefined}
    >
      {checked && <Check className="size-3.5" strokeWidth={3} />}
    </span>
  )
}

/**
 * One document card in the raised "project-selector" anatomy: a white content
 * block (thumbnail, provenance/extension chips, name, one-line description or
 * match evidence) sitting proud of a subtle outer surface, a footer tab with
 * size · time, and a spring hover-lift. Shared by the Files browser and the chat
 * `document_grid` surfacing card. Chat passes {@link FileCardProps.hideFooter}
 * and no {@link FileCardProps.match} — ranking chrome stays in Files search.
 *
 * Memoised: the Files grid holds thousands of these and re-renders on every
 * poll and selection. The thumbnail is asked for once the card has been on
 * screen (`useSeenOnce`), not on mount.
 */
export const FileCard = memo(function FileCard({
  file,
  isSelected,
  onSelect,
  locale,
  match,
  source,
  sourceLabel,
  ariaLabel,
  isBusy,
  footerLead,
  hideFooter,
  testId = 'file-card',
  actions,
  draggable = false,
  selection,
}: FileCardProps) {
  const t = useTranslations('files')
  const name = documentDisplayName(file)
  const ext = fileExtensionLabel(file.filename)
  const isFailed = file.status === 'failed'
  const failureText = useIngestFailureText(isFailed ? file.errorMessage : null)
  // The card is one click target, so it carries no disclosure: the sentence
  // shows, the stored text is the tooltip, and the preview pane has „Details".
  const failureReason = isFailed ? (failureText?.sentence ?? t('ingestFailure.unknown')) : undefined
  // A badge only when the document is NOT simply citable — being read, failed,
  // held, never indexed. „Zitierbar" is the normal state; on every card it was
  // a status nobody browsing a folder was asking about. The list view's status
  // column is where every document's state is spelled out.
  const showStatus = !!file.status && !isCitableStatus(file.status)
  // The AI summary is the last thing ingestion produces, so a document that is
  // still being read has an empty description slot. Left blank it reads as a
  // card that failed to render; skeleton lines say the sentence is on its way —
  // the same promise the thumbnail well makes while its request is in flight.
  const isAwaitingSummary = !match && !isFailed && !file.summary && isSettlingStatus(file.status)
  const [mediaRef, seen] = useSeenOnce<HTMLDivElement>()
  // A filing decision in view would move this file: outlined, nothing else, so the tile keeps its size.
  const lit = useFilingHighlighted(file.id)

  return (
    <GridTileShell
      interactive
      className={cn(
        'group/card',
        (isSelected || selection?.checked) && 'ring-2 ring-ring shadow-md',
        isBusy && 'cursor-progress opacity-70',
        !isSelected && 'hover:border-border/80',
        lit && HIGHLIGHT_OUTLINE
      )}
      // Dragging is opt-in per surface: the Archiv has no folders to drop into,
      // and a card that lifts under the finger where nothing can receive it is
      // an affordance for a capability that is not there.
      {...(draggable && !selection ? documentDragProps(file.id, file.folderId ?? null) : {})}
    >
      {selection && <SelectionMark checked={selection.checked} />}
      {actions && !selection && (
        <div
          className="absolute right-1.5 top-1.5 z-[1] pointer-coarse:opacity-100 md:opacity-0 md:group-hover/card:opacity-100 group-focus-within/card:opacity-100 has-[[data-state=open]]:opacity-100 transition-opacity duration-quick ease-out motion-reduce:transition-none"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      )}
      {/* `aria-current`, not `aria-pressed`: pressing this OPENS the file, it
          does not toggle anything. The card used to close the preview when you
          clicked the row you were already looking at — the one surface in the
          product that did — and `aria-pressed` was at least honest about that.
          The behaviour was the bug; a row opens, and closing is the overlay's
          job. `aria-current` says the remaining true thing: this is the one on
          screen. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={isSelected && !selection ? 'true' : undefined}
        aria-pressed={selection ? selection.checked : undefined}
        aria-label={ariaLabel}
        aria-busy={isBusy}
        data-testid={testId}
        className="group relative flex w-full min-w-0 flex-1 flex-col overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {/* Raised inner block — white surface, rounded bottom, soft divider shadow.
            `flex-1` because a grid row is only as tall as its tallest card and
            every cell stretches to match: a document that is still being read has
            no summary yet, so without it the short tile kept its natural height,
            its size · time footer floated in the middle of the cell, and the
            leftover height showed as a band of dead surface underneath. Growing
            the white block instead puts every footer on the bottom edge, so the
            row reads as one strip whatever each card carries above it. */}
        <GridTileBody className={cn('flex-1 p-0', hideFooter && 'rounded-none')}>
          <GridTileMedia ref={mediaRef} className="h-[124px]">
            <ThumbnailWithFallback file={file} visible={seen} />
            {showStatus && (
              <DocumentStatusBadge
                status={file.status}
                queueAhead={file.queueAhead}
                // At the foot of the thumbnail, not the head: the sketch drawn when
                // there is no picture puts its title bar at the top, and a badge
                // there read as part of the placeholder rather than as a status.
                // The 80% alpha is load-bearing: this badge floats over a document
                // thumbnail, and with `backdrop-blur-sm` it frosts the image
                // underneath instead of hiding it. Every status's ink is its
                // signal colour on a light ground, a failed read included
                // (the badge's tinted `danger`), so the frost needs no repaint.
                // Capped at the well's width less its insets: on a phone's
                // two-column grid „Wartet · 3 Dateien davor" ran into the
                // card's edge; now its word ends in an ellipsis instead.
                className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] border-transparent bg-background/80 px-1.5 py-0 text-xs font-medium leading-4 shadow-2xs backdrop-blur-sm"
              />
            )}
          </GridTileMedia>

          <div className="px-3.5 pb-3 pt-[11px] phone:px-2.5">
            <div className="flex items-center gap-2">
              {source && sourceLabel && (
                <span
                  className="inline-flex shrink-0 items-center rounded-sm px-2 py-[3px] text-xs font-semibold leading-none tracking-[0.02em]"
                  style={SOURCE_TINT[source]}
                >
                  {sourceLabel}
                </span>
              )}
              <span className="flex-1" />
              {ext !== '' && (
                <span
                  className="inline-flex shrink-0 items-center rounded-sm px-1.5 py-[2.5px] text-[10.5px] font-bold uppercase leading-none tracking-wider"
                  style={extChipTint(ext)}
                >
                  {ext}
                </span>
              )}
            </div>

            {/* The name the document goes by. The format chip beside it still
                comes from the FILE name, because that is what the bytes are —
                a rename changes the label, never the format. */}
            {/* Cut in the MIDDLE: the revision and the drawing number are the end of the name, and a finger has no tooltip to read the rest. */}
            <p className="mt-[10px] min-w-0 text-xs font-medium leading-[1.4] text-foreground">
              <FileName text={name} />
            </p>
            {/* A byline, directly under the name — who WROTE this. It is not in
                the footer, because the footer is where the faces and the word
                `Unvergeben` live and that slot answers a different question:
                who is responsible for it. */}
            <AuthorshipLine authoredBy={file.authoredBy} className="mt-0.5" />
            {file.sourceDeletedAt && <SourceDeletedNote at={file.sourceDeletedAt} className="mt-0.5" />}
            {/* The editorial state, on the same side as the byline and nowhere
                near the footer, for exactly that reason: „freigegeben" is a
                statement about the CONTENT and „Unvergeben" one about
                responsibility (ADR-0047's addendum, ADR-0054). Silent without a
                history: one version distinguishes nothing, so the badge appears
                only once a second version exists — even for a draft Piloti wrote. */}
            {/* An older Fassung says that and only that: „Ersetzt" beside it
                was the same fact twice, without saying by what. A current one
                carries its approval state and, after it as quiet text rather
                than a second badge, „3 Fassungen": the history is not a state.
                On a 220px card the count beside the name cut the name in half,
                so here it rides on this line; the list puts it by the name. */}
            {isOlderFassungEntry(file) ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <OlderFassungBadge file={file} />
              </div>
            ) : (
              ((file.versionCount ?? 0) > 1 || fassungCount(file) > 1) && (
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {(file.versionCount ?? 0) > 1 && (
                    <DocumentVersionStateBadge
                      versionState={file.versionState}
                      versionCount={file.versionCount}
                      authoredBy={file.authoredBy}
                    />
                  )}
                  <FassungCount file={file} />
                </div>
              )
            )}
            {match ? (
              <SemanticMatch snippet={match.snippet} page={match.page} score={match.score} />
            ) : isFailed ? (
              <p
                className="mt-1 line-clamp-2 text-xs leading-[1.45] text-destructive"
                title={failureText?.raw ?? failureReason}
                data-testid="file-card-failure"
              >
                {failureReason}
              </p>
            ) : isAwaitingSummary ? (
              // Two bars on the two lines the summary will occupy. Decorative:
              // the badge beside the thumbnail already says "Processing" in
              // words, and a screen reader should hear that once, not twice.
              <div className="mt-[7px] space-y-[7px]" aria-hidden data-testid="file-card-summary-skeleton">
                <Skeleton className="h-[7px] w-full rounded-sm" />
                <Skeleton className="h-[7px] w-[58%] rounded-sm" />
              </div>
            ) : (
              file.summary && (
                <p className="mt-1 line-clamp-2 text-xs leading-[1.45] text-muted-foreground" title={file.summary}>
                  {file.summary}
                </p>
              )
            )}
          </div>
        </GridTileBody>
      </button>
      {/* The footer is the button's sibling, not its child: it carries
          Piloti's filing chip, a button of its own, on the left, and a button
          cannot hold a button. A click on the rest of it opens the file as the
          card does; the keyboard opens it through the card's button.
          Its height is the same with a chip or without one (the chip's margin
          box is a line of text), so a row of tiles stays even when a
          suggestion arrives or goes. On a narrow tile the chip's folder name
          ellipsizes first, then the relative time drops; it never wraps. */}
      {!hideFooter && (
        <GridTileFooter
          onClick={onSelect}
          className="@container/foot group/foot cursor-pointer justify-between gap-1.5 px-3.5 pb-2.5 pt-[9px] text-xs text-muted-foreground/80 phone:px-2.5"
          data-testid="file-card-footer"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <FilingSuggestionSlot documentId={file.id} className="min-w-[4.5rem]" />
            {footerLead}
          </span>
          {/* On a 156px card the size and the age are about 125px, so the
              phone's card keeps 10px of padding (the title's too) and a tighter
              gap: the age used to run into the edge the title keeps clear. */}
          <span className="flex shrink-0 items-center gap-1.5 phone:gap-1">
            {/* What is still open on its pages, and the way into them: the
                review opens from here without opening the card first. */}
            <OpenMarksChip file={file} name={name} />
            {/* With the chip in, a narrow tile drops the size too: the
                filing chip's minimum, the marks and the size do not fit 156px. */}
            <span className="tabular-nums group-has-[[data-slot=open-marks]]/foot:@max-[14rem]/foot:hidden">
              {formatBytes(file.fileSize, locale)}
            </span>
            <span className="flex items-center gap-1.5 phone:gap-1 group-has-[[data-slot=filing-chip]]/foot:@max-[14rem]/foot:hidden group-has-[[data-slot=open-marks]]/foot:@max-[14rem]/foot:hidden">
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <TimeAgo date={file.createdAt} locale={locale} className="tabular-nums" />
            </span>
          </span>
        </GridTileFooter>
      )}
    </GridTileShell>
  )
})

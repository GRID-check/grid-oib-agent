'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { AlertCircle, Check, ChevronDown, RotateCcw, ShieldAlert, WifiOff, X } from 'lucide-react'
import { mayRetryUpload, type TrackedFile } from '../types'
import {
  isDeterminate,
  summarizeTransfer,
  uploadPercent,
  uploadPhase,
  type TransferSummary,
  type UploadPhase,
} from '../lib/upload-progress'
import { useElapsedSeconds, useTransferRate } from '../hooks/use-transfer-rate'
import { FileExtChip } from './file-ext-chip'
import { IngestionStatusWord, ingestionMarkOfPhase } from './ingestion-atoms'
import { IngestFailureNotice } from './ingest-failure-notice'
import { HeldUploadReason } from './held-upload-reason'
import { RequestReviewButton } from './request-review-button'
import { quarantineVerdictOf } from '@/lib/upload-screening/quarantine'
import { failedWhileReading } from '../lib/ingest-failure'
import { Button } from '@/components/ui/button'
import { AnimatePresence, iconSwapTransition, motion, motionBase, useMotionToken } from '@/components/motion'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes, formatDurationShort, formatTransferRate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FilingSuggestionSlot, useFilingHighlighted } from './filing-suggestion'
import { FilingViewBar } from './filing-bar'
import { HIGHLIGHT_OUTLINE_INSET } from '@/components/ui/highlight'

/**
 * The upload surface.
 *
 * What it replaces was a flat list under a bar that read
 * `progress > 0 ? progress : 15` — a literal constant standing in for a
 * measurement nobody had taken. It sat at 15% for the whole upload and then at
 * whatever the ingest job had last reported for the whole indexing pass, which
 * is why it "always got stuck on the same thing".
 *
 * The rule this surface is built on: **a percentage is only ever drawn for
 * bytes actually in flight.** Everything else — waiting for a slot, waiting for
 * the backend to read a document — is shown as motion plus an elapsed time.
 * That is not a smaller promise, it is the true one, and it is the difference
 * between a user who trusts the number and a user who has learned to ignore it.
 *
 * The batch bar tracks BYTES rather than file count, because a batch is usually
 * one enormous model and a dozen small PDFs, and a count-based bar would leap
 * to 92% and then appear to hang for a minute.
 */

interface UploadTrayProps {
  files: TrackedFile[]
  onRetry: (id: string) => void
  /** Abort one in-flight upload. Omitted where cancellation is not wired up. */
  onCancel?: (id: string) => void
  /** Abort everything still in flight. */
  onCancelAll?: () => void
  /** Take rows off the tray. Dismissing a NOTICE — never a document delete. */
  onDismiss?: (ids: string[]) => void
}

/** Phases that belong on a live upload surface. */
const VISIBLE_PHASES = new Set<UploadPhase>([
  'queued',
  'uploading',
  'processing',
  'ready',
  'held',
  'stored',
  'failed',
  'canceled',
])

/**
 * How long a wholly successful batch keeps its summary before retiring itself.
 *
 * Success should be confirmed and then get out of the way; a panel announcing
 * "12 documents added" an hour later is clutter the user has to clear by hand.
 * A batch with anything failed, held or canceled in it never auto-retires —
 * those rows carry an action or a reason, and dismissing one unread would lose
 * it. A held file in particular says why it was held, and the uploader is the
 * one person who can ask for it to be let through.
 */
const SUCCESS_LINGER_MS = 6_000

/** Characters of a file name kept whole at its end: `_Rev_C_Freigabe.pdf`. */
const ROW_NAME_TAIL = 20

/**
 * Whether the browser believes it has a connection. `navigator.onLine` is only
 * a belief (a captive portal reads as online), but its one confident answer is
 * the useful one: `false` means the radio is off or out of range, and a tray
 * that says „Wird hochgeladen" over a dead link is the lie this exists to end.
 * The server snapshot is online, so the first paint never flashes the notice.
 */
function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}
const readOnline = (): boolean => navigator.onLine
const serverOnline = (): boolean => true

function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, readOnline, serverOnline)
}

export function UploadTray({ files, onRetry, onCancel, onCancelAll, onDismiss }: UploadTrayProps) {
  // Height and opacity are not covered by MotionConfig's reduced motion.
  const foldTransition = useMotionToken(motionBase)
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [isExpanded, setIsExpanded] = useState(true)

  const visible = useMemo(() => files.filter((file) => VISIBLE_PHASES.has(uploadPhase(file))), [files])
  const summary = useMemo(() => summarizeTransfer(visible), [visible])
  // The batch's documents, for the filing bar: filing is the job here, so it
  // shows even for one file.
  const documentIds = useMemo(
    () => visible.flatMap((file) => (file.serverFileId ? [file.serverFileId] : [])),
    [visible]
  )

  const isTransferring = summary.stage === 'transferring'
  const isOnline = useOnline()
  // Offline only matters while bytes are meant to be moving.
  const isWaitingForNetwork = isTransferring && !isOnline
  const { bytesPerSecond, etaSeconds } = useTransferRate(summary.uploadedBytes, summary.remainingBytes, isTransferring)

  // When the batch stopped moving bytes and handed over to the backend — the
  // anchor for the elapsed timer that stands in for a percentage nobody has.
  const [processingSince, setProcessingSince] = useState<number | null>(null)
  useEffect(() => {
    setProcessingSince((current) => {
      if (summary.stage === 'processing') return current ?? Date.now()
      return null
    })
  }, [summary.stage])
  const processingElapsed = useElapsedSeconds(processingSince, summary.stage === 'processing')

  const dismissAll = useMemo(() => {
    if (!onDismiss) return undefined
    return () => onDismiss(visible.map((file) => file.id))
  }, [onDismiss, visible])

  /**
   * Whether somebody is currently reading or using the tray.
   *
   * The self-retire above unmounts the whole section. If the pointer is resting
   * on it, a panel disappears from under the cursor and whatever was below jumps
   * up into the click that was already on its way; if the KEYBOARD is in it — on
   * the collapse control, on a row's retry — focus is dropped to the document
   * body, which is the same "you lost your place" bug the preview dialog had.
   * Six seconds is a promise about an unattended panel, not about one being
   * used, so the timer holds while it is and starts over when it is let go.
   */
  const [isHeld, setIsHeld] = useState(false)
  // A tray that empties while the pointer or focus is in it (its own
  // „Ausblenden“) gets no mouseleave or blur from the detached node, so the
  // hold would outlive it and stop the next clean batch from retiring.
  useEffect(() => {
    if (visible.length === 0) setIsHeld(false)
  }, [visible.length])

  const isQuietSuccess =
    summary.isSettled && summary.failed === 0 && summary.held === 0 && summary.canceled === 0
  // The timer reads the latest dismiss through a ref and restarts only when
  // the batch's standing changes, never on a new `files` array. A parent that
  // re-renders the same settled rows (a poll, a store write) used to hand a new
  // `dismissAll` each time, which cleared the timer before it fired, so a clean
  // batch sat on screen until dismissed by hand.
  const dismissAllRef = useRef(dismissAll)
  useEffect(() => {
    dismissAllRef.current = dismissAll
  }, [dismissAll])
  const canRetire = isQuietSuccess && dismissAll !== undefined && !isHeld
  useEffect(() => {
    if (!canRetire) return
    const timer = setTimeout(() => dismissAllRef.current?.(), SUCCESS_LINGER_MS)
    return () => clearTimeout(timer)
  }, [canRetire])

  /**
   * Recovery for the whole batch at once. Three of twelve failing is the common
   * shape of an upload problem (a flaky link, a backend blip), and clearing it
   * one row at a time is work the interface can do on the user's behalf.
   *
   * Failed rows only. A held row is not a failure: the server refuses a
   * re-upload onto it, so retrying it would turn a reason into a 409.
   */
  const retryAll = useMemo(() => {
    const failed = visible.filter((file) => uploadPhase(file) === 'failed' && mayRetryUpload(file))
    if (failed.length === 0) return null
    return () => failed.forEach((file) => onRetry(file.id))
  }, [visible, onRetry])

  const headline = trayHeadline(summary, t)
  const hasHeaderActions =
    (isTransferring && onCancelAll !== undefined) ||
    (summary.isSettled && retryAll !== null) ||
    (summary.isSettled && dismissAll !== undefined)
  const detail = isWaitingForNetwork
    ? t('uploads.detail.offline')
    : trayDetail(summary, { bytesPerSecond, etaSeconds, processingElapsed, locale, t })

  // The tray arrives and leaves as a fold, not a snap: it sits above the
  // listing, and a panel that appears or retires in one frame throws every row
  // below it by the panel's whole height. `initial={false}`: a tray already
  // there on first render (a reload mid-batch) does not animate in.
  return (
    <AnimatePresence initial={false}>
      {visible.length > 0 && (
    // eslint-disable-next-line grid/motion-vocabulary -- the tray's arrival and retirement above the listing, a fold at the reading point; instant under reduced motion
    <motion.section
      key="upload-tray"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={foldTransition}
      aria-label={t('uploads.region')}
      data-testid="upload-tray"
      className="shrink-0 overflow-hidden border-b bg-card"
      onMouseEnter={() => setIsHeld(true)}
      onMouseLeave={() => setIsHeld(false)}
      onFocusCapture={() => setIsHeld(true)}
      // `relatedTarget` is where focus is GOING; a move between two controls
      // inside the tray must not read as leaving it.
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsHeld(false)
      }}
    >
      {/* `flex-wrap`: the settled-with-failures state puts "Retry all",
          "Dismiss all" and the expander in this row, all `shrink-0`, so on a
          phone the summary — which is the only thing that says WHAT happened —
          took what was left of the width. Measured 33px: both its lines
          truncated to an ellipsis while three buttons sat beside them at full
          size. The summary now holds a readable floor and the actions drop to a
          second line when they no longer fit beside it. */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <TrayGlyph summary={summary} offline={isWaitingForNetwork} />

        <button
          type="button"
          onClick={() => setIsExpanded((open) => !open)}
          aria-expanded={isExpanded}
          // `min-h-11` and NOT the `-my-2.5 py-2.5` trick this used to carry.
          // That trick let the button claim the tray's own padding without
          // moving anything, which was right while the row could not wrap — and
          // wrong the moment it could: `flex-wrap` above puts the actions on a
          // second line separated by `gap-3` (12px), and a 10px overhang eats
          // most of that gap, so a tap aimed at "Retry all" lands on the summary
          // instead. A hit box has to stay inside its own flex line.
          className="min-w-40 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        >
          {/* Polite, not assertive: the phase changes two or three times per
              batch and each one is worth hearing, but the byte counter beneath
              it updates every second and must never be announced. */}
          <p aria-live="polite" className="truncate text-sm font-medium leading-tight text-foreground">
            {headline}
          </p>
          {/* Two lines, not one: on a phone the sentence that says why nothing
              is moving („Wird gelesen…", „Keine Verbindung…") is the part that
              was being cut off. */}
          <p aria-hidden className="line-clamp-2 text-xs leading-snug text-muted-foreground tabular-nums">
            {detail}
          </p>
        </button>

        {/* On a phone the actions take a line of their own under the
            headline, and the expander stays beside the headline it folds:
            wrapped in DOM order, it used to land alone on a third line. Even
            one action goes down: „Alle abbrechen" beside the headline's
            160px floor and the expander does not fit 390px, and the
            expander is what wrapped. */}
        {hasHeaderActions && (
          <div className="order-3 flex basis-full items-center justify-end gap-2 sm:order-2 sm:basis-auto">
          {isTransferring && onCancelAll && (
            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onCancelAll}>
              {t('uploads.actions.cancelAll')}
            </Button>
          )}
          {summary.isSettled && retryAll && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              onClick={retryAll}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {t('uploads.actions.retryAll')}
            </Button>
          )}
          {summary.isSettled && dismissAll && (
            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={dismissAll}>
              {t('uploads.actions.dismissAll')}
            </Button>
          )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setIsExpanded((open) => !open)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? t('uploads.actions.collapse') : t('uploads.actions.expand')}
          className="order-2 flex size-7 shrink-0 sm:order-3 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
        >
          <ChevronDown
            className={cn(
              'size-4 transition-transform duration-quick ease-out motion-reduce:transition-none',
              isExpanded && 'rotate-180'
            )}
            aria-hidden
          />
        </button>
      </div>

      {/* Full-bleed batch track, hairline-thin and flush with the divider: it
          reads as a property of the whole panel rather than as another widget
          competing with the rows below. */}
      <TrackBar
        percent={isTransferring ? summary.bytesPercent : null}
        sweeping={summary.stage === 'processing'}
        testId="upload-tray-track"
      />

      {/* Where Piloti would file the batch, one line per target folder. Not
          inside the fold: collapsing the rows does not answer the question. */}
      <FilingViewBar documentIds={documentIds} minFiles={1} className="px-4 pb-1 pt-2.5" />

      <AnimatePresence initial={false}>
        {isExpanded && (
          // eslint-disable-next-line grid/motion-vocabulary -- the tray's own fold, opened by the reader below its header; instant under reduced motion
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            // A tween, not a spring: this is an accordion height, and a spring
            // on a layout property overshoots PAST `auto` and clips the last
            // row on the way in. `grid-design-language.md` §"Fixed
            // choreography" puts height changes on `--motion-base`.
            transition={foldTransition}
            className="max-h-[42dvh] overflow-y-auto overscroll-contain"
          >
            {/* A dismissed row folds away rather than vanishing, so the rows
                under it slide up instead of jumping. */}
            <AnimatePresence initial={false}>
              {visible.map((file) => (
                <UploadRow
                  key={file.id}
                  file={file}
                  onRetry={onRetry}
                  onCancel={onCancel}
                  onDismiss={onDismiss}
                />
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.section>
      )}
    </AnimatePresence>
  )
}

/**
 * The batch's state as one mark.
 *
 * A ring rather than a bar: the header already carries a bar, and the ring says
 * "this whole thing" where the bar says "this much of it". Determinate while
 * bytes move; a rotating arc while the backend reads, which is a shape that
 * cannot be mistaken for a position.
 */
function TrayGlyph({ summary, offline }: { summary: TransferSummary; offline: boolean }) {
  const radius = 8
  const circumference = 2 * Math.PI * radius

  if (summary.isSettled) {
    // Any failure at all takes the mark, even alongside successes. A green
    // check over "1 added · 1 failed" is the glyph contradicting the sentence
    // beside it, and the glyph is what gets read at a glance. A held file
    // takes it next, in the warning colour: nothing failed, but the batch is
    // not done either while somebody has to look at one of its files.
    const hasFailure = summary.failed > 0
    const hasHeld = !hasFailure && summary.held > 0
    return (
      <span
        aria-hidden
        data-testid="upload-tray-glyph"
        data-tone={hasFailure ? 'destructive' : hasHeld ? 'warning' : 'success'}
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          // The mark lands rather than appears: a short rise from the ring's
          // size, so "done" is something that happened. Still under reduced motion.
          'animate-in zoom-in-75 fade-in-0 duration-base ease-entrance motion-reduce:animate-none',
          hasFailure
            ? 'bg-danger-subtle text-error'
            : hasHeld
              ? 'bg-warning-subtle text-warning'
              : 'bg-success-subtle text-success'
        )}
      >
        {hasFailure ? (
          <AlertCircle className="size-3.5" />
        ) : hasHeld ? (
          <ShieldAlert className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </span>
    )
  }

  if (offline) {
    return (
      <span
        aria-hidden
        data-testid="upload-tray-glyph"
        data-tone="offline"
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-warning-subtle text-warning"
      >
        <WifiOff className="size-3.5" />
      </span>
    )
  }

  const determinate = summary.stage === 'transferring' && summary.bytesPercent !== null
  const filled = determinate ? (summary.bytesPercent! / 100) * circumference : circumference * 0.28

  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className={cn('size-5 shrink-0 -rotate-90', !determinate && 'animate-spin')}
    >
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-foreground/12" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference}`}
        // `duration-deliberate` is the ceiling of the motion scale; the 500ms
        // this replaces was off it entirely, so the ring still lagged visibly
        // behind the byte count beside it.
        className="stroke-primary transition-[stroke-dasharray] duration-deliberate ease-out motion-reduce:transition-none"
      />
    </svg>
  )
}

/**
 * One horizontal track.
 *
 * `percent === null` and `sweeping` are not two ways of saying the same thing:
 * a sweep means "working, no position exists", an empty track means "nothing is
 * happening here". Conflating them is how an idle row ends up animating.
 */
function TrackBar({
  percent,
  sweeping,
  className,
  testId,
}: {
  percent: number | null
  sweeping: boolean
  className?: string
  testId?: string
}) {
  if (percent === null && !sweeping) return null

  return (
    <div
      data-testid={testId}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      // An indeterminate progressbar omits `aria-valuenow` — that is exactly
      // what the ARIA spec reserves it for, and it is the accessible half of
      // the same honesty the visual makes.
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
      className={cn('relative h-[3px] w-full overflow-hidden bg-foreground/8', className)}
    >
      {percent === null ? (
        <span className="animate-progress-sweep block h-full w-1/3 rounded-full bg-primary/60 motion-reduce:animate-none" />
      ) : (
        <span
          // `scaleX` from the left edge, NOT `width`. This bar re-renders on
          // every progress event — a `transition-[width]` here asked the
          // browser to re-lay-out the tray on each tick for the whole life of
          // an upload, which is the one thing
          // `grid-design-language.md` §"Binding constraints" rules out
          // ("transform and opacity only"). At 3px tall the `rounded-r`
          // cap's horizontal squash under the scale is sub-pixel.
          className="block h-full w-full origin-left rounded-r-full bg-primary transition-transform duration-quick ease-out motion-reduce:transition-none"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      )}
    </div>
  )
}

function UploadRow({
  file,
  onRetry,
  onCancel,
  onDismiss,
}: {
  file: TrackedFile
  onRetry: (id: string) => void
  onCancel?: (id: string) => void
  onDismiss?: (ids: string[]) => void
}) {
  const t = useTranslations('files')
  const tc = useTranslations('common')
  const { locale } = useLocale()
  // The landing's spring is for the 4px drop; the fade is a tween (the
  // icon-swap pair: opacity never springs), and all of it is instant under
  // reduced motion. The fold is the tray's own height token.
  const landing = useMotionToken(iconSwapTransition)
  const fold = useMotionToken(motionBase)

  const phase = uploadPhase(file)
  const percent = uploadPercent(file)
  const mark = ingestionMarkOfPhase(phase)
  const canCancel = (phase === 'uploading' || phase === 'queued') && onCancel !== undefined
  const isFailed = phase === 'failed'
  // Held back by the content check (ADR-0086). Never retried: the server
  // refuses a re-upload onto it, and nothing went wrong to repeat.
  const isHeldBack = phase === 'held'
  // The held document the uploader may ask the reviewers about: this row's own,
  // or the one it would replace when this person uploaded that one too.
  const reviewableId =
    file.serverFileId ?? (file.replacesHeld?.ownUpload ? file.replacesHeld.documentId : null) ?? null
  const heldVerdict = isHeldBack ? quarantineVerdictOf(file) : null
  const unchanged = file.unchanged === true && phase === 'ready'
  const canDismiss = (phase === 'canceled' || isFailed || isHeldBack) && onDismiss !== undefined
  const canRetry = isFailed && mayRetryUpload(file)
  const showsSizeInline = phase === 'uploading' || phase === 'queued'
  // A line of the tray's filing bar would move this file.
  const lit = useFilingHighlighted(file.serverFileId)

  return (
    // NOT `layout`. A layout animation runs as a scale transform, so a row
    // whose height changed (a reason appearing under it) was drawn squashed
    // for the length of the animation, text included. The row's own height
    // is constant through every live phase now, and the one part that grows
    // (the reason block below) folds open on its own.
    // eslint-disable-next-line grid/motion-vocabulary -- a dismissed row folds away so the rows below slide up instead of jumping; instant under reduced motion
    <motion.li
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      // A dropped file LANDING is one of the three cases that earn a spring:
      // continuation of the gesture the user made a moment ago, over 4px.
      transition={landing}
      data-testid="upload-row"
      data-phase={phase}
      className={cn('relative overflow-hidden border-t first:border-t-0', lit && HIGHLIGHT_OUTLINE_INSET)}
    >
      {/* One fixed-height line in every phase. The size, the status word and
          the actions each own a column of fixed width, so a row gaining or
          losing a button does not shove its neighbours sideways, and a German
          status word („Zurückgehalten“, „Fehlgeschlagen“) is never cut. */}
      <div className="flex h-12 items-center gap-2.5 px-4 sm:h-10">
        {/* The extension tile the Files list draws, so a document looks like
            itself from the second it is dropped. */}
        <FileExtChip filename={file.fileName} size="xs" fallback="—" />

        {/* On a phone the status word sits under the name, so the name keeps
            the width; from `sm` up they share the line in fixed columns. */}
        <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-2.5">
        <div className="flex min-w-0 items-center gap-2 sm:flex-1">
          {/* The name loses its middle, never its end: the revision and the
              extension are what tell two Fassungen of one drawing apart, and
              a phone shows about 25 characters of it. */}
          <p className="min-w-0 text-xs text-foreground" data-testid="upload-row-name">
            <MiddleTruncate text={file.fileName} tail={ROW_NAME_TAIL} />
          </p>
          {/* Where Piloti would file it, while the person is still at the
              upload: the chip, as on the card, on the row's one line. */}
          {!isFailed && !isHeldBack && (
            <FilingSuggestionSlot documentId={file.serverFileId} className="max-w-[60%] shrink-0" />
          )}
        </div>

        {/* Off on a phone: the name is what tells two rows apart, and the
            fixed columns beside it would leave it a few characters. */}
        <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
          {formatBytes(file.fileSize, locale)}
        </span>

        {/* Glyph, word and ink from one table (`ingestion-atoms`): waiting,
            sending, reading, filed and cancelled all write in muted ink, and
            the glyph is what tells them apart at a glance. No shimmer on a
            reading row: the header's sweep is the batch's one loop, and a
            shimmer per row made a batch of twelve twelve loops. */}
        <span
          className={cn(
            // The server's „unchanged" answer is a sentence, not a status word,
            // so it may take more than the column. The column holds the
            // longest status word („Zurückgehalten") beside its glyph.
            unchanged ? 'sm:min-w-28' : 'sm:w-28',
            'flex shrink-0 items-center text-xs font-medium tabular-nums sm:justify-end'
          )}
          data-testid={unchanged ? 'upload-row-unchanged' : undefined}
        >
          <IngestionStatusWord mark={mark} quiet={unchanged}>
            {unchanged ? t('uploads.row.unchanged') : phaseLabel(phase, percent, t)}
          </IngestionStatusWord>
          {/* The size column is off on a phone, so a file that is still moving
              carries its size here: „42 % · 4,8 MB" says how much is left. */}
          {showsSizeInline && (
            <span className="whitespace-pre font-normal text-muted-foreground sm:hidden"> · {formatBytes(file.fileSize, locale)}</span>
          )}
        </span>
        </div>

        {/* On a finger the row has ONE action. A failed row's retry is the
            labelled button under its reason (below), not a second icon beside
            the dismiss: two 44px icons in a 393px row left the name no room,
            and a bare arrow says less than „Erneut versuchen". */}
        <span className="flex w-[52px] shrink-0 items-center justify-end gap-1 pointer-coarse:w-11">
          {canRetry && (
            <RowAction
              label={tc('actions.retry')}
              onClick={() => onRetry(file.id)}
              icon={RotateCcw}
              className="pointer-coarse:hidden"
            />
          )}
          {canCancel && (
            <RowAction
              label={t('uploads.actions.cancel', { name: file.fileName })}
              onClick={() => onCancel?.(file.id)}
              icon={X}
            />
          )}
          {canDismiss && (
            <RowAction
              label={t('uploads.actions.dismiss', { name: file.fileName })}
              onClick={() => onDismiss?.([file.id])}
              icon={X}
            />
          )}
        </span>
      </div>

      {/* The bytes of THIS file, on the row's bottom edge rather than under it:
          a track that took its own line made every row taller while it sent
          and shorter when it finished, and the listing below jumped with each
          one. Only while bytes move; reading has no position, and the row says
          so with its word and the header's sweep. */}
      {isDeterminate(phase) && (
        <TrackBar percent={percent} sweeping={false} className="absolute inset-x-4 bottom-0 h-0.5 w-auto rounded-full" />
      )}

      <AnimatePresence initial={false}>
        {(isFailed && (file.errorMessage || canRetry)) || isHeldBack ? (
          // eslint-disable-next-line grid/motion-vocabulary -- the reason folds open under its own row when the file settles; instant under reduced motion
          <motion.div
            key="reason"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={fold}
            className="overflow-hidden"
          >
            <div className="-mt-1 pb-2 pl-[50px] pr-4">
              {/* A file the server accepted failed while being read: its
                  message is the stored ingest failure, said in the reader's
                  language. One that never arrived failed its upload, and that
                  message is already the upload's own. */}
              {isFailed && file.errorMessage && failedWhileReading(file) ? (
                <IngestFailureNotice
                  errorMessage={file.errorMessage}
                  sentenceClassName="leading-snug text-error"
                  testId="upload-row-failure"
                />
              ) : isFailed && file.errorMessage ? (
                <p className="text-xs leading-snug text-error">{file.errorMessage}</p>
              ) : null}

              {/* Only where there is no hover and no room for a bare icon. */}
              {canRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2 hidden gap-1.5 pointer-coarse:inline-flex"
                  onClick={() => onRetry(file.id)}
                  data-testid="upload-row-retry"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {t('uploads.actions.retryFile')}
                </Button>
              )}

              {/* Why it was held, as the Files preview and the upload summary
                  say it. No page buttons: the tray cannot show the document.
                  The sentence that explains holding back stands in only when
                  there are no reasons to list. A row refused because the file
                  it replaces is held says that in its own sentence. */}
              {isHeldBack && (
                <HeldUploadReason
                  verdict={heldVerdict}
                  replacesHeld={file.replacesHeld}
                  message={file.errorMessage}
                  withoutSentence={(heldVerdict?.reasons.length ?? 0) > 0}
                  testId="upload-row-held"
                />
              )}
              {/* The one thing the uploader can do about a held file, where
                  they first learn of it: this session's own upload, or the
                  held file this one would replace when they uploaded it too.
                  The server accepts the request from the uploader alone. */}
              {isHeldBack && reviewableId && (
                <RequestReviewButton
                  documentId={reviewableId}
                  name={file.fileName}
                  className="mt-2 h-7 px-2 text-xs"
                  testId="upload-row-request-review"
                />
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.li>
  )
}

function RowAction({
  label,
  onClick,
  icon: Icon,
  className,
}: {
  label: string
  onClick: () => void
  icon: typeof X
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11',
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  )
}

/** The right-hand status word for a row — a percentage ONLY where one exists. */
function phaseLabel(phase: UploadPhase, percent: number | null, t: ReturnType<typeof useTranslations>): string {
  switch (phase) {
    case 'uploading':
      return percent === null ? t('uploads.row.uploading') : `${percent}%`
    case 'queued':
      return t('uploads.row.queued')
    case 'processing':
      return t('uploads.row.processing')
    case 'ready':
      return t('uploads.row.ready')
    case 'held':
      return t('uploads.row.held')
    case 'stored':
      return t('uploads.row.stored')
    case 'canceled':
      return t('uploads.row.canceled')
    case 'failed':
      return t('uploads.row.failed')
  }
}

/** What the batch is doing, in one sentence. */
function trayHeadline(summary: TransferSummary, t: ReturnType<typeof useTranslations>): string {
  if (summary.stage === 'transferring') {
    const count = summary.queued + summary.uploading
    return t(count === 1 ? 'uploads.heading.transferringOne' : 'uploads.heading.transferringOther', { count })
  }
  if (summary.stage === 'processing') {
    return t(summary.processing === 1 ? 'uploads.heading.processingOne' : 'uploads.heading.processingOther', {
      count: summary.processing,
    })
  }
  // A stored file was added too, it is only not read; the row says „Abgelegt“.
  const added = summary.ready + summary.stored
  if (added > 0 && summary.failed > 0) {
    return t('uploads.heading.mixed', { ready: added, failed: summary.failed })
  }
  if (summary.failed > 0) {
    return t(summary.failed === 1 ? 'uploads.heading.failedOne' : 'uploads.heading.failedOther', {
      count: summary.failed,
    })
  }
  if (added > 0 && summary.held > 0) {
    return t('uploads.heading.mixedHeld', { ready: added, held: summary.held })
  }
  if (summary.held > 0) {
    return t(summary.held === 1 ? 'uploads.heading.heldOne' : 'uploads.heading.heldOther', { count: summary.held })
  }
  if (added > 0) {
    return t(added === 1 ? 'uploads.heading.doneOne' : 'uploads.heading.doneOther', { count: added })
  }
  return t('uploads.heading.canceled')
}

/**
 * The second line — the numbers.
 *
 * While bytes move it is a measurement: how much of how much, how fast, how
 * much longer. While the backend reads it is a duration and a plain statement
 * that no estimate exists, which is more useful than a number that would have
 * to be made up.
 */
function trayDetail(
  summary: TransferSummary,
  context: {
    bytesPerSecond: number | null
    etaSeconds: number | null
    processingElapsed: number
    locale: string
    t: ReturnType<typeof useTranslations>
  }
): string {
  const { bytesPerSecond, etaSeconds, processingElapsed, locale, t } = context

  if (summary.stage === 'transferring') {
    const parts = [
      t('uploads.detail.bytes', {
        done: formatBytes(summary.uploadedBytes, locale),
        total: formatBytes(summary.totalBytes, locale),
      }),
    ]
    if (bytesPerSecond !== null) parts.push(formatTransferRate(bytesPerSecond, locale))
    if (etaSeconds !== null && etaSeconds > 0) {
      parts.push(t('uploads.detail.eta', { time: formatDurationShort(etaSeconds, locale) }))
    }
    if (summary.queued > 0) parts.push(t('uploads.detail.queued', { count: summary.queued }))
    return parts.join(' · ')
  }

  if (summary.stage === 'processing') {
    const parts = [t('uploads.detail.processing')]
    if (processingElapsed >= 5) {
      parts.push(t('uploads.detail.elapsed', { time: formatDurationShort(processingElapsed, locale) }))
    }
    return parts.join(' · ')
  }

  return t('uploads.detail.settled', { total: formatBytes(summary.uploadedBytes, locale) })
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, ChevronDown, RotateCcw, X } from 'lucide-react'
import type { TrackedFile } from '../types'
import {
  isDeterminate,
  summarizeTransfer,
  uploadPercent,
  uploadPhase,
  type TransferSummary,
  type UploadPhase,
} from '../lib/upload-progress'
import { useElapsedSeconds, useTransferRate } from '../hooks/use-transfer-rate'
import { extChipTint, fileExtensionLabel } from '../document-kind'
import { Button } from '@/components/ui/button'
import { AnimatePresence, motion, motionBase, springSnap } from '@/components/motion'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes, formatDurationShort, formatTransferRate } from '@/lib/format'
import { cn } from '@/lib/utils'

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
const VISIBLE_PHASES = new Set<UploadPhase>(['queued', 'uploading', 'processing', 'ready', 'failed', 'canceled'])

/**
 * How long a wholly successful batch keeps its summary before retiring itself.
 *
 * Success should be confirmed and then get out of the way; a panel announcing
 * "12 documents added" an hour later is clutter the user has to clear by hand.
 * A batch with anything failed or canceled in it never auto-retires — those
 * rows carry an action, and dismissing an unread failure would lose it.
 */
const SUCCESS_LINGER_MS = 6_000

export function UploadTray({ files, onRetry, onCancel, onCancelAll, onDismiss }: UploadTrayProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [isExpanded, setIsExpanded] = useState(true)

  const visible = useMemo(() => files.filter((file) => VISIBLE_PHASES.has(uploadPhase(file))), [files])
  const summary = useMemo(() => summarizeTransfer(visible), [visible])

  const isTransferring = summary.stage === 'transferring'
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

  const isQuietSuccess = summary.isSettled && summary.failed === 0 && summary.canceled === 0
  useEffect(() => {
    if (!isQuietSuccess || !dismissAll || isHeld) return
    const timer = setTimeout(dismissAll, SUCCESS_LINGER_MS)
    return () => clearTimeout(timer)
  }, [isQuietSuccess, dismissAll, isHeld])

  /**
   * Recovery for the whole batch at once. Three of twelve failing is the common
   * shape of an upload problem (a flaky link, a backend blip), and clearing it
   * one row at a time is work the interface can do on the user's behalf.
   */
  const retryAll = useMemo(() => {
    const failed = visible.filter((file) => uploadPhase(file) === 'failed')
    if (failed.length === 0) return null
    return () => failed.forEach((file) => onRetry(file.id))
  }, [visible, onRetry])

  if (visible.length === 0) return null

  const headline = trayHeadline(summary, t)
  const detail = trayDetail(summary, { bytesPerSecond, etaSeconds, processingElapsed, locale, t })

  return (
    <section
      aria-label={t('uploads.region')}
      data-testid="upload-tray"
      className="shrink-0 border-b bg-card"
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
        <TrayGlyph summary={summary} />

        <button
          type="button"
          onClick={() => setIsExpanded((open) => !open)}
          aria-expanded={isExpanded}
          // The row is 53px tall and this control was 33 of them: the tray's own
          // `py-2.5` sits OUTSIDE the button, so the strip a reader obviously
          // aims at — the whole band — was dead along its top and bottom edges.
          // `-my-2.5 py-2.5` cancels to the same margin box, so nothing moves;
          // the button simply stops leaving its own padding on the table.
          className="min-w-40 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:-my-2.5 pointer-coarse:py-2.5"
        >
          {/* Polite, not assertive: the phase changes two or three times per
              batch and each one is worth hearing, but the byte counter beneath
              it updates every second and must never be announced. */}
          <p aria-live="polite" className="truncate text-sm font-medium leading-tight text-foreground">
            {headline}
          </p>
          <p aria-hidden className="truncate text-xs leading-tight text-muted-foreground tabular-nums">
            {detail}
          </p>
        </button>

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
        <button
          type="button"
          onClick={() => setIsExpanded((open) => !open)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? t('uploads.actions.collapse') : t('uploads.actions.expand')}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
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

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            // A tween, not a spring: this is an accordion height, and a spring
            // on a layout property overshoots PAST `auto` and clips the last
            // row on the way in. `grid-design-language.md` §"Fixed
            // choreography" puts height changes on `--motion-base`.
            transition={motionBase}
            className="max-h-[42dvh] overflow-y-auto overscroll-contain"
          >
            {visible.map((file) => (
              <UploadRow
                key={file.id}
                file={file}
                onRetry={onRetry}
                onCancel={onCancel}
                onDismiss={onDismiss}
              />
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </section>
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
function TrayGlyph({ summary }: { summary: TransferSummary }) {
  const radius = 8
  const circumference = 2 * Math.PI * radius

  if (summary.isSettled) {
    // Any failure at all takes the mark, even alongside successes. A green
    // check over "1 added · 1 failed" is the glyph contradicting the sentence
    // beside it, and the glyph is what gets read at a glance.
    const hasFailure = summary.failed > 0
    return (
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          hasFailure ? 'bg-destructive/10 text-destructive' : 'bg-success-subtle text-success'
        )}
      >
        {hasFailure ? <AlertCircle className="size-3.5" /> : <Check className="size-3.5" />}
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
        <span className="animate-progress-sweep block h-full w-1/3 rounded-full bg-primary/60" />
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

  const phase = uploadPhase(file)
  const percent = uploadPercent(file)
  const ext = fileExtensionLabel(file.fileName)
  const canCancel = (phase === 'uploading' || phase === 'queued') && onCancel !== undefined
  const isFailed = phase === 'failed'

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      // A dropped file LANDING is one of the three cases that earn a spring:
      // continuation of the gesture the user made a moment ago, over 4px —
      // well inside `springSnap`'s 24px travel ceiling. `springDrawer` (via
      // the legacy `springGentle` alias) was the large-surface spring, too
      // slow to read as the file arriving.
      transition={springSnap}
      data-testid="upload-row"
      data-phase={phase}
      className="border-t px-4 py-2 first:border-t-0"
    >
      <div className="flex items-center gap-2.5">
        {/* Same extension chip the file cards and the preview header use, so a
            document looks like itself from the second it is dropped. */}
        <span
          aria-hidden
          // 8.5px is load-bearing and stays — a four-letter extension has to fit
          // inside a 24px square; see file-list-view.
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-[8.5px] font-bold uppercase leading-none"
          style={extChipTint(ext)}
        >
          {ext || '—'}
        </span>

        <p className="min-w-0 flex-1 truncate text-xs text-foreground" title={file.fileName}>
          {file.fileName}
        </p>

        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatBytes(file.fileSize, locale)}
        </span>

        <span
          className={cn(
            'w-[68px] shrink-0 text-right text-xs font-medium tabular-nums',
            phase === 'ready' && 'text-success',
            isFailed && 'text-destructive',
            phase !== 'ready' && !isFailed && 'text-muted-foreground',
            phase === 'processing' && 'animate-text-shimmer'
          )}
        >
          {phaseLabel(phase, percent, t)}
        </span>

        {canCancel && (
          <RowAction
            label={t('uploads.actions.cancel', { name: file.fileName })}
            onClick={() => onCancel?.(file.id)}
            icon={X}
          />
        )}
        {isFailed && (
          <RowAction label={tc('actions.retry')} onClick={() => onRetry(file.id)} icon={RotateCcw} />
        )}
        {(phase === 'canceled' || isFailed) && onDismiss && (
          <RowAction
            label={t('uploads.actions.dismiss', { name: file.fileName })}
            onClick={() => onDismiss([file.id])}
            icon={X}
          />
        )}
      </div>

      {/* The per-file track only exists while the file has something to say.
          A finished row collapses to a single line, so a settling batch visibly
          gets quieter instead of holding twelve animating bars. */}
      {(isDeterminate(phase) || phase === 'processing') && (
        <TrackBar percent={percent} sweeping={phase === 'processing'} className="mt-1.5 rounded-full" />
      )}

      {isFailed && file.errorMessage && (
        <p className="mt-1 pl-[34px] text-xs leading-snug text-destructive">{file.errorMessage}</p>
      )}
    </motion.li>
  )
}

function RowAction({
  label,
  onClick,
  icon: Icon,
}: {
  label: string
  onClick: () => void
  icon: typeof X
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
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
  if (summary.ready > 0 && summary.failed > 0) {
    return t('uploads.heading.mixed', { ready: summary.ready, failed: summary.failed })
  }
  if (summary.failed > 0) {
    return t(summary.failed === 1 ? 'uploads.heading.failedOne' : 'uploads.heading.failedOther', {
      count: summary.failed,
    })
  }
  if (summary.ready > 0) {
    return t(summary.ready === 1 ? 'uploads.heading.doneOne' : 'uploads.heading.doneOther', { count: summary.ready })
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

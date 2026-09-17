/**
 * RunBlock — the Laufblock: one element for everything a run is, in the thread
 * that commissioned it.
 *
 * A header bar with the state, the result's title, the elapsed time and the
 * ONE action that fits now; under it the five-phase rail and the phases as a
 * list, where a finished phase folds to one line and the live one shows what
 * the run is doing in the runner's own words; under that the sentence the
 * state owes the reader, with the file affordance and the reviewer's verdict
 * once there are any. Seven states, one block: angelegt, läuft, wartet, fertig,
 * fehlgeschlagen, abgebrochen, unterbrochen.
 *
 * ## One truth
 *
 * It renders ONLY from the {@link RunLedger} it is handed. It folds no events,
 * keeps no store and opens no stream — a live run is the same ledger replaced
 * in place by whoever holds the subscription (`useRunLedger`), so a live block,
 * a reload and a shared thread cannot tell three stories. `live` says only
 * whether a stream is attached; every visible state comes from the ledger.
 *
 * ## The grammar it borrows
 *
 * The header is the Herleitung bar's (`ChatThinking`): a glyph in a fixed slot,
 * the bold word, the muted summary, the elapsed pill, the rotating chevron, and
 * a body that grows out of the bar. The document chips are the „Belegt durch"
 * chips (`SourceSignalChip` + `AuthorityTag`), painted by the shelf the ledger
 * stated. The phase swatches are the product's status swatch. Nothing here is
 * a new material.
 *
 * ## What it refuses to show
 *
 * No tool names — the ledger carries none, on purpose. No numbers in the header
 * except the two tallies and the clock. One ambient loop: the spinner. The
 * Herleitung bar runs a shimmer and a sweep beside its spinner; a thread with
 * three live runs in it cannot afford nine loops, so this block runs one — and
 * the rail's active ring is static for the same reason.
 *
 * ## How a change reads
 *
 * The block is replaced ledger by ledger, and every difference between two
 * ledgers is one small fixed move, never decoration (design language, Motion
 * vocabulary). What moves is what CHANGED; what was already on screen stays
 * where it is:
 *
 * - Arrival: the turn's fade-and-rise, then the rail's swatches left to right.
 * - A phase completes: its swatch fills and checks (`PhaseSwatch`), the
 *   connector to the next phase fills (`PhaseRail`), and in the list the live
 *   content folds while the one-line summary fades in over it; the next phase's
 *   row rises in (`TimelineItem arrive`).
 * - A round arrives: its row rises, the document chips cascade (capped), the
 *   open points last.
 * - The run lands: `landingDelays` queues the header glyph, the status word,
 *   the fold, the footer and the report so they play in that order.
 *
 * Nothing replays: rows are keyed by phase and by step id, so a re-render is
 * the same element with new props, and `AnimatePresence initial={false}` on
 * every list means a block that mounts finished paints in one frame. Under
 * reduced motion every one of these is the change with no motion.
 */

'use client'

import { type FC, type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronDown, FileText, XCircle } from 'lucide-react'

import {
  AnimatePresence,
  fadeRise,
  motion,
  motionBase,
  motionEntrance,
  motionInstant,
  motionQuick,
  motionQuickExit,
  staggerMaxSteps,
  staggerStepSeconds,
} from '@/components/motion'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import { PhaseRail, PhaseSwatch, type PhaseRailStep } from '@/components/ui/phase-rail'
import { Timeline, TimelineItem } from '@/components/ui/timeline'
import { AuthorityTag } from '@/features/chat/components/AuthorityTag'
import { formatElapsed } from '@/features/chat/hooks/use-elapsed-seconds'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { formatDurationElapsed } from '@/lib/format'
import {
  RUN_PHASES,
  type RunLedger,
  type RunLedgerDoc,
  type RunPhase,
  type RunStatus,
  type RunStep,
} from '@/lib/runs/run-ledger-types'
import {
  completedBefore,
  elapsedMs,
  isLiveStatus,
  phaseDurationMs,
  phaseState,
  runDisplayStatus,
  runTallies,
  stepsInPhase,
  type PhaseState,
  type RunTallies,
} from '@/lib/runs/run-vocabulary'
import { cn } from '@/lib/utils'
import { useRunClock } from '../hooks/use-run-clock'
import { landingDelays, type LandingDelays } from '../lib/choreography'
import { docProvenance } from '../lib/doc-provenance'
import { RunStatusGlyph } from './RunStatusGlyph'

export interface RunBlockReview {
  decision: 'accepted' | 'rejected'
  by?: string | null
  reason?: string | null
}

export interface RunBlockProps {
  ledger: RunLedger
  /** The result's title (task goal / question); falls back to „Auftrag". */
  title?: string | null
  /** Enables „Im Projekt anzeigen" on a filed result. */
  projectId?: string | null
  /** The angelegt sentence names the filing destination. Defaults to `!!projectId`. */
  filesToProject?: boolean
  review?: RunBlockReview | null
  /** A stream is attached. Affects nothing visible: state comes from the ledger. */
  live?: boolean
  /** Default: open while live, collapsed once terminal. */
  defaultOpen?: boolean
  /** wartet: focus the composer. */
  onAnswer?: () => void
  /** fehlgeschlagen / abgebrochen: offered only when provided. */
  onRetry?: () => void
  /** fertig & unreviewed: „Prüfen". */
  reviewHref?: string | null
  /** fertig & reviewed: „Bericht öffnen". */
  reportHref?: string | null
  className?: string
}

/** The muted interpunct between clauses of one line. */
const Sep: FC = () => (
  <span aria-hidden className="text-muted-foreground/50">
    {' · '}
  </span>
)

/** The tallies as clauses, empty ones dropped: „3 Runden · 9 Dokumente". */
function talliesLabel(t: Translator, tallies: RunTallies): string {
  return [
    tallies.rounds > 0 ? t('tallies.rounds', { count: tallies.rounds }) : null,
    tallies.docs > 0 ? t('tallies.docs', { count: tallies.docs }) : null,
  ]
    .filter((clause): clause is string => clause !== null)
    .join(' · ')
}

/**
 * The header's muted summary. Live and FOLDED: the phase and the tallies, since
 * the rail that would name the phase is out of sight. Live and open: the
 * tallies alone, because the rail right below carries the phase and a header
 * that repeats it only costs the title its room. Terminal: the tallies alone,
 * because the state word already says where it ended.
 */
function summaryLabel(
  t: Translator,
  ledger: RunLedger,
  live: boolean,
  tallies: RunTallies,
  showPhase: boolean,
): string {
  const phase = ledger.phases.length > 0 ? ledger.phases[ledger.phases.length - 1]?.phase : undefined
  const phaseLabel = live && showPhase && phase ? t(`phase.${phase}`) : null
  if (phaseLabel && tallies.rounds > 0 && tallies.docs > 0) {
    return t('summary', {
      phase: phaseLabel,
      rounds: t('tallies.rounds', { count: tallies.rounds }),
      docs: t('tallies.docs', { count: tallies.docs }),
    })
  }
  return [phaseLabel, talliesLabel(t, tallies)].filter(Boolean).join(' · ')
}

/** „Bis dahin: Planen, Recherchieren (2 Runden, 6 Dokumente)". */
function completedBeforeLabel(t: Translator, ledger: RunLedger, tallies: RunTallies): string | null {
  const phases = completedBefore(ledger)
  if (phases.length === 0) return null
  const named = phases.map((phase) => {
    const label = t(`phase.${phase}`)
    if (phase !== 'recherchieren' || (tallies.rounds === 0 && tallies.docs === 0)) return label
    return t('completedBeforeTallies', {
      phase: label,
      rounds: t('tallies.rounds', { count: tallies.rounds }),
      docs: t('tallies.docs', { count: tallies.docs }),
    })
  })
  return t('completedBefore', { phases: named.join(', ') })
}

/**
 * One document a step reached, as the „Belegt durch" chip: family tint from
 * the shelf, the authority badge when the name earns one, then the name and the
 * places read. A re-read document says so in the chip instead of counting
 * again.
 */
const DocChip: FC<{ doc: RunLedgerDoc; reduced: boolean }> = ({ doc, reduced }) => {
  const t = useTranslations('runs')
  const { tint, authority } = docProvenance(doc)
  const name = doc.title ?? doc.name
  const loci = doc.loci.join(' · ')
  return (
    <SourceSignalChip
      signal={tint}
      className={cn(
        'max-w-full transition-opacity duration-quick ease-out motion-reduce:transition-none',
        doc.repeat && 'opacity-75',
      )}
      title={loci ? `${name} · ${loci}` : name}
    >
      {authority && (
        <>
          <AuthorityTag>{authority}</AuthorityTag>{' '}
        </>
      )}
      {name}
      {loci && <span className="opacity-70"> · {loci}</span>}
      {/* A mark that lands on a chip already on screen crossfades in; one the
          chip mounted with is simply there. */}
      <AnimatePresence initial={false}>
        {doc.repeat && (
          <motion.span
            key="repeat"
            className="italic"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            exit={{ opacity: 0 }}
            transition={reduced ? motionInstant : motionQuick}
          >
            {' · '}
            {t('step.repeat')}
          </motion.span>
        )}
      </AnimatePresence>
    </SourceSignalChip>
  )
}

/** A plain fade, for the chips and the line that follow a round's rise. */
const FADE = { hidden: { opacity: 0 }, visible: { opacity: 1 } }

/**
 * One research round: its intent, the documents it reached, what stayed open.
 *
 * A round that arrives while the block is on screen rises in, and its chips
 * cascade after it — capped at `staggerMaxSteps`, so a round with nine
 * documents is not nine beats long — with the open points last, because they
 * are the sentence the round ends on. Whether it arrives or was already there
 * is decided by the presence that wraps the list, not here.
 */
const StepRow: FC<{ step: RunStep; index: number; numbered: boolean; reduced: boolean }> = ({
  step,
  index,
  numbered,
  reduced,
}) => {
  const t = useTranslations('runs')
  const intent = step.intent.trim() || t('step.fallback', { n: index + 1 })
  const chipDelay = (position: number): number => Math.min(position, staggerMaxSteps) * staggerStepSeconds
  const afterChips = (Math.min(step.docs.length, staggerMaxSteps) + 1) * staggerStepSeconds
  const fadeAfter = (delay: number) => (reduced ? motionInstant : { ...motionQuick, delay })
  return (
    <motion.div
      className="flex flex-col gap-1.5"
      data-testid="run-step"
      variants={fadeRise}
      initial="hidden"
      animate="visible"
      transition={reduced ? motionInstant : motionEntrance}
    >
      <p className="text-sm leading-snug text-foreground">
        {numbered && (
          <>
            <span className="font-medium">{t('step.round', { n: index + 1 })}</span>
            <Sep />
          </>
        )}
        {intent}
      </p>
      {step.docs.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="list">
          {step.docs.map((doc, position) => (
            <motion.span
              role="listitem"
              key={doc.name}
              className="inline-flex max-w-full"
              variants={FADE}
              transition={fadeAfter(chipDelay(position))}
            >
              <DocChip doc={doc} reduced={reduced} />
            </motion.span>
          ))}
        </div>
      )}
      {step.openPoints && step.openPoints.length > 0 && (
        <motion.p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="run-open-points"
          variants={FADE}
          transition={fadeAfter(afterChips)}
        >
          <span className="font-medium">{t('step.openPoints')}</span> {step.openPoints.join(' · ')}
        </motion.p>
      )}
    </motion.div>
  )
}

/** The one line a finished phase folds to, after its name. */
function doneLine(t: Translator, phase: RunPhase, tallies: RunTallies): string | null {
  switch (phase) {
    case 'planen':
      return t('phaseLine.planen')
    case 'recherchieren':
      return talliesLabel(t, tallies) || null
    case 'pruefen':
      return t('phaseLine.pruefen')
    case 'schreiben':
      return t('phaseLine.schreiben')
    case 'abgelegt':
      return null
  }
}

/** The live line of an active phase that has no steps to show for itself. */
function liveLine(t: Translator, phase: RunPhase): string | null {
  if (phase === 'pruefen') return t('phaseLine.pruefenLive')
  if (phase === 'schreiben') return t('phaseLine.schreibenLive')
  return null
}

/**
 * One phase in the list. A done phase is one line; a live one is its label and
 * its rounds. When a phase flips from live to done the two overlap for a
 * moment: the line fades in above while the rounds fold away beneath it —
 * height to zero through `AnimatePresence`, the one layout move the vocabulary
 * allows, on the exit curve and one step shorter than an entrance.
 */
const PhaseRow: FC<{
  ledger: RunLedger
  phase: RunPhase
  state: PhaseState
  live: boolean
  now: number | null
  tallies: RunTallies
  arrive: boolean
  reduced: boolean
}> = ({ ledger, phase, state, live, now, tallies, arrive, reduced }) => {
  const t = useTranslations('runs')
  const { locale } = useLocale()
  const label = t(`phase.${phase}`)
  const steps = stepsInPhase(ledger, phase)

  let body: ReactNode = null
  if (state === 'done') {
    const line = doneLine(t, phase, tallies)
    const duration = phaseDurationMs(ledger, phase, now ?? 0)
    body = (
      <motion.p
        key="done"
        className="text-sm leading-snug text-foreground"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reduced ? motionInstant : motionQuick}
      >
        <span className="font-medium">{label}</span>
        {line && (
          <>
            <Sep />
            <span className="text-muted-foreground">{line}</span>
          </>
        )}
        {duration !== null && (
          <>
            <Sep />
            <span className="whitespace-nowrap tabular-nums text-muted-foreground">
              {formatDurationElapsed(duration / 1000, locale)}
            </span>
          </>
        )}
      </motion.p>
    )
  } else if (state === 'active') {
    const line = live ? liveLine(t, phase) : null
    body = (
      <motion.div
        key="live"
        className="flex flex-col gap-1.5 overflow-hidden"
        data-testid="run-phase-live"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={reduced ? motionInstant : motionQuickExit}
      >
        <p className="text-sm font-semibold leading-snug text-foreground">{label}</p>
        {/* Rounds present when the list appeared are simply there; one that is
            appended later rises in. Keyed by step id, so an appended round is
            a new element and the rows above it are the same ones, re-rendered. */}
        <AnimatePresence initial={false}>
          {steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              index={index}
              numbered={phase === 'recherchieren'}
              reduced={reduced}
            />
          ))}
        </AnimatePresence>
        {line && steps.length === 0 && (
          <p className="text-sm leading-snug text-muted-foreground" data-testid="run-live-line">
            {line}
          </p>
        )}
      </motion.div>
    )
  } else {
    body = <p className="text-sm leading-snug text-muted-foreground">{label}</p>
  }

  return (
    <TimelineItem
      marker={<PhaseSwatch state={state} />}
      arrive={arrive}
      data-phase={phase}
      data-state={state}
    >
      <AnimatePresence initial={false}>{body}</AnimatePresence>
    </TimelineItem>
  )
}

/** Which of the three sentences a terminal or waiting state owes. */
function statusSentence(
  t: Translator,
  status: RunStatus,
  ledger: RunLedger,
  filesToProject: boolean,
): string | null {
  switch (status) {
    case 'angelegt':
      return filesToProject ? t('sentence.angelegtFiling') : t('sentence.angelegt')
    case 'wartet':
      return t('sentence.wartet')
    case 'fertig':
      return ledger.result?.fileId ? t('sentence.fertigFiled') : t('sentence.fertigInline')
    case 'fehlgeschlagen':
      return t('sentence.fehlgeschlagen', { reason: ledger.error?.reason ?? '' })
    case 'abgebrochen':
      return t('sentence.abgebrochen')
    case 'unterbrochen':
      return t('sentence.unterbrochen')
    case 'laeuft':
      return null
  }
}

export function RunBlock({
  ledger,
  title,
  projectId,
  filesToProject,
  review,
  defaultOpen,
  onAnswer,
  onRetry,
  reviewHref,
  reportHref,
  className,
}: RunBlockProps): JSX.Element {
  const t = useTranslations('runs')
  const reduced = useReducedMotion()
  const status = runDisplayStatus(ledger)
  const live = isLiveStatus(status)
  const now = useRunClock(live)
  // What was on screen when the block first painted does not animate its own
  // arrival — the block's fade-rise already carried it in. A phase row that
  // shows up later is news, and rises on its own.
  const paintedRef = useRef(false)
  useEffect(() => {
    paintedRef.current = true
  }, [])

  // The landing. A status that CHANGES while the block is on screen is a turn
  // in the run's story, and its moves are queued so they read in order
  // (`lib/choreography`). A block that mounts already finished shows its
  // ending at once: there was no turn to watch, and a staged reveal of facts
  // that were true before the reader arrived is theatre.
  const landedFromRef = useRef(status)
  const landingRef = useRef<LandingDelays | null>(null)
  if (status !== landedFromRef.current) {
    landedFromRef.current = status
    landingRef.current = reduced ? null : landingDelays(status)
  }
  const landing = landingRef.current
  const tallies = runTallies(ledger)
  const statusWord = t(`status.${status}`)
  const name = title?.trim() || t('block.untitled')

  // Open-state policy, the Herleitung bar's: open while live, folded once
  // terminal; the reader's own toggle wins over both; entering `wartet` always
  // opens, because the sentence that tells the reader what to do lives inside.
  const [open, setOpen] = useState<boolean>(status === 'wartet' || (defaultOpen ?? live))
  const userToggledRef = useRef(false)
  const autoOpenedRef = useRef(defaultOpen ?? live)
  const prevLiveRef = useRef(live)
  useEffect(() => {
    if (live === prevLiveRef.current) return
    prevLiveRef.current = live
    if (!live) {
      const shouldFold = !userToggledRef.current && autoOpenedRef.current
      autoOpenedRef.current = false
      if (!shouldFold) return
      // The body folds only after the header has said what happened — the
      // rail's last check, the glyph, the word. Folding first would pull the
      // reader's eye off the very phase that was finishing.
      const after = landingRef.current?.fold
      if (after === null || after === undefined) {
        setOpen(false)
        return
      }
      const timer = setTimeout(() => setOpen(false), after * 1000)
      return () => clearTimeout(timer)
    }
  }, [live])
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const enteredWait = status === 'wartet' && prevStatusRef.current !== 'wartet'
    prevStatusRef.current = status
    if (enteredWait) setOpen(true)
  }, [status])
  const handleOpenChange = (next: boolean): void => {
    userToggledRef.current = true
    setOpen(next)
  }

  // The clock: a terminal run's figure is on the ledger and shows from the
  // first paint; a live one waits for the mounted clock (see useRunClock).
  const elapsedSeconds =
    ledger.finishedAt || now !== null ? Math.floor(elapsedMs(ledger, now ?? 0) / 1000) : 0
  const elapsed = elapsedSeconds > 0 ? formatElapsed(elapsedSeconds) : null
  const summary = summaryLabel(t, ledger, live, tallies, !open)

  // The ONE action that fits the state. Rendered once — at the header's right
  // end from `sm` up, in the footer below it on a phone.
  const reviewed = !!review
  const action: ReactNode =
    status === 'wartet' && onAnswer ? (
      <Button size="sm" variant="secondary" onClick={onAnswer} data-testid="run-action-answer">
        {t('action.answer')}
      </Button>
    ) : status === 'fertig' && !reviewed && reviewHref ? (
      <Button size="sm" variant="secondary" asChild data-testid="run-action-review">
        <Link href={reviewHref}>{t('action.review')}</Link>
      </Button>
    ) : status === 'fertig' && reviewed && reportHref ? (
      <Button size="sm" variant="secondary" asChild data-testid="run-action-open-report">
        <Link href={reportHref}>{t('action.openReport')}</Link>
      </Button>
    ) : (status === 'fehlgeschlagen' || status === 'abgebrochen') && onRetry ? (
      <Button size="sm" variant="secondary" onClick={onRetry} data-testid="run-action-retry">
        {t('action.retry')}
      </Button>
    ) : null

  const sentence = statusSentence(t, status, ledger, filesToProject ?? !!projectId)
  const before =
    status === 'fehlgeschlagen' || status === 'abgebrochen'
      ? completedBeforeLabel(t, ledger, tallies)
      : null
  const fileHref =
    status === 'fertig' && projectId && ledger.result?.fileId
      ? documentFilesHref(projectId, ledger.result.fileId)
      : null
  const reviewLine = !review
    ? null
    : review.decision === 'accepted'
      ? review.by
        ? t('review.accepted', { name: review.by })
        : t('review.acceptedAnon')
      : review.reason
        ? t('review.rejected', { reason: review.reason })
        : t('review.rejectedAnon')
  const showFooter = sentence !== null || reviewLine !== null || fileHref !== null || action !== null

  const railSteps: PhaseRailStep[] = RUN_PHASES.map((phase) => {
    const state = phaseState(ledger, phase)
    return { key: phase, label: t(`phase.${phase}`), state, stateLabel: t(`rail.${state}`) }
  })

  return (
    <section
      aria-label={t('block.aria', { title: name, status: statusWord })}
      data-testid="run-block"
      data-status={status}
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 w-full rounded-2xl bg-muted shadow-xs duration-base ease-entrance motion-reduce:animate-none',
        className,
      )}
    >
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <div className="flex items-center gap-1 sm:pr-2">
          <CollapsibleTrigger asChild>
            {/* No aria-label: it would override the visible content, which is
                exactly what a non-sighted reader needs — the status word and
                the title. The toggle's purpose is stated visually-hidden at
                the end instead. */}
            <button
              type="button"
              className="group flex min-h-12 min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left outline-none transition-colors duration-snap ease-out focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2" aria-live="polite">
                {/* Decorative: the status word is the next thing in the row,
                    and it is inside the same live region. */}
                <RunStatusGlyph status={status} delay={landing?.glyph ?? 0} />
                <span className="min-w-0 truncate text-sm">
                  {/* The word crossfades rather than cutting: it is the one
                      place the block states what just happened, and a cut
                      there is the only change a reader can miss entirely.
                      The crossfade holds two words at once for a moment, so
                      the SPOKEN word is a plain one beside it and the moving
                      pair is hidden: a reader must never hear the run called
                      two things in one breath. */}
                  <span className="sr-only" data-testid="run-status-word">
                    {statusWord}
                  </span>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={status}
                      aria-hidden
                      className="inline-block font-semibold text-foreground"
                      initial={{ opacity: 0 }}
                      animate={{
                        opacity: 1,
                        transition: reduced ? motionInstant : { ...motionQuick, delay: landing?.word ?? 0 },
                      }}
                      exit={{
                        opacity: 0,
                        transition: reduced ? motionInstant : { ...motionQuickExit, delay: landing?.word ?? 0 },
                      }}
                    >
                      {statusWord}
                    </motion.span>
                  </AnimatePresence>
                  <Sep />
                  <span className="text-foreground" data-testid="run-title">
                    {name}
                  </span>
                </span>
              </span>

              {/* The title wins: the summary shrinks eight times as readily
                  and truncates first; the title gives up characters only
                  once the summary is nearly gone. */}
              <span className="flex min-w-0 shrink-[8] items-center gap-2">
                {summary && (
                  <span
                    className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline"
                    data-testid="run-summary"
                  >
                    {summary}
                  </span>
                )}
                {elapsed && (
                  <span
                    className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                    aria-label={t('block.elapsedAria', { elapsed })}
                    data-testid="run-elapsed"
                  >
                    {elapsed}
                  </span>
                )}
                <ChevronDown className="size-4 text-muted-foreground transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                <span className="sr-only">{t('block.toggle')}</span>
              </span>
            </button>
          </CollapsibleTrigger>
          {action && <span className="hidden shrink-0 sm:inline-flex">{action}</span>}
        </div>

        {/* The body grows out of the bar — height plus opacity, a user-initiated
            expand, the same instrument the Herleitung bar uses and for the same
            reason. `initial={false}` so a block that mounts open does not
            animate its way there. */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="run-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1, transition: motionBase }}
              exit={{ height: 0, opacity: 0, transition: motionQuick }}
              className="overflow-hidden"
            >
              <div className="flex flex-col gap-4 border-t border-border px-4 pb-4 pt-3" data-testid="run-body">
                {/* The swatches cascade in with the block itself; a rail the
                    reader unfolded by hand is already on screen and just is. */}
                <PhaseRail steps={railSteps} label={t('rail.label')} arrive={!userToggledRef.current} />
                {/* Only the phases with something to say: done ones fold to a
                    line, the live one shows its work. The rail above already
                    names what is still to come, so listing the pending phases
                    a second time would be the rail repeated in another shape. */}
                <Timeline>
                  {RUN_PHASES.filter((phase) => phaseState(ledger, phase) !== 'pending').map((phase) => (
                    <PhaseRow
                      key={phase}
                      ledger={ledger}
                      phase={phase}
                      state={phaseState(ledger, phase)}
                      live={live}
                      now={now}
                      tallies={tallies}
                      arrive={paintedRef.current}
                      reduced={reduced}
                    />
                  ))}
                </Timeline>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>

      {/* The sentence the state owes, outside the fold: a failed run that hid
          its reason behind a chevron would be a failure the reader has to go
          looking for. */}
      {showFooter && (
        <motion.div
          key={`footer-${status}`}
          initial={landing ? { opacity: 0, y: 4 } : false}
          animate={{
            opacity: 1,
            y: 0,
            transition: reduced || !landing ? motionInstant : { ...motionEntrance, delay: landing.footer },
          }}
          className="flex flex-col gap-1.5 border-t border-border px-4 pb-3 pt-2.5"
          data-testid="run-footer"
        >
          {sentence && (
            <p
              className={cn(
                'text-sm leading-relaxed',
                status === 'fehlgeschlagen' ? 'text-error' : 'text-muted-foreground',
              )}
              role={live ? 'status' : undefined}
              data-testid="run-sentence"
            >
              {sentence}
            </p>
          )}
          {before && (
            <p className="text-xs leading-relaxed text-muted-foreground" data-testid="run-completed-before">
              {before}
            </p>
          )}
          {fileHref && (
            <Link
              href={fileHref}
              className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              data-testid="run-file-link"
            >
              <FileText className="size-3.5" aria-hidden />
              {t('action.openInProject')}
            </Link>
          )}
          {reviewLine && review && (
            <p
              className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
              data-testid="run-review"
              data-decision={review.decision}
            >
              {review.decision === 'accepted' ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-error" aria-hidden />
              )}
              <span>{reviewLine}</span>
            </p>
          )}
          {action && <span className="inline-flex sm:hidden">{action}</span>}
        </motion.div>
      )}

    </section>
  )
}

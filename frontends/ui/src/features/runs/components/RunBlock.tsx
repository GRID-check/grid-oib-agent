/**
 * RunBlock — the Laufblock: one element for everything a run is, in the thread
 * that commissioned it.
 *
 * A stand at the top — the result's title, the elapsed time, a thin track of
 * the five phases and ONE line saying where the run is — and, behind the
 * chevron, the rounds it did as a hairline-separated list, the phases it
 * finished as acts, and the reviewer's words. Seven states, one block:
 * angelegt, läuft, wartet, fertig, fehlgeschlagen, abgebrochen, unterbrochen.
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
 * The document lifecycle's stand, which is the surface in this product that had
 * already solved „where does this stand": a track whose walked segments are
 * filled, the state NAMED in one muted line under it, and the history below as
 * `Item` rows with hairlines rather than as stacked cards (`ItemList`, the same
 * atoms `document-version-list.tsx` composes). The track itself is the shared
 * atom, `components/ui/stage-track.tsx`, lifted out of that stand when this
 * block needed the same shape — two surfaces showing the same thing compose the
 * same atom, or they drift on the first token retune.
 *
 * The document chips stay the „Belegt durch" chips (`SourceSignalChip` +
 * `AuthorityTag`), painted by the shelf the ledger stated: provenance is the
 * one thing the design language spends colour on, and which documents a run
 * read is its whole claim to being checkable.
 *
 * ## What it refuses to show
 *
 * No tool names — the ledger carries none, on purpose. No identifiers. No
 * numbers except the two tallies and the clock. One ambient loop: the glyph.
 * And no second account of the state — the word appears in the status line and
 * nowhere else, because a state said twice stops reading as one fact. That is
 * what „stripped down" bought: the old header said it four ways (glyph, bold
 * word, phase summary, footer sentence) before the reader got to the work.
 *
 * ## How a change reads
 *
 * The block is replaced ledger by ledger, and every difference between two
 * ledgers is one small fixed move, never decoration (design language, Motion
 * vocabulary). What moves is what CHANGED; what was already on screen stays
 * where it is:
 *
 * - Arrival: the turn's fade-and-rise.
 * - A phase completes: its segment fills — a colour transition on the track —
 *   and the line under it names the next one.
 * - A round arrives: its row rises, the document chips cascade (capped), the
 *   open points last.
 * - The run lands: `landingDelays` queues the glyph, the status line, the fold
 *   and the closing rows so they play in that order.
 *
 * Nothing replays: rows are keyed by step id, so a re-render is the same
 * element with new props, and `AnimatePresence initial={false}` on every list
 * means a block that mounts finished paints in one frame. Under reduced motion
 * every one of these is the change with no motion.
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Item, ItemList } from '@/components/ui/item'
import { StageTrack, type StageTrackTone } from '@/components/ui/stage-track'
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
  activePhase,
  completedBefore,
  elapsedMs,
  isLiveStatus,
  phaseDurationMs,
  phaseState,
  runDisplayStatus,
  runTallies,
  stepsInPhase,
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
  /**
   * This run's result WILL be filed into the project. Only the commissioning
   * side knows — a task run files, an escalated chat question answers inline —
   * so it is never inferred here, and an unclaimed run promises no destination.
   */
  filesToProject?: boolean
  review?: RunBlockReview | null
  /** A stream is attached. Affects nothing visible: state comes from the ledger. */
  live?: boolean
  /**
   * What the run's own stream is doing, when there is one (`useRunLedger`).
   * `live` and absent say the same thing — nothing to report — and the other
   * two put ONE muted line in the block: the live view broke, the run did not.
   * Silence there would read as a run that stopped.
   */
  connection?: 'live' | 'reconnecting' | 'lost' | null
  /** Default: open while live, collapsed once terminal. */
  defaultOpen?: boolean
  /** wartet: focus the composer. */
  onAnswer?: () => void
  /** fehlgeschlagen / abgebrochen: offered only when provided. */
  onRetry?: () => void
  /**
   * Stop a run still going. Offered only while it IS going and only when a
   * caller hands one in, so a block with nothing to stop shows no way to stop
   * it rather than a control that refuses. Nothing here is optimistic: the
   * block keeps saying what the ledger says until the fold says it stopped.
   */
  onCancel?: (() => void | Promise<void>) | null
  /**
   * „Jetzt schreiben": stop researching and write from what is there. Offered
   * only while the run is researching — the one phase where it changes what
   * happens — and only when a caller hands one in.
   */
  onWriteNow?: (() => void | Promise<void>) | null
  /**
   * „Bericht fortschreiben": a new run on the same subject, briefed with this
   * run's findings, so a changed project fact re-reads the Befunde instead of
   * re-commissioning the work from scratch. Offered on a finished report only.
   */
  onContinue?: (() => void | Promise<void>) | null
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
    (tallies.findings ?? 0) > 0 ? t('tallies.findings', { count: tallies.findings ?? 0 }) : null,
  ]
    .filter((clause): clause is string => clause !== null)
    .join(' · ')
}

/** The clauses of one line, empty ones dropped. */
function clauses(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => !!part).join(' · ')
}

/**
 * The ONE line that says where the run stands — the stand's own sentence, under
 * the track, exactly where the document lifecycle puts „was fehlt noch".
 *
 * While the run is going it leads with the PHASE rather than with „Läuft",
 * because the phase is the informative half and „läuft" is already said by the
 * turning glyph beside the title. A terminal state leads with its word and adds
 * the one fact the reader needs next: where the report is, why it stopped.
 */
function statusLine(
  t: Translator,
  ledger: RunLedger,
  status: RunStatus,
  tallies: RunTallies,
  filesToProject: boolean
): string {
  switch (status) {
    case 'angelegt':
      return clauses(t('status.angelegt'), filesToProject ? t('line.filing') : null)
    case 'laeuft': {
      const phase = activePhase(ledger)
      return clauses(
        phase ? t(`phase.${phase}`) : t('status.laeuft'),
        talliesLabel(t, tallies) || null
      )
    }
    case 'wartet':
      return clauses(t('status.wartet'), t('line.wartet'))
    case 'fertig':
      return clauses(
        t('status.fertig'),
        ledger.result?.fileId ? t('line.fertigFiled') : t('line.fertigInline')
      )
    case 'fehlgeschlagen':
      return t('line.fehlgeschlagen', { reason: ledger.error?.reason ?? '' })
    case 'abgebrochen':
      return clauses(t('status.abgebrochen'), t('line.abgebrochen'))
    case 'unterbrochen':
      return clauses(t('status.unterbrochen'), t('line.unterbrochen'))
  }
}

/** „Bis dahin: Planen, Recherchieren (2 Runden, 6 Dokumente)". */
function completedBeforeLabel(
  t: Translator,
  ledger: RunLedger,
  tallies: RunTallies
): string | null {
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
 * What the walked segments are coloured by — the lifecycle stand's own rule:
 * ink while nothing has been asserted, a register once something has.
 *
 * `unterbrochen` is `settled` and not a third colour: there IS a report, only a
 * narrower one, and the line under the track is what says so. The palette holds
 * no further chroma family that is not a provenance source, and borrowing the
 * Büroarchiv gold for it would put an archive collision back as a colour.
 */
function trackTone(status: RunStatus): StageTrackTone {
  switch (status) {
    case 'fertig':
    case 'unterbrochen':
      return 'settled'
    case 'fehlgeschlagen':
      return 'stopped'
    case 'abgebrochen':
      return 'retired'
    default:
      return 'moving'
  }
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
        'duration-quick max-w-full transition-opacity ease-out motion-reduce:transition-none',
        doc.repeat && 'opacity-75'
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
 * One research round, as a row of the list: its intent, the documents it
 * reached, what stayed open.
 *
 * A round that arrives while the block is on screen rises in, and its chips
 * cascade after it — capped at `staggerMaxSteps`, so a round with nine
 * documents is not nine beats long — with the open points last, because they
 * are the sentence the round ends on.
 */
const RoundRow: FC<{ step: RunStep; index: number; reduced: boolean }> = ({
  step,
  index,
  reduced,
}) => {
  const t = useTranslations('runs')
  const intent = step.intent.trim() || t('step.fallback', { n: index + 1 })
  const chipDelay = (position: number): number =>
    Math.min(position, staggerMaxSteps) * staggerStepSeconds
  const afterChips = (Math.min(step.docs.length, staggerMaxSteps) + 1) * staggerStepSeconds
  const fadeAfter = (delay: number) => (reduced ? motionInstant : { ...motionQuick, delay })
  return (
    <Item as="li" className="flex-col items-stretch gap-1 px-3 py-2 hover:bg-transparent" asChild>
      <motion.li
        data-testid="run-step"
        variants={fadeRise}
        initial="hidden"
        animate="visible"
        transition={reduced ? motionInstant : motionEntrance}
      >
        <p className="text-foreground text-xs leading-snug">
          <span className="font-medium tabular-nums">{t('step.round', { n: index + 1 })}</span>
          <Sep />
          {intent}
        </p>
        {step.docs.length > 0 && (
          <div className="flex flex-wrap gap-1" role="list">
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
        {step.findings && step.findings.length > 0 && (
          <motion.ul
            className="text-foreground text-[11px] leading-relaxed"
            data-testid="run-findings"
            variants={FADE}
            transition={fadeAfter(afterChips)}
            aria-label={t('step.findings')}
          >
            {step.findings.map((finding) => (
              <li key={finding} className="flex gap-1.5">
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span>{finding}</span>
              </li>
            ))}
          </motion.ul>
        )}
        {step.openPoints && step.openPoints.length > 0 && (
          <motion.p
            className="text-muted-foreground text-[11px] leading-relaxed"
            data-testid="run-open-points"
            variants={FADE}
            transition={fadeAfter(afterChips)}
          >
            <span className="font-medium">{t('step.openPoints')}</span>{' '}
            {step.openPoints.join(' · ')}
          </motion.p>
        )}
      </motion.li>
    </Item>
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

/** The live line of an active phase that has no rounds to show for itself. */
function liveLine(t: Translator, phase: RunPhase): string | null {
  if (phase === 'pruefen') return t('phaseLine.pruefenLive')
  if (phase === 'schreiben') return t('phaseLine.schreibenLive')
  return null
}

/**
 * What each phase did, as acts: the phase, what it produced, how long it took.
 *
 * `dt`/`dd` rows at the document history's own weight — this is the same kind
 * of fact („eingereicht von X am Y") in another vocabulary, and writing it as a
 * second kind of list would make two shapes for one idea. Recherchieren is
 * skipped when it has rounds: the list above IS its account, and repeating the
 * tally here would be the same number twice on one screen.
 */
const PhaseActs: FC<{
  ledger: RunLedger
  live: boolean
  now: number | null
  tallies: RunTallies
}> = ({ ledger, live, now, tallies }) => {
  const t = useTranslations('runs')
  const { locale } = useLocale()
  const rows = RUN_PHASES.flatMap((phase) => {
    const state = phaseState(ledger, phase)
    if (state === 'pending') return []
    if (phase === 'recherchieren' && stepsInPhase(ledger, phase).length > 0) return []
    if (state === 'active') {
      const line = live ? liveLine(t, phase) : null
      return line ? [{ phase, line, duration: null as number | null }] : []
    }
    const line = doneLine(t, phase, tallies)
    const duration = phaseDurationMs(ledger, phase, now ?? 0)
    if (!line && duration === null) return []
    return [{ phase, line, duration }]
  })
  if (rows.length === 0) return null
  return (
    <dl
      className="border-border flex flex-col gap-0.5 border-t px-3 py-2"
      data-testid="run-phase-acts"
    >
      {rows.map(({ phase, line, duration }) => (
        <div
          key={phase}
          className="text-muted-foreground flex gap-1.5 text-[11px]"
          data-phase={phase}
        >
          <dt className="shrink-0 font-medium">{t(`phase.${phase}`)}</dt>
          <dd className="min-w-0 truncate">
            {line}
            {duration !== null && (
              <>
                {line && <Sep />}
                <span className="whitespace-nowrap tabular-nums">
                  {formatDurationElapsed(duration / 1000, locale)}
                </span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
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
  onCancel,
  onWriteNow,
  onContinue,
  connection,
  reviewHref,
  reportHref,
  live: streaming,
  className,
}: RunBlockProps): JSX.Element {
  const t = useTranslations('runs')
  const reduced = useReducedMotion()
  const status = runDisplayStatus(ledger)
  const live = isLiveStatus(status)
  const now = useRunClock(live)

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
  // opens, because the stand says a question is waiting and the body is where
  // the round that asked it sits.
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
      // The body folds only after the stand has said what happened — the
      // track's last segment, the glyph, the line. Folding first would pull the
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

  // The ONE action that fits the state, and the quiet way out beside it — both
  // at the document panel's own button weight (`h-7 text-xs`), so neither
  // shouts across a thread.
  const reviewed = !!review
  const fileHref =
    status === 'fertig' && projectId && ledger.result?.fileId
      ? documentFilesHref(projectId, ledger.result.fileId)
      : null
  const action: ReactNode =
    status === 'wartet' && onAnswer ? (
      <Button
        size="sm"
        variant="secondary"
        className="h-7 px-2 text-xs"
        onClick={onAnswer}
        data-testid="run-action-answer"
      >
        {t('action.answer')}
      </Button>
    ) : status === 'fertig' && !reviewed && reviewHref ? (
      <Button
        size="sm"
        variant="secondary"
        className="h-7 px-2 text-xs"
        asChild
        data-testid="run-action-review"
      >
        <Link href={reviewHref}>{t('action.review')}</Link>
      </Button>
    ) : status === 'fertig' && reviewed && reportHref ? (
      <Button
        size="sm"
        variant="secondary"
        className="h-7 px-2 text-xs"
        asChild
        data-testid="run-action-open-report"
      >
        <Link href={reportHref}>{t('action.openReport')}</Link>
      </Button>
    ) : (status === 'fehlgeschlagen' || status === 'abgebrochen') && onRetry ? (
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={onRetry}
        data-testid="run-action-retry"
      >
        {t('action.retry')}
      </Button>
    ) : fileHref ? (
      // Nothing else fits and the report was filed: the way to it belongs in
      // the stand rather than behind the chevron, because the line above has
      // just said where it is.
      <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" asChild>
        <Link href={fileHref} data-testid="run-file-link">
          <FileText className="size-3.5" aria-hidden />
          {t('action.openInProject')}
        </Link>
      </Button>
    ) : null

  const writeNow: ReactNode =
    onWriteNow && live && activePhase(ledger) === 'recherchieren' ? (
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => void onWriteNow()}
        data-testid="run-action-write-now"
      >
        {t('action.writeNow')}
      </Button>
    ) : null

  const carryForward: ReactNode =
    onContinue && (status === 'fertig' || status === 'unterbrochen') ? (
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground h-7 px-2 text-xs"
        onClick={() => void onContinue()}
        data-testid="run-action-continue"
      >
        {t('action.continue')}
      </Button>
    ) : null

  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const stop: ReactNode =
    onCancel && live ? (
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground h-7 px-2 text-xs"
        onClick={() => setConfirmingCancel(true)}
        data-testid="run-action-cancel"
      >
        {t('action.cancel')}
      </Button>
    ) : null

  // Only while the run is going: a finished run's dead stream is not news.
  const connectionLine =
    streaming && (connection === 'reconnecting' || connection === 'lost')
      ? t(`connection.${connection}`)
      : null

  // `filesToProject` is a CLAIM a caller makes, never inferred. It used to
  // default to „there is a project", which made every freshly-commissioned run
  // in a chat promise „Ergebnis kommt ins Projekt" — including an escalated
  // question whose report lands inline in the thread, which the `fertig` line
  // then correctly contradicts (`fertigFiled` vs `fertigInline`). A block that
  // promises a destination at the start and names a different one at the end
  // has spent the reader's trust to say nothing. Unclaimed, it says only that
  // the run is angelegt, which is the part that is true either way.
  const line = statusLine(t, ledger, status, tallies, filesToProject ?? false)
  const before =
    status === 'fehlgeschlagen' || status === 'abgebrochen'
      ? completedBeforeLabel(t, ledger, tallies)
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

  const rounds = stepsInPhase(ledger, 'recherchieren')
  const reached = RUN_PHASES.filter((phase) => phaseState(ledger, phase) === 'done').length
  const halted = !live && status !== 'fertig' && reached < RUN_PHASES.length
  const closing = before !== null || reviewLine !== null || connectionLine !== null

  return (
    <section
      aria-label={t('block.aria', { title: name, status: statusWord })}
      data-testid="run-block"
      data-status={status}
      className={cn(
        'animate-in fade-in-0 slide-in-from-bottom-1 border-border bg-card duration-base ease-entrance w-full overflow-hidden rounded-xl border motion-reduce:animate-none',
        className
      )}
    >
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        {/* The stand: what it is, how long it has taken, where it stands — in
            that order, top to bottom, the way the document panel puts its badge
            over its track over its sentence. */}
        <div className="flex flex-col gap-2 px-3 py-2.5" data-testid="run-stand">
          {/* WRAPS. „Abbrechen" beside „Antworten" is the widest the stand ever
              gets, and at a phone's 390px it took the title down to three
              characters. Wrapping puts the clock and the buttons on their own
              line there and changes nothing where the row already fits. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <CollapsibleTrigger asChild>
              {/* No aria-label: it would override the visible content, which is
                  the title — and the state is on the section's own label. */}
              <button
                type="button"
                className="duration-snap focus-visible:ring-ring/60 group flex min-w-0 flex-1 basis-40 cursor-pointer items-center gap-2 rounded-md text-left outline-none transition-colors ease-out focus-visible:ring-2 motion-reduce:transition-none"
              >
                <RunStatusGlyph status={status} size="sm" delay={landing?.glyph ?? 0} />
                <span
                  className="text-foreground min-w-0 flex-1 truncate text-xs font-medium"
                  data-testid="run-title"
                >
                  {name}
                </span>
                <ChevronDown className="text-muted-foreground duration-quick size-3.5 shrink-0 transition-transform ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                <span className="sr-only">{t('block.toggle')}</span>
              </button>
            </CollapsibleTrigger>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {elapsed && (
                <span
                  className="text-muted-foreground text-[11px] tabular-nums"
                  aria-label={t('block.elapsedAria', { elapsed })}
                  data-testid="run-elapsed"
                >
                  {elapsed}
                </span>
              )}
              {writeNow}
              {stop}
              {carryForward}
              {action}
            </span>
          </div>

          {/* Five segments, no labels: the line below names the one the run is
              in, so the track reads as a position rather than as a legend. */}
          <StageTrack
            stages={RUN_PHASES}
            reached={reached}
            active={live}
            halted={halted}
            tone={trackTone(status)}
            className="[&>span]:duration-base [&>span]:transition-colors [&>span]:ease-out motion-reduce:[&>span]:transition-none"
            data-testid="run-track"
          />

          {/* The one line that says where it stands. The spoken status word is a
              plain copy beside it: the visible line leads with the phase while
              the run is going, and a reader who cannot see the glyph would
              otherwise never hear „Läuft". */}
          <p
            className={cn(
              'text-xs leading-relaxed',
              status === 'fehlgeschlagen' ? 'text-error' : 'text-muted-foreground'
            )}
            role={live ? 'status' : undefined}
            data-testid="run-status-line"
          >
            <span className="sr-only" data-testid="run-status-word">
              {statusWord}
            </span>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={status}
                aria-hidden
                className="inline-block"
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  transition: reduced
                    ? motionInstant
                    : { ...motionQuick, delay: landing?.word ?? 0 },
                }}
                exit={{
                  opacity: 0,
                  transition: reduced
                    ? motionInstant
                    : { ...motionQuickExit, delay: landing?.word ?? 0 },
                }}
              >
                {line}
              </motion.span>
            </AnimatePresence>
          </p>
        </div>

        {/* The body grows out of the stand — height plus opacity, a
            user-initiated expand. `initial={false}` so a block that mounts open
            does not animate its way there. */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="run-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1, transition: motionBase }}
              exit={{ height: 0, opacity: 0, transition: motionQuick }}
              className="overflow-hidden"
              data-testid="run-body"
            >
              {/* The rounds: one hairline-separated row each, the history's own
                  shape. Keyed by step id, so an appended round is a new element
                  and the rows above it are the same ones, re-rendered. */}
              {rounds.length > 0 && (
                <ItemList as="ol" className="border-border rounded-none border-0 border-t">
                  <AnimatePresence initial={false}>
                    {rounds.map((step, index) => (
                      <RoundRow key={step.id} step={step} index={index} reduced={reduced} />
                    ))}
                  </AnimatePresence>
                </ItemList>
              )}

              <PhaseActs ledger={ledger} live={live} now={now} tallies={tallies} />

              {closing && (
                <motion.div
                  key={`closing-${status}`}
                  initial={landing ? { opacity: 0, y: 4 } : false}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition:
                      reduced || !landing
                        ? motionInstant
                        : { ...motionEntrance, delay: landing.footer },
                  }}
                  className="border-border flex flex-col gap-1.5 border-t px-3 py-2"
                  data-testid="run-footer"
                >
                  {before && (
                    <p
                      className="text-muted-foreground text-[11px] leading-relaxed"
                      data-testid="run-completed-before"
                    >
                      {before}
                    </p>
                  )}
                  {reviewLine && review && (
                    /* The reviewer's words, quoted on the run they are about —
                       the same adjunct a version row renders under itself. */
                    <p
                      className="text-foreground flex items-start gap-1.5 border-l-2 pl-2 text-[11px] leading-[1.5]"
                      data-testid="run-review"
                      data-decision={review.decision}
                    >
                      {review.decision === 'accepted' ? (
                        <CheckCircle2 className="text-success mt-0.5 size-3 shrink-0" aria-hidden />
                      ) : (
                        <XCircle className="text-error mt-0.5 size-3 shrink-0" aria-hidden />
                      )}
                      <span>{reviewLine}</span>
                    </p>
                  )}
                  {connectionLine && (
                    <p
                      className="text-muted-foreground text-[11px] leading-relaxed"
                      role="status"
                      data-testid="run-connection"
                      data-connection={connection}
                    >
                      {connectionLine}
                    </p>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>

      {/* Asked once, and phrased around what survives: the rounds already
          researched stay on screen, which is the fact that decides the answer.
          Warning rather than destructive — a stopped run keeps its work. */}
      {onCancel && (
        <ConfirmDialog
          open={confirmingCancel}
          onOpenChange={setConfirmingCancel}
          title={t('cancel.confirmTitle')}
          description={t('cancel.confirmBody')}
          confirmLabel={t('cancel.confirm')}
          cancelLabel={t('cancel.keep')}
          tone="warning"
          onConfirm={onCancel}
          confirmTestId="run-cancel-confirm"
        />
      )}
    </section>
  )
}

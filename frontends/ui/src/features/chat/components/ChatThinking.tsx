/**
 * ChatThinking — collapsible Herleitung panel (click-dummy overhaul).
 *
 * Collapsed: status + "Herleitung", plus "· m Quellen" when the answer actually
 * rests on any. No step count: see the header-line comment below.
 * Expanded: the connected reasoning-chain (`ReasoningChain`) — the framing node,
 * a spine of checkpoints when the turn searched more than once (each with the
 * tools it called and the files THAT fetch returned), and the findings node,
 * plus the technical step tail. A HITL choice is answered in its own prompt
 * card in the thread, not in here.
 * Every node binds to real streamed data or is hidden; nothing is fabricated.
 */

'use client'

import {
  type FC,
  type ReactNode,
  forwardRef,
  memo,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from 'react'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { cn } from '@/lib/utils'
import {
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  CircleArrowRight,
  CircleMinus,
  CircleSlash,
  Clock,
} from 'lucide-react'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  motion,
  AnimatePresence,
  motionBase,
  motionInstant,
  motionQuick,
  motionQuickExit,
  useIconSwapTransition,
} from '@/components/motion'
import type { Transition, Variants } from 'motion/react'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { CitationSource } from '../types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import { deriveTraceLanes } from '../lib/trace-lanes'
import { buildCitationModel } from '../lib/citations'
import { liveLine } from '../lib/turn-events'
import { deriveExecutedSteps } from '../lib/executed-steps'
import { useElapsedSeconds, formatElapsed, type ElapsedSince } from '../hooks/use-elapsed-seconds'
import { ReasoningFlow } from './reasoning/ReasoningFlow'
import { buildFileChips } from './reasoning/context'

/**
 * How a turn ended that has no answer of its own to be „Fertig" with: it
 * failed (`failed`, its error card below says how), it commissioned a run
 * (`handed_off`, the work has only begun, in the run block below), or Piloti
 * did not take it on (`refused`, said by the banner below).
 */
export type ThinkingEnding = 'failed' | 'handed_off' | 'refused'

export interface ChatThinkingProps {
  /** Array of thinking steps to display */
  steps: StoredThinkingStep[]
  /** Whether thinking is in progress (shows spinner when true, check when done) */
  isThinking?: boolean
  /** Whether the response was interrupted (page refresh / browser close mid-stream) */
  isInterrupted?: boolean
  /**
   * Whether an interrupted-answer recovery fetch is currently in flight (FIX 3).
   * When set on an otherwise-interrupted turn, the calmer "reconnecting —
   * checking for a finished answer" copy is shown instead of the "lost" notice,
   * so the UI does not race the async recovery to declare the answer gone.
   */
  isRecoveryPending?: boolean
  /** Whether waiting for user response (HITL prompt pending) */
  isWaiting?: boolean
  /**
   * The reader pressed Stop. The turn ended, but nothing was finished: the
   * header says „Gestoppt" with the neutral glyph a cancelled run carries, never
   * the green check — the last thing a stopped turn shows must not claim done.
   */
  isStopped?: boolean
  /**
   * The turn ended without an answer to be done with. Never the green check:
   * a run that has only started, or a question that was not taken on, are not
   * finished work.
   */
  endedAs?: ThinkingEnding
  /**
   * Data sources that were toggled ON in the composer when this message was
   * sent — AVAILABILITY, not activity, and therefore not rendered.
   *
   * Kept as an accepted prop because callers still pass it and because the
   * value is a real fact about the composer; what it is not is a fact about
   * what this turn did. Rendering it inside the Herleitung is exactly the
   * phantom-web-search bug: every source is enabled by default, so the row
   * claimed `Websuche` on every turn, including greetings where the backend
   * had already dropped every data-source tool. What ran comes from
   * `deriveExecutedSteps` (the `Ausgeführt:` row), which is built from the
   * turn's `tool` and `skill` steps.
   */
  enabledDataSources?: string[]
  /** Files attached to THIS message — a per-turn fact, so these are shown. */
  messageFiles?: Array<{ id: string; fileName: string }>
  /** Verbatim text of the triggering user message (framing node reframe). */
  userQuestion?: string
  /** The turn's answer confidence, if answered (assessment node). */
  answerConfidence?: 'low' | 'medium' | 'high'
  /** The turn's structured citations, if any (assessment node). */
  citations?: CitationSource[]
  /** Set when this turn escalated shallow→deep — framing-node narration. */
  escalationReason?: string
  /**
   * The answer message's `retrievalLedger` — the backend's own account of what
   * each retrieval round returned. Passed straight through to the spine, which
   * builds a round's fan from it when it has that round. Absent (older turns,
   * a turn that recorded none) and the spine matches filenames as before.
   */
  retrievalLedger?: RetrievalLedger
  /**
   * The answer has begun to stream on this live turn. The header stays live
   * (`isThinking`) until the answer settles, but stops working-shimmering: the
   * caret is the turn's one moving thing from here, and the header line says
   * what the panel holds instead of what Piloti is doing.
   */
  answering?: boolean
  /**
   * When the turn started (the question's timestamp). The elapsed figure counts
   * from here, so it reads the same however late the panel mounted.
   */
  since?: ElapsedSince
  /**
   * The settled answer's own duration. Once the turn ends the figure freezes
   * on it, so the header and the answer's footer never disagree by a second.
   */
  answerDurationMs?: number
  /** Render the Herleitung expanded on first mount (e.g. the current turn). */
  defaultOpen?: boolean
  /**
   * Turn-driven desired open state. When set, the Herleitung follows it: the
   * caller holds it open while the turn is working and lets it go the moment
   * the answer starts (the fold), so the answer streams in where the reader is
   * already looking. The reader can still toggle it by hand; a later change to
   * this value re-drives a panel the reader never touched.
   */
  autoOpen?: boolean
}

/** Why the content is leaving: the turn folded it, or the reader closed it. */
type CloseReason = 'fold' | 'toggle'

interface Disclosure {
  open: boolean
  closeReason: CloseReason
  /** The prop this state was last derived from (derive-from-props). */
  autoOpen: boolean | undefined
  /** The reader has opened or closed the panel by hand. */
  userToggled: boolean
  /** The panel is open because the TURN opened it. */
  autoOpened: boolean
}

/**
 * The next disclosure for new props, or the same object when nothing changes.
 *
 * Computed DURING render (React's "adjust state when a prop changes"), not in
 * an effect. An effect committed one render with the new props and the old
 * `open` first: the fold then started a frame late, and the content that left
 * had already re-rendered with the props it was leaving under.
 */
//
// A wait or an interruption does not open it: the choice is answered in its
// prompt card and the interruption notice sits under the header, so opening
// the graph only pushed both further from the reader.
const nextDisclosure = (d: Disclosure, autoOpen: boolean | undefined): Disclosure => {
  let next = d
  if (autoOpen !== undefined && autoOpen !== d.autoOpen) {
    const wasDriven = d.autoOpen === true
    next = { ...next, autoOpen }
    if (autoOpen && !d.userToggled) {
      // Opened by the turn (or reopened by a retracted answer). A reader who
      // has toggled this panel is never overruled.
      next = { ...next, open: true, autoOpened: true }
    } else if (!autoOpen && wasDriven) {
      // The fold: only a panel the turn opened, that the reader left alone.
      if (!d.userToggled && d.autoOpened) next = { ...next, open: false, closeReason: 'fold' }
      next = { ...next, autoOpened: false }
    }
  }
  return next
}

/**
 * The live panel's content is capped and scrolls inside itself, pinned to its
 * newest row, so a Herleitung that grows past the viewport does not push the
 * answer it is about to fold into below the fold. Pinned only while the reader
 * is at its bottom: one who scrolled up inside it to read stays put. The top
 * edge fades (`data-overflow`) only while there is something above to fade.
 * Imperative and frame-synchronous: nothing here renders.
 */
const useBottomPin = (enabled: boolean) => {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el) return
    if (!enabled) {
      el.dataset.overflow = 'false'
      return
    }
    let pinned = true
    const pin = () => {
      el.dataset.overflow = el.scrollHeight > el.clientHeight ? 'true' : 'false'
      if (pinned) el.scrollTop = el.scrollHeight
    }
    const onScroll = () => {
      pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
    }
    pin()
    const observer = new ResizeObserver(pin)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [el, enabled])
  return setEl
}

/** Phase announcements are at least this far apart, so a fast turn does not queue them. */
const PHASE_NOTE_MIN_GAP_MS = 3000

/**
 * `text`, but changing at most once per `gapMs`: a change inside the gap waits
 * for its end, and only the latest one is shown then.
 */
const useThrottledText = (text: string, gapMs: number): string => {
  const [shown, setShown] = useState(text)
  const [shownAt, setShownAt] = useState(0)
  useEffect(() => {
    if (text === shown) return
    const wait = Math.max(0, shownAt + gapMs - Date.now())
    const id = setTimeout(() => {
      setShown(text)
      setShownAt(Date.now())
    }, wait)
    return () => clearTimeout(id)
  }, [text, shown, shownAt, gapMs])
  return shown
}

type HeaderStatus =
  | 'live'
  | 'waiting'
  | 'recovering'
  | 'interrupted'
  | 'stopped'
  | 'failed'
  | 'handedOff'
  | 'refused'
  | 'done'

const ChatThinkingView: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isRecoveryPending = false,
  isWaiting = false,
  isStopped = false,
  endedAs,
  // `enabledDataSources` is intentionally NOT destructured: it is accepted (see
  // the prop doc) and deliberately not rendered anywhere.
  messageFiles = [],
  userQuestion = '',
  answerConfidence,
  citations,
  escalationReason,
  retrievalLedger,
  answering = false,
  since,
  answerDurationMs,
  defaultOpen = false,
  autoOpen,
}) => {
  const t = useTranslations('chat')
  const reducedMotion = useReducedMotion()

  const [disclosure, setDisclosure] = useState<Disclosure>(() => ({
    open: autoOpen ?? defaultOpen,
    closeReason: 'toggle',
    autoOpen,
    userToggled: false,
    autoOpened: autoOpen ?? defaultOpen,
  }))
  const derived = nextDisclosure(disclosure, autoOpen)
  if (derived !== disclosure) setDisclosure(derived)
  const { open, closeReason } = derived

  // Opening a settled Herleitung mounts its whole graph: a 190–250 ms task on
  // a 4× throttled phone, and frame gaps of 300–417 ms while the panel grew
  // (Herleitung audit, 2026-09). As a transition the mount is rendered in
  // slices the browser can paint between; the header shows the new state at
  // once through `opening`.
  const [opening, startOpening] = useTransition()
  const handleOpenChange = (next: boolean) => {
    if (!isThinking) setCapped(false)
    const apply = () =>
      setDisclosure((d) => ({ ...d, open: next, closeReason: 'toggle', userToggled: true }))
    if (next && !isThinking) startOpening(apply)
    else apply()
  }

  const sourceCards = useMemo(
    () => buildCitationModel({ traceLanes: deriveTraceLanes(steps), citations }),
    [steps, citations]
  )
  // Unique source cards (hits + gaps) — bar "m Quellen", not sum of Treffer.
  const sourceCount = sourceCards.length

  // Basis footer: the files attached to this message, as clean pills. Data
  // sources deliberately do NOT appear here — see `enabledDataSources` above.
  const fileChips = useMemo(() => buildFileChips(messageFiles), [messageFiles])

  // Live status: what the assistant is doing right now (derived from the newest
  // streamed step) plus a seconds-elapsed cue, so a slow turn reads as active
  // work in progress rather than a frozen spinner. The count runs from the
  // question, not from this panel's mount: from the send this header IS the
  // working cue, and its figure never restarts.
  const liveActivity = liveLine(steps, t)
  const activityLabel = liveActivity ?? t('thinking.working')
  // It keeps counting through a HITL wait: the turn is still open, and a
  // figure that froze while the reader chose and then jumped by the wait read
  // as a glitch.
  const elapsedSeconds = useElapsedSeconds(isThinking || isWaiting, since)
  // Whether this mount watched the turn live: only then does the settled
  // header keep the frozen figure, so a turn does not lose its timer the
  // moment it lands, and a restored one does not grow one.
  const [sawLive, setSawLive] = useState(isThinking)
  if (isThinking && !sawLive) setSawLive(true)

  // What the status region says: the PHASE, never the per-step phrase, and
  // nothing for done or stopped, which the thread says once with the answer.
  const phaseNote = isThinking
    ? answering
      ? t('thinking.working')
      : t('thinking.inProgress')
    : isWaiting
      ? t('thinking.waiting')
      : isInterrupted
        ? isRecoveryPending
          ? t('thinking.recovering')
          : t('thinking.interrupted')
        : ''
  const spokenPhase = useThrottledText(phaseNote, PHASE_NOTE_MIN_GAP_MS)

  // The live cap. It holds past the settle for a panel the reader opened while
  // the turn worked: released in the settle's frame, the full graph would grow
  // above the answer they are reading. Their next toggle releases it.
  const [capped, setCapped] = useState(isThinking)
  if (isThinking && !capped) setCapped(true)
  const pinRef = useBottomPin(capped && open)

  // "What actually ran" — one compact chip per executed agent/tool, so the
  // Herleitung names its steps without the technical-steps opt-in.
  //
  // Skill chips are LIVE-ONLY. While the turn is open they are the only place
  // the reader can see that three skills were applied, because the header line
  // replaces rather than accumulates. Once the answer lands, `SkillsUsedDisclosure`
  // sits directly beneath it and reports the same activations WITH their
  // descriptions — so keeping the chips would give one fact two owners, and the
  // one with less to say would be making the claim twice. Same label authority
  // either way (`features/skills/lib/skill-activity`), so the two can never
  // word it differently.
  const executedSteps = useMemo(() => {
    const derivedSteps = deriveExecutedSteps(steps, t)
    if (isThinking) return derivedSteps
    return derivedSteps.filter((s) => !s.skill)
  }, [steps, t, isThinking])

  // Availability alone must never conjure a Herleitung: `enabledDataSources` is
  // non-empty on essentially every turn, so including it here made the panel
  // appear (and claim sources) for turns that did nothing.
  const hasSignal =
    steps.length > 0 ||
    messageFiles.length > 0 ||
    Boolean(answerConfidence) ||
    (citations?.length ?? 0) > 0 ||
    Boolean(escalationReason?.trim()) ||
    userQuestion.trim().length > 0

  if (!hasSignal) {
    return null
  }

  // The header line names the panel and, when there are any, counts sources.
  //
  // It carries NO step count. `steps` counts status lines, skill bookkeeping
  // and sources rows alongside the tools that ran, so the number is neither
  // turns nor calls, and read as "the agent took 19 turns". What ran is listed
  // inside, as chips.
  //
  // The source clause is ABSENT rather than „0 Quellen": an answer grounded in
  // a measurement of the model rightly has no citations, and zero reads as a
  // failure to find anything.
  const summaryLabel =
    sourceCount > 0
      ? t('thinking.herleitungSummaryWithSources', { count: sourceCount })
      : t('thinking.herleitungSummary')

  const status: HeaderStatus = isThinking
    ? 'live'
    : isWaiting
      ? 'waiting'
      : isInterrupted && isRecoveryPending
        ? 'recovering'
        : isInterrupted
          ? 'interrupted'
          : isStopped
            ? 'stopped'
            : endedAs === 'failed'
              ? 'failed'
              : endedAs === 'handed_off'
              ? 'handedOff'
              : endedAs === 'refused'
                ? 'refused'
                : 'done'
  // The phase in words, for the screen reader's name and the ending's word.
  const statusLabel: Record<HeaderStatus, string> = {
    live: answering ? t('thinking.working') : t('thinking.inProgress'),
    waiting: t('thinking.waiting'),
    recovering: t('thinking.recovering'),
    interrupted: t('thinking.interrupted'),
    stopped: t('thinking.stopped'),
    failed: t('thinking.failed'),
    handedOff: t('thinking.handedOff'),
    refused: t('thinking.refused'),
    done: t('thinking.done'),
  }
  // The label is the activity while Piloti works toward an answer, and the
  // panel's name (the summary) from the answer's first word on, in every state
  // after that. It does NOT change at the settle: the summary stayed where the
  // reader had it, and only the glyph (dot → check) and the frozen figure say
  // the turn is over. „Fertig" in its place swapped the label at the settle
  // and moved the summary from the left of the row to the right.
  const shimmer = status === 'live' && !answering
  const label = shimmer ? activityLabel : summaryLabel
  // The phase in a word: what the trigger is named by and what is announced.
  const phaseWord = statusLabel[status]
  // An ending that is not „done" says so in a word on the right, beside the
  // figure, where it moves nothing on the left.
  const endingWord = status === 'live' || status === 'done' ? null : statusLabel[status]

  // The figure ticks while the turn works and FREEZES when it ends — on the
  // answer's own duration when the footer has one — instead of vanishing.
  // Never below the last live figure, which the count froze on: the duration
  // is measured from the send and the count from the question's timestamp, a
  // few hundred ms apart, and a settle that ticked the figure BACK by a second
  // read as a glitch at the one moment the reader looks at it.
  const shownSeconds =
    !isThinking && answerDurationMs !== undefined
      ? Math.max(Math.floor(answerDurationMs / 1000), sawLive ? elapsedSeconds : 0)
      : elapsedSeconds
  const showElapsed = sawLive && shownSeconds > 2

  // Every state swap in the header is a cross-fade on the house pair, entrance
  // in and exit easing out, overlapping (`popLayout`) so a new activity phrase
  // is never held back behind the old one's exit. Reduced motion: instant.
  const enter = reducedMotion ? motionInstant : motionQuick
  const leave = reducedMotion ? motionInstant : motionQuickExit
  const swap = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: enter },
    exit: { opacity: 0, transition: leave },
  }

  // No entrance of its own: it mounts with its question, and the thread row
  // (`ChatArea`) owns that entrance, gated so a restored turn does not replay it.
  return (
    <div className="w-full rounded-2xl bg-muted shadow-xs">
      <Collapsible open={open || opening} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger asChild>
          {/* The trigger's name is the PHASE and the panel (`sr-only` below),
              not the visual line: the live activity phrase changes with every
              step, and a button whose name changes that often is re-read on
              every change, a queue of phrases already out of date. The
              phase is announced from a status outside the button. */}
          <button
            type="button"
            data-herleitung-trigger
            className="group relative flex min-h-12 w-full cursor-pointer items-center justify-between rounded-2xl px-4 py-3 text-left outline-none transition-colors duration-snap ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="sr-only">{`${phaseWord} · ${summaryLabel}`}</span>
            {/* `relative`: `popLayout` lifts the leaving icon and phrase out of
                the flow, positioned against this box. */}
            <span className="relative flex min-w-0 items-center gap-2" aria-hidden="true">
              {/* Fixed icon slot, shared by every state: without it the text
                  starts at a different x whenever the status changes, and the
                  row visibly jumps at the moment the reader looks at it. */}
              <AnimatePresence mode="popLayout" initial={false}>
                <StatusIcon key={status} status={status} t={t} enter={enter} leave={leave} />
              </AnimatePresence>
              {/* `wait`: the old phrase leaves before the new one arrives. Two
                  phrases of different widths cross-fading at one origin read
                  as one garbled word for a few frames („Fertigtung"). */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={label}
                  className={cn(
                    'min-w-0 text-sm font-semibold',
                    shimmer ? undefined : 'text-foreground'
                  )}
                  {...swap}
                >
                  {/* The one ambient loop before the answer: the shimmer, on an
                      inner element that moves by transform only, since the
                      cross-fade owns this span's opacity. */}
                  {shimmer ? <ShimmerText className="block">{label}</ShimmerText> : label}
                </motion.span>
              </AnimatePresence>
            </span>

            <span className="relative flex shrink-0 items-center gap-2" aria-hidden="true">
              <AnimatePresence mode="wait" initial={false}>
                {endingWord && (
                  <motion.span key={endingWord} className="text-xs font-medium text-muted-foreground" {...swap}>
                    {endingWord}
                  </motion.span>
                )}
              </AnimatePresence>
              <AnimatePresence mode="popLayout" initial={false}>
                {showElapsed && (
                  // A reserved width and tabular digits, so 9 s → 10 s does
                  // not nudge what sits beside it.
                  <motion.span
                    key="elapsed"
                    className="min-w-[3.5ch] text-right text-xs font-medium tabular-nums text-muted-foreground"
                    {...swap}
                  >
                    {formatElapsed(shownSeconds)}
                  </motion.span>
                )}
              </AnimatePresence>
              {/* While the label is the activity, the summary sits here, from
                  `sm` up: beside it, at 390 px, the label read only „Such…"
                  (Herleitung audit, 2026-09). From the answer's first word the
                  label IS the summary, and this slot stays empty for good. */}
              {shimmer && <span className="hidden text-xs text-muted-foreground sm:inline">{summaryLabel}</span>}
              <ChevronDown className="size-4 text-muted-foreground transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </span>
          </button>
        </CollapsibleTrigger>

        {/* Expanded content. It fades in (no height: growing it laid the page
            out on every frame while the graph inside was still mounting, 300–
            417 ms frame gaps on a phone, Herleitung audit 2026-09).

            How it leaves depends on why (`custom`). The FOLD, when the answer
            starts: the content fades on the exit easing with its height held,
            then gives up its height in one frame while invisible, so the reader
            never watches a box slide. A reader's own close keeps the collapse
            (height and opacity together), on the exit easing. Reduced motion:
            both instant. `overflow-hidden` so the collapse clips.

            While the turn works the content is capped and scrolls inside
            itself, pinned to the newest row (`useBottomPin`); a reader who
            opens a settled one gets all of it (`capped`). */}
        <AnimatePresence initial={false} custom={{ reason: closeReason, reducedMotion }}>
          {open && (
            <motion.div
              key="herleitung-content"
              custom={{ reason: closeReason, reducedMotion }}
              variants={contentVariants}
              initial="hidden"
              animate="shown"
              exit="leave"
              // `overflow-anchor: none`: the browser must not pick its scroll
              // anchor inside a box that is about to leave, or it scrolls the
              // page to follow it while it collapses.
              className="overflow-hidden [overflow-anchor:none]"
            >
              <div
                ref={pinRef}
                className={cn(
                  capped &&
                    'max-h-[min(50svh,420px)] overflow-y-auto overscroll-contain data-[overflow=true]:[mask-image:linear-gradient(to_bottom,transparent,black_24px)]'
                )}
              >
                <div>
                  {/* Executed steps — what actually ran, as compact chips,
                      ABOVE the graph. Below it, the row was shoved down by
                      every row the live graph gained (motion audit, 2026-10);
                      above, a new chip only ever extends its own line. */}
                  {/* Reserved while the panel is capped (live, or opened while
                      live), invisible until its first chip: arriving with the
                      first tool, the row pushed the graph below it down by its
                      64 px in the middle of the steps phase. And kept, invisible,
                      when the settle drops the live-only skill chips, so an open
                      panel does not lose the row's height at the settle. */}
                  {(executedSteps.length > 0 || capped) && (
                    <div
                      className={cn(
                        'border-base flex flex-col gap-2 border-t px-4 pb-1 pt-3',
                        executedSteps.length === 0 && 'invisible'
                      )}
                      aria-hidden={executedSteps.length === 0 || undefined}
                    >
                      <SectionLabel>{t('thinking.executedSteps')}</SectionLabel>
                      {/* min-h: one chip's line, held before the first chip. */}
                      <div className="flex min-h-6 flex-wrap gap-1.5">
                        {executedSteps.map((s) => (
                          <span
                            key={s.key}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground"
                          >
                            {/* Static: the header's shimmer is the turn's one
                                ambient loop, and a pulsing dot per running chip
                                made several. */}
                            {s.running && (
                              <span aria-hidden="true" className="size-1.5 rounded-full bg-brand" />
                            )}
                            {/* A skill with no authored title is named by its bare
                                `/identifier`, so the identifier half renders
                                `font-mono` — the same way `SkillsUsedDisclosure`
                                writes it under the finished answer. One label
                                authority, one appearance. */}
                            {s.mono ? (
                              <>
                                {s.prefix && <span>{s.prefix}</span>}
                                <span className="font-mono">{s.mono}</span>
                              </>
                            ) : (
                              s.label
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div
                    className={cn(
                      'px-2 pb-3 pt-3 sm:px-4',
                      executedSteps.length === 0 && !capped && 'border-base border-t'
                    )}
                  >
                    <ReasoningFlow
                      steps={steps}
                      userQuestion={userQuestion}
                      answerConfidence={answerConfidence}
                      citations={citations}
                      escalationReason={escalationReason}
                      retrievalLedger={retrievalLedger}
                      live={isThinking}
                      sourceCards={sourceCards}
                    />
                  </div>

                  {/* Basis footer — the files attached to this message, as clean
                      pills. Only shown when the Herleitung is expanded. */}
                  {fileChips.length > 0 && (
                    <div className="flex flex-col gap-2 border-t border-border px-4 pb-4 pt-3">
                      <SectionLabel>{t('thinking.attachedFiles')}</SectionLabel>
                      <div className="flex flex-wrap gap-1.5">
                        {fileChips.map((chip) => (
                          <span
                            key={chip}
                            className="whitespace-nowrap rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground"
                          >
                            {chip}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>

      {/* The phase, said politely and at most every few seconds — outside the
          button, on a region mounted with the panel. A settled or stopped turn
          is said by the thread (`ChatArea`), once, with the answer's gist. */}
      <span className="sr-only" role="status" aria-live="polite">
        {spokenPhase}
      </span>

      {/* Mid-turn drop notice: a silent reconnect can leave a turn without any
          response. The collapsed header only shows a muted "Interrupted" chip,
          which does not tell the user what to do — so surface a compact,
          always-visible line (protocol-robustness item 4). While recovery is
          still in flight (FIX 3) show a calm "checking for a finished answer"
          line; only once recovery has settled with nothing found do we prompt
          a resend. */}
      {isInterrupted && isRecoveryPending ? (
        <div className="flex items-start gap-2 border-t border-border px-4 pb-3 pt-2.5">
          <Spinner
            size="xs"
            className="mt-0.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-xs leading-relaxed text-muted-foreground" role="status">
            {t('thinking.recoveringNotice')}
          </span>
        </div>
      ) : isInterrupted ? (
        <div className="flex items-start gap-2 border-t border-border px-4 pb-3 pt-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="text-xs leading-relaxed text-muted-foreground" role="status">
            {t('thinking.interruptedNotice')}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** What decides how the expanded content leaves (`AnimatePresence` `custom`). */
interface ContentExit {
  reason: CloseReason
  reducedMotion: boolean
}

const contentVariants: Variants = {
  hidden: { opacity: 0 },
  shown: ({ reducedMotion }: ContentExit) => ({
    opacity: 1,
    height: 'auto',
    transition: reducedMotion ? motionInstant : motionBase,
  }),
  leave: ({ reason, reducedMotion }: ContentExit) => {
    if (reducedMotion) return { opacity: 0, height: 0, transition: motionInstant }
    if (reason === 'toggle') return { opacity: 0, height: 0, transition: motionQuickExit }
    // The fold: fade with the height held, then drop the height in one frame
    // once nothing of it is visible.
    return {
      opacity: 0,
      height: 0,
      transition: {
        opacity: motionQuickExit,
        height: { duration: 0, delay: motionQuickExit.duration },
      },
    }
  },
}

interface StatusIconProps {
  status: HeaderStatus
  t: ReturnType<typeof useTranslations>
  enter: Transition
  leave: Transition
}

/**
 * The header's fixed 20 px icon slot, one keyed child per status so the slot
 * cross-fades. Nothing in it loops: while the turn works the label's shimmer
 * is the one ambient motion, and a spinner beside it made two. The settle's
 * check arrives with a small spring (scale 0.7 → 1) — the end of the turn is
 * the moment worth marking.
 */
const StatusIcon = forwardRef<HTMLSpanElement, StatusIconProps>(function StatusIcon(
  { status, t, enter, leave },
  ref
) {
  const settled = status === 'done'
  // The check's pop: a spring on scale only, its opacity on the quick tween
  // (opacity has nothing to overshoot), both instant under reduced motion.
  const iconSwap = useIconSwapTransition()
  const glyph: Record<HeaderStatus, ReactNode> = {
    live: (
      <span
        role="img"
        aria-label={t('thinking.inProgress')}
        className="size-2 rounded-full bg-brand"
      />
    ),
    waiting: <Clock className="size-5" aria-hidden="true" />,
    recovering: <span aria-hidden="true" className="size-2 rounded-full bg-muted-foreground" />,
    interrupted: <AlertTriangle className="size-5" aria-hidden="true" />,
    stopped: <CircleSlash className="size-5" aria-hidden="true" />,
    failed: <AlertTriangle className="size-5" aria-hidden="true" />,
    handedOff: <CircleArrowRight className="size-5" aria-hidden="true" />,
    refused: <CircleMinus className="size-5" aria-hidden="true" />,
    done: <CheckCircle2 className="size-5" aria-hidden="true" />,
  }
  const tone: Record<HeaderStatus, string> = {
    live: '',
    waiting: 'text-brand',
    recovering: '',
    interrupted: 'text-warning',
    stopped: 'text-muted-foreground',
    failed: 'text-warning',
    handedOff: 'text-brand',
    refused: 'text-muted-foreground',
    done: 'text-success',
  }
  return (
    <motion.span
      ref={ref}
      className={cn('flex size-5 shrink-0 items-center justify-center', tone[status])}
      initial={settled ? { opacity: 0, scale: 0.7 } : { opacity: 0 }}
      animate={{
        opacity: 1,
        scale: 1,
        transition: settled ? iconSwap.enter : enter,
      }}
      exit={{ opacity: 0, transition: leave }}
    >
      {glyph[status]}
    </motion.span>
  )
})

/**
 * Memoised: the thread renders one per turn, and the list re-renders on every
 * delta flush of the live answer. Unmemoised, every earlier turn's Herleitung
 * re-rendered per flush (723 renders in one answer of a 40-message thread,
 * React performance audit 2026-09). ChatArea keeps `steps` referentially
 * stable for that reason.
 */
export const ChatThinking = memo(ChatThinkingView)

/**
 * ChatThinking — collapsible Herleitung panel (click-dummy overhaul).
 *
 * Collapsed: status + "Herleitung · n Schritte", plus "· m Quellen" when the
 * answer actually rests on any.
 * Expanded: the connected reasoning-chain (`ReasoningChain`) — the framing node,
 * the parallel Quellen fan-out, the assessment node, and (when a live HITL
 * choice exists) the next-steps branches, plus the technical NAT-step tail.
 * Every node binds to real streamed data or is hidden; nothing is fabricated.
 */

'use client'

import { type FC, useMemo, useState, useEffect, useRef } from 'react'
import { ChevronDown, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import { Collapsible, CollapsibleTrigger } from '@/components/ui/collapsible'
import { motion, AnimatePresence, motionQuick } from '@/components/motion'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { ThinkingStep, CitationSource } from '../types'
import { deriveTraceLanes } from '../lib/trace-lanes'
import { buildCitationModel } from '../lib/citations'
import { deriveLiveActivity } from '../lib/live-activity'
import { deriveExecutedSteps } from '../lib/executed-steps'
import { isSkillStepName, isUseSkillStepName } from '@/features/skills/lib/skill-activity'
import { useElapsedSeconds, formatElapsed } from '../hooks/use-elapsed-seconds'
import { ReasoningFlow } from './reasoning/ReasoningFlow'
import { type ChoicePrompt } from './reasoning'
import { buildFileChips } from './reasoning/context'

export interface ChatThinkingProps {
  /** Array of thinking steps to display */
  steps: ThinkingStep[]
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
   * Data sources that were toggled ON in the composer when this message was
   * sent — AVAILABILITY, not activity, and therefore not rendered.
   *
   * Kept as an accepted prop because callers still pass it and because the
   * value is a real fact about the composer; what it is not is a fact about
   * what this turn did. Rendering it inside the Herleitung is exactly the
   * phantom-web-search bug: every source is enabled by default, so the row
   * claimed `Websuche` on every turn, including greetings where the backend
   * had already dropped every data-source tool. What ran comes from
   * `deriveExecutedSteps` (the `Ausgeführt:` row), which is built from real
   * Function Start/Complete frames.
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
  /** A live HITL multiple-choice prompt for this turn (next-steps node). */
  choicePrompt?: ChoicePrompt
  /** Respond to the HITL choice prompt. */
  onChoiceRespond?: (promptId: string, choice: string) => void
  /** Set when this turn escalated shallow→deep — framing-node narration. */
  escalationReason?: string
  /** Render the Herleitung expanded on first mount (e.g. the current turn). */
  defaultOpen?: boolean
  /**
   * Turn-driven desired open state (P0). When set, the Herleitung follows it:
   * auto-EXPANDED while the turn is live (thinking / awaiting input) and
   * auto-COLLAPSES to the one-line bar once the answer lands — a smooth,
   * animated transition, not a jump. The user can still toggle it by hand; a
   * later change to this value (e.g. live→done) re-drives the panel.
   */
  autoOpen?: boolean
}

export const ChatThinking: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isRecoveryPending = false,
  isWaiting = false,
  // `enabledDataSources` is intentionally NOT destructured: it is accepted (see
  // the prop doc) and deliberately not rendered anywhere.
  messageFiles = [],
  userQuestion = '',
  answerConfidence,
  citations,
  choicePrompt,
  onChoiceRespond,
  escalationReason,
  defaultOpen = false,
  autoOpen,
}) => {
  const t = useTranslations('chat')

  // Controlled open state. Seeded from the turn-driven `autoOpen` (or the
  // uncontrolled `defaultOpen` fallback), then re-driven whenever `autoOpen`
  // flips — so a turn expands live and collapses on completion — while still
  // honouring a manual toggle in between.
  const [open, setOpen] = useState<boolean>(autoOpen ?? defaultOpen)
  const prevAutoOpen = useRef<boolean | undefined>(autoOpen)
  useEffect(() => {
    if (autoOpen !== undefined && autoOpen !== prevAutoOpen.current) {
      prevAutoOpen.current = autoOpen
      setOpen(autoOpen)
    }
  }, [autoOpen])

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
  // work in progress rather than a frozen spinner.
  const liveActivity = deriveLiveActivity(steps, t)
  const activityLabel = liveActivity ?? t('thinking.working')
  const elapsedSeconds = useElapsedSeconds(isThinking)

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
    const derived = deriveExecutedSteps(steps, t)
    if (isThinking) return derived
    return derived.filter((s) => !isSkillStepName(s.key) && !isUseSkillStepName(s.key))
  }, [steps, t, isThinking])

  // Availability alone must never conjure a Herleitung: `enabledDataSources` is
  // non-empty on essentially every turn, so including it here made the panel
  // appear (and claim sources) for turns that did nothing.
  const hasSignal =
    steps.length > 0 ||
    messageFiles.length > 0 ||
    Boolean(answerConfidence) ||
    (citations?.length ?? 0) > 0 ||
    Boolean(choicePrompt) ||
    Boolean(escalationReason?.trim()) ||
    userQuestion.trim().length > 0

  if (!hasSignal) {
    return null
  }

  // The header line, assembled from clauses rather than from one template with
  // two slots. The step count has to pluralise — one step read „1 Schritte" —
  // and the source count has to be able to say NOTHING, because an answer
  // grounded in a measurement of the model rather than in a citation has no
  // sources, and „0 Quellen" is a true number that reads as a failure. A turn
  // that has not reported a step yet gets the bare name for the same reason.
  const stepsLabel =
    steps.length > 0
      ? t('thinking.herleitungSummary', { count: steps.length })
      : t('thinking.herleitungSummaryNoSteps')
  const summaryLabel =
    sourceCount > 0
      ? t('thinking.herleitungSummaryWithSources', { summary: stepsLabel, count: sourceCount })
      : stepsLabel

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 w-full rounded-2xl bg-muted shadow-xs duration-base ease-entrance motion-reduce:animate-none">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          {/* No aria-label on the trigger: it would OVERRIDE the visible
              content, hiding exactly what a non-sighted reader needs — the
              status word („Denke nach" / „Unterbrochen" / „Wartet") and the
              live activity phrase. The accessible name is the content itself. */}
          <button
            type="button"
            className="group relative flex min-h-12 w-full cursor-pointer items-center justify-between rounded-2xl px-4 pb-4 pt-3 text-left outline-none transition-colors duration-snap ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {/* aria-live sits HERE, on a stable element: it used to sit on the
                keyed motion.span inside AnimatePresence, which is unmounted and
                remounted per step — a live region created WITH its content, which
                most AT never announces. On a stable region, each new phrase is an
                addition and is read out. The elapsed timer lives in the sibling
                span, so it does not chatter once a second. */}
            <span className="flex min-w-0 items-center gap-2" aria-live="polite">
              {isThinking ? (
                <>
                  <Spinner size="sm" label={t('thinking.inProgress')} />
                  {/* The live activity phrase cross-fades as each new step
                      arrives, and shimmers while it holds — a quiet cue that
                      work is actively moving during a long wait. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={activityLabel}
                      className="animate-text-shimmer truncate text-sm font-semibold motion-reduce:animate-none"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={motionQuick}
                    >
                      {activityLabel}
                    </motion.span>
                  </AnimatePresence>
                </>
              ) : isWaiting ? (
                <>
                  <span className="text-brand">
                    <Clock className="size-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.waiting')}
                  </span>
                </>
              ) : isInterrupted && isRecoveryPending ? (
                <>
                  <Spinner size="sm" className="text-muted-foreground" aria-hidden="true" />
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.recovering')}
                  </span>
                </>
              ) : isInterrupted ? (
                <>
                  <span className="text-warning">
                    <AlertTriangle className="size-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.interrupted')}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-success">
                    <CheckCircle2 className="size-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.done')}
                  </span>
                </>
              )}
            </span>

            <span className="flex shrink-0 items-center gap-2">
              {isThinking && elapsedSeconds > 0 && (
                <span
                  className="rounded-md bg-secondary px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
                  aria-label={t('thinking.elapsedAria', { seconds: elapsedSeconds })}
                >
                  {formatElapsed(elapsedSeconds)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{summaryLabel}</span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform duration-quick ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </span>

            {/* Slim indeterminate sweep along the header's lower edge — a
                progress-like motion that guides the eye while thinking. */}
            {isThinking && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-4 bottom-1.5 h-0.5 overflow-hidden rounded-full bg-foreground/5"
              >
                <span className="animate-progress-sweep block h-full w-1/3 rounded-full bg-foreground/30 motion-reduce:animate-none" />
              </span>
            )}
          </button>
        </CollapsibleTrigger>

        {/* Expanded content — opacity only (no height tween). The reserved
            min-h-12 header is the chrome; the body mounts/unmounts. The basis
            footer lives INSIDE here so the collapsed turn is just the one-line
            summary and never bulks the thread before the answer. */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="herleitung-content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={motionQuick}
            >
              <div className="border-base border-t px-2 pb-3 pt-3 sm:px-4">
                <ReasoningFlow
                  steps={steps}
                  userQuestion={userQuestion}
                  answerConfidence={answerConfidence}
                  citations={citations}
                  choicePrompt={choicePrompt}
                  onChoiceRespond={onChoiceRespond}
                  escalationReason={escalationReason}
                  live={isThinking}
                />
              </div>

              {/* Executed steps — what actually ran, as compact chips. Only
                  shown when the Herleitung is expanded. */}
              {executedSteps.length > 0 && (
                <div className="flex flex-col gap-2 px-4 pb-4 pt-3">
                  <SectionLabel>{t('thinking.executedSteps')}</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {executedSteps.map((s) => (
                      <span
                        key={s.key}
                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground"
                      >
                        {s.running && (
                          <span
                            aria-hidden="true"
                            className="size-1.5 animate-pulse rounded-full bg-brand motion-reduce:animate-none"
                          />
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
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>

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

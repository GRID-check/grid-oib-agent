/**
 * AgentPrompt — the turn's open question (`interaction_request`, chat wire v2).
 *
 * Two shapes exist: `text` (answered in the composer, or with the inline plan
 * buttons when the text is the research-plan envelope) and `choice` (answered
 * by picking an option, which sends the option's `id`).
 *
 * ## How an answer lands
 *
 * The decision (the plan's controls, the instruction and the buttons) and the
 * receipt share one slot: the decision fades out, the slot takes the receipt's
 * height in the frame nothing is visible, and the receipt fades in. A plan the
 * reader answered folds to one line, „Plan freigegeben · 5 Abschnitte", with
 * the plan as approved behind a disclosure, because a tall card of disabled
 * controls above the run it started is a dead weight the reader scrolls past.
 * A choice prompt keeps its options in place: the chosen one is the receipt.
 */

'use client'

import { type FC, type ReactNode, useCallback, useMemo, useState } from 'react'
import { ChevronDown, MessageSquare } from 'lucide-react'
import { useIsPresent } from 'motion/react'
import { AnimatePresence, motion, motionInstant, motionQuick, motionQuickExit } from '@/components/motion'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { BranchOptions } from './reasoning/BranchOptions'
import { useChatStore } from '../store'
import { useLayoutStore } from '@/features/layout/store'
import {
  approvalReply,
  parsePlanFence,
  PlanChecklist,
  planFromReply,
  stripPlanFence,
  type PlanShape,
} from './PlanChecklist'
import type { StoredPromptOption } from '@/lib/conversations/message-prompt'

/**
 * The byte-stable approval envelope (`researcher/clarify.py`
 * `format_plan_for_user`): approve, a quick shallow answer instead, or cancel.
 */
const APPROVAL_PROMPT_RE =
  /Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,\s+\*{0,2}shallow\*{0,2}\s+for a quick answer instead/i

/**
 * Strips the WHOLE envelope line, whichever variant wrote it. The previous
 * strip regex ended at "to cancel", which left the dangling tail ", or
 * provide feedback to revise the plan." in the rendered bubble — the envelope
 * is one line, so consume it to the line end and show localized copy instead.
 */
const APPROVAL_PROMPT_STRIP_RE = /[ \t]*Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,[^\n]*/i

/**
 * The English scaffolding around the (user-language) plan title and sections.
 * Byte-stable like the envelope, and localized here for the same reason: a
 * German-speaking user deciding about a German plan should not be doing it
 * under an English "Research Plan Preview" header.
 */
const PLAN_HEADER_RE = /\*\*Research Plan Preview\*\*/
const PLAN_TITLE_LABEL_RE = /\*\*Title:\*\*/
const PLAN_SECTIONS_LABEL_RE = /\*\*Sections:\*\*/
/** The whole sections block (label and numbered lines), for a plan drawn as controls. */
const PLAN_SECTIONS_BLOCK_RE = /\*\*[^*\n]+\*\*\s*\n(?:\s*\d+\.\s[^\n]*\n?)+/

/**
 * Keyword the user's click sent, mapped to the dictionary key of a
 * human-readable receipt. Without this the answered bubble echoed the raw
 * wire keyword ("Ihre Antwort: reject") back into a German conversation.
 */
const APPROVAL_RESPONSE_KEYS: Record<string, string> = {
  approve: 'agentPrompt.responseApproved',
  shallow: 'agentPrompt.responseShallow',
  cancel: 'agentPrompt.responseCancelled',
}

export interface AgentPromptProps {
  /** The question the agent asked. */
  content: string
  /** `choice` prompts carry options; a pick sends the option's `id`. */
  options?: StoredPromptOption[]
  /** Whether the prompt has been responded to */
  isResponded?: boolean
  /** The answer: the typed text, or the chosen option's `id`. */
  response?: string
  /** Timestamp (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /**
   * Whether THIS reader is the person the agent asked (ADR-0037).
   *
   * Defaults to true, which is right for a live prompt: the browser holding the
   * socket is the addressee by construction. It is false only for a colleague in a
   * shared thread reading a prompt restored from the server — and for them the
   * actions must not render, because the agent tier refuses an answer from anybody
   * but the addressee (`_may_answer_interaction`), so a button would be offering a
   * refusal.
   */
  isAddressee?: boolean
  /** Who was asked, for the read-only line a colleague sees instead of buttons. */
  addresseeName?: string | null
}

export const AgentPrompt: FC<AgentPromptProps> = ({
  content,
  options = [],
  isResponded = false,
  response,
  timestamp,
  isAddressee = true,
  addresseeName,
}) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const respondToInteractionFn = useChatStore((state) => state.respondToInteractionFn)
  const isApprovalPrompt = APPROVAL_PROMPT_RE.test(content)
  const showApprovalButtons =
    isApprovalPrompt && !isResponded && !!respondToInteractionFn && isAddressee
  // Replace the English envelope sentence and the English plan scaffolding
  // with localized copy; the plan title/sections themselves are already in the
  // user's language (the planner writes them that way).
  // The plan as data, when the backend sent it beside the text: the card
  // renders it as controls, and the approval carries the reader's edits.
  const plan = useMemo(
    () => (isApprovalPrompt ? parsePlanFence(content) : null),
    [content, isApprovalPrompt]
  )
  const [editedPlan, setEditedPlan] = useState<PlanShape | null>(null)
  const shownPlan = editedPlan ?? plan
  // The Rahmen: the composer's Datengrundlage, read off the layout store the
  // composer writes. The approval carries the ids; the card shows the names.
  const enabledSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const availableSources = useLayoutStore((s) => s.availableDataSources)
  const rahmen = useMemo(() => {
    if (!plan) return undefined
    const ids = enabledSourceIds.filter((id) => (availableSources ?? []).some((s) => s.id === id))
    const labels = ids.map((id) => (availableSources ?? []).find((s) => s.id === id)?.name ?? id)
    return { ids, labels }
  }, [plan, enabledSourceIds, availableSources])
  // An edited approval is the keyword plus JSON; the receipt keys off the keyword.
  const displayContent = isApprovalPrompt
    ? stripPlanFence(content)
        .replace(APPROVAL_PROMPT_STRIP_RE, '')
        .replace(PLAN_HEADER_RE, `**${t('agentPrompt.planPreviewHeading')}**`)
        .replace(PLAN_TITLE_LABEL_RE, `**${t('agentPrompt.planTitleLabel')}**`)
        .replace(PLAN_SECTIONS_LABEL_RE, `**${t('agentPrompt.planSectionsLabel')}**`)
        .trim()
    : content
  // With the plan drawn as controls, the numbered list above it would say the
  // sections twice; the text keeps the title and loses the list.
  const bubbleContent = plan
    ? displayContent.replace(PLAN_SECTIONS_BLOCK_RE, '').trim()
    : displayContent

  // The answered bubble's echo. Approval prompts answer with wire keywords;
  // show what the click meant, not the keyword. Every other prompt echoes the
  // user's own words unchanged.
  const responseKey =
    isApprovalPrompt && response
      ? APPROVAL_RESPONSE_KEYS[response.trim().toLowerCase().split(/\s/)[0] ?? '']
      : undefined
  const responseLabel = responseKey ? t(responseKey) : response

  // Each handler refuses once the prompt is answered: a prompt takes one
  // answer, and a second `interaction_response` is never what a late click
  // meant (the decision is also inert while it fades; see AnswerSlotBody).
  const handleApprove = useCallback(() => {
    if (isResponded) return
    respondToInteractionFn?.(
      plan && shownPlan ? approvalReply(plan, shownPlan, rahmen?.ids ?? []) : 'approve'
    )
  }, [isResponded, respondToInteractionFn, plan, shownPlan, rahmen])

  const handleShallow = useCallback(() => {
    if (isResponded) return
    respondToInteractionFn?.('shallow')
  }, [isResponded, respondToInteractionFn])

  const handleCancel = useCallback(() => {
    if (isResponded) return
    respondToInteractionFn?.('cancel')
  }, [isResponded, respondToInteractionFn])

  // The plan as it was decided: the reader's edits while this mount holds
  // them, else what the reply carried (a reload has only the reply).
  const decidedPlan = useMemo(
    () => (plan ? (editedPlan ?? planFromReply(plan, response)) : null),
    [plan, editedPlan, response]
  )
  const approved = responseKey === APPROVAL_RESPONSE_KEYS.approve
  const recordLabel =
    plan && approved && decidedPlan
      ? t('agentPrompt.planRecord', { count: decidedPlan.sections.length })
      : responseLabel

  const optionLabels = useMemo(() => options.map((option) => option.label), [options])
  const selectedLabel = options.find((option) => option.id === response)?.label
  const handleSelect = useCallback(
    (label: string) => {
      if (isResponded) return
      const option = options.find((candidate) => candidate.label === label)
      if (option) respondToInteractionFn?.(option.id)
    },
    [isResponded, options, respondToInteractionFn]
  )

  return (
    // No entrance of its own: the thread row owns it, gated on whether the
    // message is new. A CSS entrance here replayed on every mount, so a
    // restored prompt rose again on every thread switch.
    <div className="flex w-full justify-start">
      <div className="flex max-w-[85%] flex-col">
        <div className="bg-card flex flex-col gap-3 overflow-hidden break-words rounded-2xl rounded-bl-md p-4">
          {/* Agent icon and label */}
          <div
            className={`duration-quick flex items-center gap-2 transition-opacity ease-out motion-reduce:transition-none ${isResponded ? 'opacity-75' : ''}`}
          >
            <MessageSquare className="text-muted-foreground size-5" />
            <span className="text-muted-foreground text-sm font-semibold">
              {isResponded ? t('agentPrompt.receivedInput') : t('agentPrompt.needsInput')}
            </span>
          </div>

          {/* Content - rendered as markdown */}
          <div
            className={`prose prose-sm duration-quick max-w-none transition-opacity ease-out motion-reduce:transition-none ${isResponded ? 'opacity-75' : ''}`}
          >
            <MarkdownRenderer content={bubbleContent} />
          </div>

          {/* Choice prompts render as the shared Folgewege branch-picker cards
              (same look as the trace's BranchesNode). After answering, the
              chosen card stays selected and the rest dim, so the picker doubles
              as the response display. */}
          {options.length > 0 && (
            <BranchOptions
              options={optionLabels}
              selected={isResponded ? selectedLabel : undefined}
              // A colleague sees the choices as a settled list, not a picker: the
              // question is not theirs to answer.
              isResponded={isResponded || !isAddressee}
              onSelect={isAddressee && respondToInteractionFn ? handleSelect : undefined}
              digitShortcuts={isAddressee}
            />
          )}

          {/* The decision and its receipt, one slot (see the module note). */}
          <AnswerSlot answered={isResponded}>
            {isResponded ? (
              <>
                {/* A colleague's settled list for a choice prompt is the options
                    above; every other prompt echoes its answer here. */}
                {options.length === 0 && plan && decidedPlan ? (
                  <PlanRecord label={recordLabel} plan={decidedPlan} rahmen={rahmen} />
                ) : (
                  options.length === 0 && <ResponseDisplay response={responseLabel} />
                )}
              </>
            ) : (
              <>
                {shownPlan && (
                  <PlanChecklist
                    plan={shownPlan}
                    disabled={!isAddressee || !respondToInteractionFn}
                    rahmen={rahmen}
                    onChange={setEditedPlan}
                  />
                )}

                {/* Why a colleague has no buttons. Without a line here the card
                    reads as broken rather than as somebody else's turn. */}
                {!isAddressee && (
                  <p data-testid="agent-prompt-awaiting-other" className="text-muted-foreground text-xs">
                    {addresseeName
                      ? t('agentPrompt.awaitingOther', { name: addresseeName })
                      : t('agentPrompt.awaitingSomeone')}
                  </p>
                )}

                {/* Localized instruction + duration/cost expectation for plan
                    approval prompts, shown at the decision point. */}
                {isApprovalPrompt && isAddressee && (
                  <div className="flex flex-col gap-1">
                    <span className="text-foreground text-sm">
                      {t('agentPrompt.approvalInstructionThreeWay')}
                    </span>
                    <span className="text-muted-foreground text-xs">{t('agentPrompt.durationHint')}</span>
                  </div>
                )}

                {/* The plan decision: cancel outright, a quick shallow answer
                    instead, or the deep run. */}
                {showApprovalButtons && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleCancel}
                      aria-label={t('agentPrompt.cancelResearchAria')}
                    >
                      {t('agentPrompt.cancelResearch')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleShallow}
                      aria-label={t('agentPrompt.answerShallowAria')}
                    >
                      {t('agentPrompt.answerShallow')}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleApprove}
                      aria-label={t('agentPrompt.approvePlan')}
                    >
                      {t('agentPrompt.startResearch')}
                    </Button>
                  </div>
                )}
              </>
            )}
          </AnswerSlot>
        </div>

        {/* Timestamp outside bubble, right-aligned */}
        {timestamp && (
          <span className="text-subtle mr-3 mt-1 self-end text-xs">
            {formatTime(timestamp, locale)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Display the user's response after submission
 */
const ResponseDisplay: FC<{ response?: string }> = ({ response }) => {
  const t = useTranslations('chat')
  if (!response) return null

  return (
    <div className="bg-muted flex items-center gap-2 rounded-xl px-3 py-2">
      <MessageSquare className="text-subtle size-4" />
      <span className="text-subtle text-sm">
        {t('agentPrompt.yourResponse')} <span className="text-primary">{response}</span>
      </span>
    </div>
  )
}

/**
 * One slot for the decision and the receipt that replaces it. Out on the exit
 * curve, in on the quick one, never both at once (`mode="wait"`): the slot's
 * height changes in the frame between, while nothing in it is visible, so the
 * card resizes once instead of sliding two contents over each other. Mounted
 * already answered (a restored thread), it paints the receipt with no motion.
 */
const AnswerSlot: FC<{ answered: boolean; children: ReactNode }> = ({ answered, children }) => (
  <AnimatePresence mode="wait" initial={false}>
    <AnswerSlotBody key={answered ? 'answered' : 'open'}>{children}</AnswerSlotBody>
  </AnimatePresence>
)

/**
 * One content of the slot. While it fades out, AnimatePresence keeps rendering
 * the children it last had, buttons and handlers from before the answer
 * included, so the leaving decision is taken out of reach (`inert`: no click,
 * no focus, no key) and out of the accessibility tree for its last 180ms, the
 * way ProposalShell retires a question. Otherwise a second click on the
 * approve button during the fade sends a second `interaction_response`.
 */
const AnswerSlotBody: FC<{ children: ReactNode }> = ({ children }) => {
  const reduced = useReducedMotion()
  const present = useIsPresent()
  return (
    <motion.div
      className={cn('flex flex-col gap-3 empty:hidden', !present && 'pointer-events-none')}
      aria-hidden={present ? undefined : true}
      inert={!present}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: reduced ? motionInstant : motionQuick }}
      exit={{ opacity: 0, transition: reduced ? motionInstant : motionQuickExit }}
    >
      {children}
    </motion.div>
  )
}

/**
 * An answered plan as one line: what was decided, and the plan as approved
 * behind a disclosure the reader opens (a user-initiated expand, the one kind
 * of height change the thread animates).
 */
const PlanRecord: FC<{
  label?: string
  plan: PlanShape
  rahmen?: { ids: string[]; labels: string[] }
}> = ({ label, plan, rahmen }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
      <div className="bg-muted flex items-center gap-2 rounded-xl px-3 py-2" data-testid="plan-record">
        <MessageSquare className="text-subtle size-4 shrink-0" aria-hidden />
        <span className="text-subtle min-w-0 flex-1 text-sm">{label}</span>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground group h-7 shrink-0 gap-1 px-2 text-xs"
            data-testid="plan-record-toggle"
          >
            {open ? t('agentPrompt.hidePlan') : t('agentPrompt.showPlan')}
            <ChevronDown
              className="duration-quick size-3.5 transition-transform ease-out group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              aria-hidden
            />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <PlanChecklist plan={plan} disabled rahmen={rahmen} onChange={() => undefined} />
      </CollapsibleContent>
    </Collapsible>
  )
}

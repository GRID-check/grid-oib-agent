/**
 * AgentPrompt — the turn's open question (`interaction_request`, chat wire v2).
 *
 * Two shapes exist: `text` (answered in the composer, or with the inline plan
 * buttons when the text is the research-plan envelope) and `choice` (answered
 * by picking an option, which sends the option's `id`).
 */

'use client'

import { type FC, useCallback, useMemo, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  stripPlanFence,
  type PlanShape,
} from './PlanChecklist'

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

/** One option of a `choice` prompt, as the wire names it. */
export interface PromptOption {
  id: string
  label: string
}

export interface AgentPromptProps {
  /** The question the agent asked. */
  content: string
  /** `choice` prompts carry options; a pick sends the option's `id`. */
  options?: PromptOption[]
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

  const handleApprove = useCallback(() => {
    respondToInteractionFn?.(
      plan && shownPlan ? approvalReply(plan, shownPlan, rahmen?.ids ?? []) : 'approve'
    )
  }, [respondToInteractionFn, plan, shownPlan, rahmen])

  const handleShallow = useCallback(() => {
    respondToInteractionFn?.('shallow')
  }, [respondToInteractionFn])

  const handleCancel = useCallback(() => {
    respondToInteractionFn?.('cancel')
  }, [respondToInteractionFn])

  const optionLabels = useMemo(() => options.map((option) => option.label), [options])
  const selectedLabel = options.find((option) => option.id === response)?.label
  const handleSelect = useCallback(
    (label: string) => {
      const option = options.find((candidate) => candidate.label === label)
      if (option) respondToInteractionFn?.(option.id)
    },
    [options, respondToInteractionFn]
  )

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-entrance flex w-full justify-start motion-reduce:animate-none">
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

          {shownPlan && (
            <PlanChecklist
              plan={shownPlan}
              disabled={isResponded || !isAddressee || !respondToInteractionFn}
              rahmen={rahmen}
              onChange={setEditedPlan}
            />
          )}

          {/* Why a colleague has no buttons. Without a line here the card reads as
              broken rather than as somebody else's turn. */}
          {!isAddressee && !isResponded && (
            <p data-testid="agent-prompt-awaiting-other" className="text-muted-foreground text-xs">
              {addresseeName
                ? t('agentPrompt.awaitingOther', { name: addresseeName })
                : t('agentPrompt.awaitingSomeone')}
            </p>
          )}

          {/* Localized instruction + duration/cost expectation for plan
              approval prompts, shown at the decision point (before approval). */}
          {isApprovalPrompt && !isResponded && isAddressee && (
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

          {/* Response display for NON-choice prompts (text/approval). Choice
              prompts show their answer via the selected branch card above. */}
          {isResponded && options.length === 0 && <ResponseDisplay response={responseLabel} />}
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

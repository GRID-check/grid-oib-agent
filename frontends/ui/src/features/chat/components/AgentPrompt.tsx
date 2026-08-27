/**
 * AgentPrompt Component
 *
 * Displays prompts from the agent that require user response.
 * This is a display-only component - user responds via the main chat input.
 *
 * For plan approval prompts, inline Approve/Reject buttons are rendered
 * inside the bubble so the user can respond without typing.
 */

'use client'

import { type FC, useCallback } from 'react'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { BranchOptions } from './reasoning/BranchOptions'
import { useChatStore } from '../store'
import type { PromptType } from '../types'

export type { PromptType }

/**
 * The two byte-stable approval envelopes the backend has written, oldest
 * first. The legacy sentence offered approve/reject; the current one
 * (clarifier `_format_plan_for_user`) adds the explicit middle way — a quick
 * shallow answer instead of the plan. Both must keep matching: prompts are
 * persisted and restored, so a thread from before the third option still
 * carries the old sentence.
 */
const APPROVAL_PROMPT_LEGACY_RE =
  /Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,\s+\*{0,2}reject\*{0,2}\s+to cancel/i
const APPROVAL_PROMPT_THREE_WAY_RE =
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

/**
 * Keyword the user's click sent, mapped to the dictionary key of a
 * human-readable receipt. Without this the answered bubble echoed the raw
 * wire keyword ("Ihre Antwort: reject") back into a German conversation.
 */
const APPROVAL_RESPONSE_KEYS: Record<string, string> = {
  approve: 'agentPrompt.responseApproved',
  shallow: 'agentPrompt.responseShallow',
  cancel: 'agentPrompt.responseCancelled',
  reject: 'agentPrompt.responseRejected',
}

export interface AgentPromptProps {
  /** Unique identifier for this prompt */
  id: string
  /** Type of prompt */
  type: PromptType
  /** Main content/question from the agent */
  content: string
  /** Options for choice prompts (displayed as list) */
  options?: string[]
  /** Placeholder text for text input prompts (not used - display only) */
  placeholder?: string
  /** Whether the prompt has been responded to */
  isResponded?: boolean
  /** The user's response (if already responded) */
  response?: string
  /** Callback when user responds (not used - display only) */
  onRespond?: (promptId: string, response: string) => void
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

/**
 * Agent prompt component - display only.
 * User responds via the main chat input area.
 *
 * When the prompt contains plan approval text, Approve/Reject buttons
 * are rendered inline so the user can respond with a single click.
 */
export const AgentPrompt: FC<AgentPromptProps> = ({
  type: _type,
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
  const isThreeWayPrompt = APPROVAL_PROMPT_THREE_WAY_RE.test(content)
  const isApprovalPrompt = isThreeWayPrompt || APPROVAL_PROMPT_LEGACY_RE.test(content)
  const showApprovalButtons =
    isApprovalPrompt && !isResponded && !!respondToInteractionFn && isAddressee
  // Replace the English envelope sentence and the English plan scaffolding
  // with localized copy; the plan title/sections themselves are already in the
  // user's language (the planner writes them that way).
  const displayContent = isApprovalPrompt
    ? content
        .replace(APPROVAL_PROMPT_STRIP_RE, '')
        .replace(PLAN_HEADER_RE, `**${t('agentPrompt.planPreviewHeading')}**`)
        .replace(PLAN_TITLE_LABEL_RE, `**${t('agentPrompt.planTitleLabel')}**`)
        .replace(PLAN_SECTIONS_LABEL_RE, `**${t('agentPrompt.planSectionsLabel')}**`)
        .trim()
    : content

  // The answered bubble's echo. Approval prompts answer with wire keywords;
  // show what the click meant, not the keyword. Every other prompt echoes the
  // user's own words unchanged.
  const responseKey = isApprovalPrompt && response ? APPROVAL_RESPONSE_KEYS[response.trim().toLowerCase()] : undefined
  const responseLabel = responseKey ? t(responseKey) : response

  const handleApprove = useCallback(() => {
    respondToInteractionFn?.('approve')
  }, [respondToInteractionFn])

  const handleShallow = useCallback(() => {
    respondToInteractionFn?.('shallow')
  }, [respondToInteractionFn])

  const handleCancel = useCallback(() => {
    respondToInteractionFn?.('cancel')
  }, [respondToInteractionFn])

  const handleReject = useCallback(() => {
    respondToInteractionFn?.('reject')
  }, [respondToInteractionFn])

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full justify-start duration-base ease-entrance motion-reduce:animate-none">
      <div className="flex max-w-[85%] flex-col">
        <div className="flex flex-col gap-3 overflow-hidden break-words rounded-2xl rounded-bl-md bg-card p-4">
          {/* Agent icon and label */}
          <div
            className={`flex items-center gap-2 transition-opacity duration-quick ease-out motion-reduce:transition-none ${isResponded ? 'opacity-75' : ''}`}
          >
            <MessageSquare className="size-5 text-muted-foreground" />
            <span className="text-sm font-semibold text-muted-foreground">
              {isResponded ? t('agentPrompt.receivedInput') : t('agentPrompt.needsInput')}
            </span>
          </div>

          {/* Content - rendered as markdown */}
          <div
            className={`prose prose-sm max-w-none transition-opacity duration-quick ease-out motion-reduce:transition-none ${isResponded ? 'opacity-75' : ''}`}
          >
            <MarkdownRenderer content={displayContent} />
          </div>

          {/* Choice prompts render as the shared Folgewege branch-picker cards
              (same look as the trace's BranchesNode). After answering, the
              chosen card stays selected and the rest dim, so the picker doubles
              as the response display. */}
          {options.length > 0 && (
            <BranchOptions
              options={options}
              selected={isResponded ? response : undefined}
              // A colleague sees the choices as a settled list, not a picker: the
              // question is not theirs to answer.
              isResponded={isResponded || !isAddressee}
              onSelect={isAddressee ? (respondToInteractionFn ?? undefined) : undefined}
              digitShortcuts={isAddressee}
            />
          )}

          {/* Why a colleague has no buttons. Without a line here the card reads as
              broken rather than as somebody else's turn. */}
          {!isAddressee && !isResponded && (
            <p data-testid="agent-prompt-awaiting-other" className="text-xs text-muted-foreground">
              {addresseeName
                ? t('agentPrompt.awaitingOther', { name: addresseeName })
                : t('agentPrompt.awaitingSomeone')}
            </p>
          )}

          {/* Localized instruction + duration/cost expectation for plan
              approval prompts, shown at the decision point (before approval). */}
          {isApprovalPrompt && !isResponded && isAddressee && (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-foreground">
                {isThreeWayPrompt
                  ? t('agentPrompt.approvalInstructionThreeWay')
                  : t('agentPrompt.approvalInstruction')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('agentPrompt.durationHint')}
              </span>
            </div>
          )}

          {/* The plan decision. The current envelope offers all three answers
              the backend understands — cancel outright, a quick shallow answer
              instead (the middle way this bubble existed to hide), and the
              deep run. A restored legacy prompt keeps its two buttons: sending
              "shallow" to the backend that wrote that envelope would be read
              as plan feedback, not as a choice. */}
          {showApprovalButtons &&
            (isThreeWayPrompt ? (
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
            ) : (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleReject}
                  aria-label={t('agentPrompt.rejectPlan')}
                >
                  {t('agentPrompt.reject')}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleApprove}
                  aria-label={t('agentPrompt.approvePlan')}
                >
                  {t('agentPrompt.approve')}
                </Button>
              </div>
            ))}

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
    <div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2">
      <MessageSquare className="text-subtle size-4" />
      <span className="text-subtle text-sm">
        {t('agentPrompt.yourResponse')} <span className="text-primary">{response}</span>
      </span>
    </div>
  )
}

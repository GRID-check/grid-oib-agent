/**
 * AgentPrompt Component
 *
 * Displays prompts from the agent that require user response.
 * This is a display-only component - user responds via the main chat input.
 *
 * A research plan is no longer a prompt (ADR-0068): it is a row of the plan
 * primitive, shown on the run block, and the run waits on it there. What is
 * left here for plans is reading the old ones — threads from before the change
 * carry the English preview envelope and a fenced JSON copy of the plan, and
 * both are localized or stripped so the history reads.
 */

'use client'

import type { FC } from 'react'
import { MessageSquare } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { BranchOptions } from './reasoning/BranchOptions'
import { useChatStore } from '../store'
import { isLegacyPlanPreview } from '../lib/plan-preview'
import type { PromptType } from '../types'

export type { PromptType }

/** The fenced JSON copy of the plan an old preview carries beside its text. */
const PLAN_FENCE_RE = /```plan_json\s*\n[\s\S]*?\n```/

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
 * User responds via the main chat input area, or through the picker.
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
  const isApprovalPrompt = isLegacyPlanPreview(content)
  // An old plan preview, read back from history: the fence stripped, the
  // English envelope localized. The plan's own words are the planner's.
  const bubbleContent = isApprovalPrompt
    ? content
        .replace(PLAN_FENCE_RE, '')
        .replace(APPROVAL_PROMPT_STRIP_RE, '')
        .replace(PLAN_HEADER_RE, `**${t('agentPrompt.planPreviewHeading')}**`)
        .replace(PLAN_TITLE_LABEL_RE, `**${t('agentPrompt.planTitleLabel')}**`)
        .replace(PLAN_SECTIONS_LABEL_RE, `**${t('agentPrompt.planSectionsLabel')}**`)
        .trim()
    : content

  // The answered bubble's echo. Approval prompts answer with wire keywords;
  // show what the click meant, not the keyword. Every other prompt echoes the
  // user's own words unchanged.
  const responseKey =
    isApprovalPrompt && response
      ? APPROVAL_RESPONSE_KEYS[response.trim().toLowerCase().split(/\s/)[0] ?? '']
      : undefined
  const responseLabel = responseKey ? t(responseKey) : response

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
            <p data-testid="agent-prompt-awaiting-other" className="text-muted-foreground text-xs">
              {addresseeName
                ? t('agentPrompt.awaitingOther', { name: addresseeName })
                : t('agentPrompt.awaitingSomeone')}
            </p>
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

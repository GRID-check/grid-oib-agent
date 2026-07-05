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
import { formatTime } from '@/shared/utils/format-time'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { useChatStore } from '../store'
import type { PromptType } from '../types'

export type { PromptType }

const APPROVAL_PROMPT_RE =
  /Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,\s+\*{0,2}reject\*{0,2}\s+to cancel/i

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
}) => {
  const respondToInteractionFn = useChatStore((state) => state.respondToInteractionFn)
  const isApprovalPrompt = APPROVAL_PROMPT_RE.test(content)
  const showApprovalButtons = isApprovalPrompt && !isResponded && !!respondToInteractionFn

  const handleApprove = useCallback(() => {
    respondToInteractionFn?.('approve')
  }, [respondToInteractionFn])

  const handleReject = useCallback(() => {
    respondToInteractionFn?.('reject')
  }, [respondToInteractionFn])

  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[85%] flex-col">
        <div className="flex flex-col gap-3 overflow-hidden break-words rounded-2xl rounded-bl-md bg-card p-4">
          {/* Agent icon and label */}
          <div className={`flex items-center gap-2 ${isResponded ? 'opacity-75' : ''}`}>
            <MessageSquare className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-semibold text-muted-foreground">
              {isResponded ? 'Agent received your input' : 'Agent needs your input'}
            </span>
          </div>

          {/* Content - rendered as markdown */}
          <div className={`prose prose-sm max-w-none ${isResponded ? 'opacity-75' : ''}`}>
            <MarkdownRenderer content={content} />
          </div>

          {/* Options list for choice prompts */}
          {options.length > 0 && !isResponded && <OptionsList options={options} />}

          {/* Approve/Reject buttons for plan approval prompts */}
          {showApprovalButtons && (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReject}
                aria-label="Reject plan"
              >
                Reject
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleApprove}
                aria-label="Approve plan"
              >
                Approve
              </Button>
            </div>
          )}

          {/* Response display (only shown after user responds) */}
          {isResponded && <ResponseDisplay response={response} />}
        </div>

        {/* Timestamp outside bubble, right-aligned */}
        {timestamp && (
          <span className="text-subtle mr-3 mt-1 self-end text-xs">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Display options for choice prompts (read-only)
 */
const OptionsList: FC<{ options: string[] }> = ({ options }) => {
  return (
    <div className="flex flex-col gap-1">
      {options.map((option, index) => (
        <div
          key={index}
          className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2"
        >
          <span className="text-subtle text-xs">{index + 1}.</span>
          <span className="text-sm">{option}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Display the user's response after submission
 */
const ResponseDisplay: FC<{ response?: string }> = ({ response }) => {
  if (!response) return null

  return (
    <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2">
      <MessageSquare className="text-subtle h-4 w-4" />
      <span className="text-subtle text-sm">
        Your response: <span className="text-primary">{response}</span>
      </span>
    </div>
  )
}

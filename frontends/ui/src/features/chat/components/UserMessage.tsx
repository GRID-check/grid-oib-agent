/**
 * UserMessage Component
 *
 * User message bubble displayed in the chat area.
 */

'use client'

import { type FC } from 'react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { formatTime } from '@/shared/utils/format-time'

export interface UserMessageProps {
  content: string
  /** Timestamp of the message (Date or ISO string from persisted state) */
  timestamp?: Date | string
}

/**
 * User message bubble component
 */
export const UserMessage: FC<UserMessageProps> = ({ content, timestamp }) => {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full justify-end duration-200">
      <div className="flex max-w-[80%] flex-col items-end">
        <div className="flex rounded-2xl rounded-br-md bg-muted p-4 shadow-xs">
          <MarkdownRenderer content={content} />
        </div>
        {timestamp && (
          <span className="text-subtle ml-3 mt-1 self-start text-xs">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  )
}

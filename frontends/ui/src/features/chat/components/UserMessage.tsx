/**
 * UserMessage Component
 *
 * User message bubble displayed in the chat area — the click-dummy "Eingabe"
 * turn: a right-aligned role tab over a bubble with the dummy's asymmetric
 * corner radius, hairline border and trace shadow.
 */

'use client'

import { type FC } from 'react'
import { User } from 'lucide-react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { formatTime } from '@/shared/utils/format-time'
import { useTranslations } from '@/i18n'

export interface UserMessageProps {
  content: string
  /** Timestamp of the message (Date or ISO string from persisted state) */
  timestamp?: Date | string
}

/**
 * User message bubble component
 */
export const UserMessage: FC<UserMessageProps> = ({ content, timestamp }) => {
  const t = useTranslations('chat')
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col items-end duration-200">
      {/* "Eingabe" role tab — uppercase 10.5/600, inset from the bubble edge */}
      <div className="mr-[14px] inline-flex items-center gap-1.5 rounded-t-[7px] bg-accent px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <User className="size-2.5" aria-hidden="true" />
        {t('roles.input')}
      </div>

      {/* Bubble — width 400, asymmetric corners, hairline border, trace shadow */}
      <div className="w-[400px] max-w-full rounded-[12px_4px_12px_12px] border border-input bg-card px-[14px] py-[11px] text-[13.5px] leading-[1.55] text-default shadow-xs">
        <MarkdownRenderer content={content} />
      </div>

      {timestamp && (
        <span className="text-subtle mr-[14px] mt-1 text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}

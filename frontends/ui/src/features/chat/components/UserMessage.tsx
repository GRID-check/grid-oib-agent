// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    <div className="flex w-full justify-end">
      <div className="flex max-w-[80%] flex-col items-end">
        <div className="bg-surface-sunken-opaque border-base flex rounded-bl-xl rounded-tl-xl rounded-tr-xl border p-4">
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

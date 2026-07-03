// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ToolCallsTab Component
 *
 * Sub-tab within ThinkingTab displaying tool calls made during processing.
 *
 * SSE Events: tool.start, tool.end
 */

'use client'

import { type FC } from 'react'
import { Wrench } from 'lucide-react'
import { ToolCallCard, type ToolCallInfo } from './ToolCallCard'
import { EMPTY_RESEARCH_DETAILS_HELP_TEXT } from './research-empty-state-copy'

interface ToolCallsTabProps {
  /** Array of tool call info from SSE events */
  toolCalls?: ToolCallInfo[]
  /** Whether any tool is currently executing */
  isRunning?: boolean
}

/**
 * Tool calls sub-tab content showing tool invocations and results.
 */
export const ToolCallsTab: FC<ToolCallsTabProps> = ({ toolCalls = [] }) => {
  const isEmpty = toolCalls.length === 0
  const runningCount = toolCalls.filter((tc) => tc.status === 'running').length
  const completedCount = toolCalls.filter((tc) => tc.status === 'complete').length

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">Tool Calls</span>
          {toolCalls.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {runningCount > 0
                ? `${runningCount} running`
                : `${completedCount}/${toolCalls.length}`}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Web searches, file operations, and other tool invocations.
        </span>
      </div>

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span data-testid="toolcalls-empty-icon" className="mb-3 h-8 w-8 text-muted-foreground">
            <Wrench className="h-8 w-8" aria-hidden="true" />
          </span>
          <p className="text-sm text-muted-foreground">No tool calls available.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {EMPTY_RESEARCH_DETAILS_HELP_TEXT}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {toolCalls.map((toolCall) => (
            <div key={toolCall.id} className="shrink-0">
              <ToolCallCard toolCall={toolCall} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

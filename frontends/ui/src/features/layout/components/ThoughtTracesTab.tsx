// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * ThoughtTracesTab Component
 *
 * Sub-tab within ThinkingTab displaying LLM thought traces and chain-of-thought content.
 *
 * SSE Events: llm.start, llm.chunk, llm.end
 */

'use client'

import { type FC } from 'react'
import { BrainCircuit } from 'lucide-react'
import { ThoughtCard, type ThoughtInfo } from './ThoughtCard'
import { EMPTY_RESEARCH_DETAILS_HELP_TEXT } from './research-empty-state-copy'

interface ThoughtTracesTabProps {
  /** Array of thought traces from SSE events */
  thoughtTraces?: ThoughtInfo[]
  /** Whether LLM is currently generating */
  isStreaming?: boolean
}

/**
 * Thought traces sub-tab content showing LLM inference activity.
 */
export const ThoughtTracesTab: FC<ThoughtTracesTabProps> = ({ thoughtTraces = [] }) => {
  const isEmpty = thoughtTraces.length === 0
  const streamingCount = thoughtTraces.filter((t) => t.isStreaming).length

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">Thought Traces</span>
          {thoughtTraces.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {streamingCount > 0 ? `${streamingCount} active` : `${thoughtTraces.length}`}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          LLM chain-of-thought reasoning and inference activity.
        </span>
      </div>

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <BrainCircuit className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No thought traces available.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {EMPTY_RESEARCH_DETAILS_HELP_TEXT}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {thoughtTraces.map((thought) => (
            <div key={thought.id} className="shrink-0">
              <ThoughtCard thought={thought} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

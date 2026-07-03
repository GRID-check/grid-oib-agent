// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentCard Component
 *
 * Expandable card displaying a single agent/workflow with its name, status,
 * tool calls as a checklist, and output.
 *
 * SSE Events:
 * - workflow.start: Creates or updates card to "running" status
 * - workflow.end: Updates card to "complete" status
 * - tool.start/end: Tool calls linked via agent_id
 */

'use client'

import { type FC, useState } from 'react'
import { Check, ChevronDown, Clock, FileText, Pencil, Search, Wand2, X } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { DeepResearchToolCall } from '@/features/chat/types'

/** Maximum characters for truncated query display */
const MAX_QUERY_LENGTH = 120

/** Tool names that are search/research tools */
const SEARCH_TOOL_PATTERNS = ['search', 'web', 'tavily', 'google', 'bing']

/** Tool names that are file operations */
const FILE_TOOL_PATTERNS = ['write_file', 'read_file', 'file']

/** Tool names that are todo/planning operations */
const PLANNING_TOOL_PATTERNS = ['write_todo', 'todo', 'plan']

/** Agent/workflow information from SSE events */
export interface AgentInfo {
  /** Unique identifier for this agent instance */
  id: string
  /** Agent/workflow name (e.g., "planner-agent", "researcher-agent") */
  name: string
  /** Current execution status */
  status: 'pending' | 'running' | 'complete' | 'error'
  /** Description of current activity */
  currentTask?: string
  /** When agent started */
  startedAt?: Date | string
  /** When agent completed */
  completedAt?: Date | string
  /** Output from the agent (after completion) */
  output?: string
  /** Tool calls made by this agent */
  toolCalls?: DeepResearchToolCall[]
}

interface AgentCardProps {
  /** Agent information */
  agent: AgentInfo
  /** Whether to start expanded */
  defaultExpanded?: boolean
}

/**
 * Determine the tool type category
 */
type ToolType = 'search' | 'file' | 'planning' | 'other'

const getToolType = (toolName: string): ToolType => {
  const lowerName = toolName.toLowerCase()
  if (SEARCH_TOOL_PATTERNS.some((p) => lowerName.includes(p))) return 'search'
  if (FILE_TOOL_PATTERNS.some((p) => lowerName.includes(p))) return 'file'
  if (PLANNING_TOOL_PATTERNS.some((p) => lowerName.includes(p))) return 'planning'
  return 'other'
}

/**
 * Get icon component for tool type
 */
const getToolIcon = (toolType: ToolType) => {
  switch (toolType) {
    case 'search':
      return Search
    case 'file':
      return FileText
    case 'planning':
      return Pencil
    default:
      return Wand2
  }
}

/**
 * Format timestamp for display
 */
const formatTime = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Get the query/description from tool call input, with truncation
 */
const getToolCallDescription = (toolCall: DeepResearchToolCall, truncate = true): string => {
  if (!toolCall.input) return toolCall.name

  const input = toolCall.input as Record<string, unknown>
  const rawDescription = (input.question ||
    input.query ||
    input.search_query ||
    input.filename ||
    input.content ||
    toolCall.name) as string

  if (!truncate || rawDescription.length <= MAX_QUERY_LENGTH) {
    return rawDescription
  }

  return rawDescription.substring(0, MAX_QUERY_LENGTH) + '...'
}

/**
 * Get display name for a tool (formatted)
 */
const getToolDisplayName = (toolName: string): string => {
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Deduplicate tool calls by query text, keeping the most recent status
 */
const dedupeToolCalls = (toolCalls: DeepResearchToolCall[]): DeepResearchToolCall[] => {
  const seen = new Map<string, DeepResearchToolCall>()

  for (const tc of toolCalls) {
    const key = getToolCallDescription(tc, false)
    const existing = seen.get(key)

    if (!existing) {
      seen.set(key, tc)
    } else if (tc.status === 'complete' && existing.status !== 'complete') {
      seen.set(key, tc)
    }
  }

  return Array.from(seen.values())
}

/**
 * Expandable card showing a single agent's status, tool calls, and output.
 */
export const AgentCard: FC<AgentCardProps> = ({ agent, defaultExpanded = true }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  const isRunning = agent.status === 'running'
  const isComplete = agent.status === 'complete'
  const isError = agent.status === 'error'

  const rawToolCalls = agent.toolCalls || []
  const toolCalls = dedupeToolCalls(rawToolCalls)
  const completedToolCalls = toolCalls.filter((tc) => tc.status === 'complete')
  const searchToolCalls = toolCalls.filter((tc) => getToolType(tc.name) === 'search')
  const hasToolCalls = toolCalls.length > 0
  const hasExpandableContent = hasToolCalls || agent.currentTask || agent.output

  // Disable expansion while running (content is still being populated)
  const canExpand = hasExpandableContent && !isRunning

  const statusTextClass = isRunning
    ? 'text-info'
    : isComplete
      ? 'text-success'
      : isError
        ? 'text-error'
        : 'text-muted-foreground'

  const toolCountLabel =
    searchToolCalls.length > 0
      ? `${searchToolCalls.filter((tc) => tc.status === 'complete').length}/${searchToolCalls.length} queries`
      : `${completedToolCalls.length}/${toolCalls.length} tools`

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-muted/40">
      {/* Header - always visible */}
      <button
        type="button"
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`agent-content-${agent.id}`}
        className="w-full text-left disabled:cursor-default"
        disabled={!canExpand}
      >
        <div className="flex w-full items-center gap-2 px-3 py-2">
          {/* Status Icon - spinner when running */}
          {isRunning ? (
            <Spinner size="sm" label={`${agent.name} is running`} className="shrink-0" />
          ) : (
            <span className={cn('shrink-0', statusTextClass)} aria-hidden="true">
              {isComplete ? (
                <Check className="h-4 w-4" />
              ) : isError ? (
                <X className="h-4 w-4" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
            </span>
          )}

          {/* Agent Info */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              <span className={cn('text-sm font-semibold', statusTextClass)}>{agent.name}</span>
              {hasToolCalls && (
                <span className="text-xs text-muted-foreground">{toolCountLabel}</span>
              )}
            </div>
          </div>

          {/* Timestamp */}
          {agent.completedAt ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(agent.completedAt)}
            </span>
          ) : agent.startedAt ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              Started: {formatTime(agent.startedAt)}
            </span>
          ) : null}

          {/* Expand/collapse icon - hidden when running */}
          {canExpand && (
            <span
              className={cn(
                'text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                isExpanded && 'rotate-180'
              )}
              aria-hidden="true"
            >
              <ChevronDown className="h-4 w-4" />
            </span>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && hasExpandableContent && (
        <div id={`agent-content-${agent.id}`} className="flex flex-col gap-2 border-t px-3 pb-3 pt-2">
          {/* Current task description - truncated */}
          {agent.currentTask && (
            <p className="line-clamp-3 text-sm text-muted-foreground">
              {agent.currentTask.length > 200
                ? agent.currentTask.substring(0, 200) + '...'
                : agent.currentTask}
            </p>
          )}

          {/* Tool calls as checklist */}
          {hasToolCalls && (
            <div className="flex flex-col gap-1">
              {toolCalls.map((toolCall) => {
                const isToolComplete = toolCall.status === 'complete'
                const isToolRunning = toolCall.status === 'running'
                const toolType = getToolType(toolCall.name)
                const ToolIcon = getToolIcon(toolType)
                const description = getToolCallDescription(toolCall)
                const isSearchType = toolType === 'search'

                return (
                  <div
                    key={toolCall.id}
                    className={cn('flex items-start gap-2 py-1', isToolComplete && 'opacity-70')}
                  >
                    {isToolRunning ? (
                      <Spinner size="sm" label="Running" className="mt-0.5 shrink-0" />
                    ) : (
                      <Checkbox
                        checked={isToolComplete}
                        disabled
                        aria-label={description}
                        className="mt-0.5 shrink-0"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start gap-1">
                        <ToolIcon
                          className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span
                          className={cn(
                            'line-clamp-2 text-sm',
                            isToolComplete ? 'text-muted-foreground' : 'text-foreground'
                          )}
                        >
                          {isSearchType ? (
                            description
                          ) : (
                            <>
                              <span className="font-medium">
                                {getToolDisplayName(toolCall.name)}
                              </span>
                              {description !== toolCall.name && (
                                <span className="text-muted-foreground">: {description}</span>
                              )}
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

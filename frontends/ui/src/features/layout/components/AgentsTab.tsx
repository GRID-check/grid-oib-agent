/**
 * AgentsTab Component
 *
 * Sub-tab within ThinkingTab displaying active agents/workflows with their
 * tool calls shown as a checklist under each agent.
 *
 * SSE Events: workflow.start, workflow.end, tool.start, tool.end
 */

'use client'

import { type FC, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Wand2 } from 'lucide-react'
import { useChatStore } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { AgentCard, type AgentInfo } from './AgentCard'

/**
 * Agents sub-tab content showing active workflows with their tool calls.
 * Groups tool calls under their parent agents using agent_id.
 */
export const AgentsTab: FC = () => {
  const t = useTranslations('research')
  const { deepResearchAgents, deepResearchToolCalls } = useChatStore(
    useShallow((s) => ({
      deepResearchAgents: s.deepResearchAgents,
      deepResearchToolCalls: s.deepResearchToolCalls,
    }))
  )

  const agentsWithToolCalls = useMemo((): AgentInfo[] => {
    return deepResearchAgents.map((agent) => {
      const agentToolCalls = deepResearchToolCalls.filter((tc) => tc.agentId === agent.id)
      return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        currentTask: agent.input,
        startedAt: agent.startedAt,
        completedAt: agent.completedAt,
        output: agent.output,
        toolCalls: agentToolCalls,
      }
    })
  }, [deepResearchAgents, deepResearchToolCalls])

  const isEmpty = agentsWithToolCalls.length === 0
  const runningCount = agentsWithToolCalls.filter((a) => a.status === 'running').length
  const agentToolCalls = deepResearchToolCalls.filter((tc) => tc.agentId)
  const completedToolCalls = agentToolCalls.filter((tc) => tc.status === 'complete').length

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">{t('agentsTab.title')}</span>
          {agentsWithToolCalls.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {runningCount > 0
                ? t('agentsTab.runningCount', { count: runningCount })
                : `${agentsWithToolCalls.length}`}
              {agentToolCalls.length > 0 &&
                ` • ${t('agentsTab.queriesProgress', { completed: completedToolCalls, total: agentToolCalls.length })}`}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('agentsTab.description')}
        </span>
      </div>

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <Wand2 className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('agentsTab.empty')}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('detailsHelp')}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
          {agentsWithToolCalls.map((agent) => (
            <div key={agent.id} className="shrink-0">
              <AgentCard agent={agent} defaultExpanded />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

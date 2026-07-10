/**
 * ThinkingTab Component
 *
 * Tab within ResearchPanel showing real-time thinking process during DEEP RESEARCH.
 * Uses dedicated state arrays for each category (LLM steps, agents, tool calls, files).
 *
 * Contains sub-tabs for different aspects of the thinking process:
 * - ThoughtTracesTab: LLM thought traces and chain-of-thought
 * - AgentsTab: Active agents with their tool calls shown as checklists
 * - ToolCallsTab: Tool calls made during processing
 * - FilesTab: Files created/modified during research
 * - Citation views: Sources read during research and referenced in the report
 *
 * SSE Events (Deep Research only):
 * - llm.start, llm.chunk, llm.end → deepResearchLLMSteps → ThoughtTracesTab
 * - workflow.start, workflow.end → deepResearchAgents → AgentsTab
 * - tool.start, tool.end → deepResearchToolCalls → AgentsTab (grouped by agent), ToolCallsTab
 * - artifact.update (file) → deepResearchFiles → FilesTab
 * - artifact.update (citation_source/citation_use) → deepResearchCitations → CitationCard
 */

'use client'

import { type FC, useState, useCallback, useMemo } from 'react'
import { BookOpen } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useChatStore } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { ThoughtTracesTab } from './ThoughtTracesTab'
import { AgentsTab } from './AgentsTab'
import { ToolCallsTab } from './ToolCallsTab'
import { FilesTab } from './FilesTab'
import { CitationCard } from './CitationCard'
import type { ThoughtInfo } from './ThoughtCard'
import type { ToolCallInfo } from './ToolCallCard'
import type {
  CitationSource,
  DeepResearchLLMStep,
  DeepResearchToolCall,
} from '@/features/chat/types'

/** Sub-tab types within ThinkingTab */
type ThinkingSubTab = 'thoughts' | 'agents' | 'tools' | 'files' | 'read' | 'referenced'
type CitationFilter = Extract<ThinkingSubTab, 'read' | 'referenced'>

/**
 * Map DeepResearchLLMStep to ThoughtInfo for ThoughtTracesTab
 */
const mapLLMStepToThoughtInfo = (step: DeepResearchLLMStep): ThoughtInfo => ({
  id: step.id,
  modelName: step.name,
  content: step.content,
  thinking: step.thinking,
  workflow: step.workflow,
  isStreaming: !step.isComplete,
  timestamp: step.timestamp,
  usage: step.usage
    ? {
        prompt_tokens: step.usage.input_tokens,
        completion_tokens: step.usage.output_tokens,
      }
    : undefined,
})

/**
 * Map DeepResearchToolCall to ToolCallInfo for ToolCallsTab
 */
const mapToolCallToToolCallInfo = (toolCall: DeepResearchToolCall): ToolCallInfo => ({
  id: toolCall.id,
  name: toolCall.name,
  arguments: toolCall.input,
  result: toolCall.output,
  status:
    toolCall.status === 'running'
      ? 'running'
      : toolCall.status === 'complete'
        ? 'complete'
        : 'error',
  timestamp: toolCall.timestamp,
  workflow: toolCall.workflow,
})

interface CitationListViewProps {
  filter: CitationFilter
  citations: CitationSource[]
}

/**
 * Citation view shown inside Thinking so source provenance stays grouped with
 * the rest of the replayed stream details instead of living in a separate tab.
 */
const CitationListView: FC<CitationListViewProps> = ({ filter, citations }) => {
  const t = useTranslations('research')
  const filteredCitations = useMemo(() => {
    const matchingCitations =
      filter === 'referenced'
        ? citations.filter((citation) => citation.isCited)
        : citations.filter((citation) => !citation.isCited)

    return matchingCitations.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }, [citations, filter])

  const isEmpty = filteredCitations.length === 0
  const headerText = filter === 'referenced' ? t('thinkingTab.referenced') : t('thinkingTab.sourcesRead')
  const subheadingText =
    filter === 'referenced' ? t('thinkingTab.referencedSub') : t('thinkingTab.readSub')

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">{headerText}</span>
          {filteredCitations.length > 0 && (
            <span className="text-xs text-muted-foreground">{filteredCitations.length}</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{subheadingText}</span>
      </div>

      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <BookOpen className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            {filter === 'referenced'
              ? t('thinkingTab.noReferenced')
              : t('thinkingTab.noRead')}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('detailsHelp')}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          {filteredCitations.map((citation, index) => (
            <div key={citation.id} className="shrink-0">
              <CitationCard citation={citation} index={index + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Thinking tab content with sub-tabs for thought traces, agents, files, and source provenance.
 * Consumes dedicated state arrays from the chat store.
 */
export const ThinkingTab: FC = () => {
  const t = useTranslations('research')
  const deepResearchLLMSteps = useChatStore((state) => state.deepResearchLLMSteps)
  const deepResearchToolCalls = useChatStore((state) => state.deepResearchToolCalls)
  const deepResearchCitations = useChatStore((state) => state.deepResearchCitations)

  const [activeSubTab, setActiveSubTab] = useState<ThinkingSubTab>('agents')

  const handleSubTabChange = useCallback((value: string) => {
    setActiveSubTab(value as ThinkingSubTab)
  }, [])

  const thoughtTraces = useMemo(() => {
    return deepResearchLLMSteps.map(mapLLMStepToThoughtInfo).filter((thought) => {
      if (thought.isStreaming) return true
      const hasContent = thought.content && thought.content.trim().length > 0
      const hasThinking = thought.thinking && thought.thinking.trim().length > 0
      return hasContent || hasThinking
    })
  }, [deepResearchLLMSteps])

  const toolCalls = useMemo(() => {
    return deepResearchToolCalls.map(mapToolCallToToolCallInfo)
  }, [deepResearchToolCalls])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header with sub-tab selector */}
      <div className="shrink-0">
        <Tabs value={activeSubTab} onValueChange={handleSubTabChange}>
          <TabsList>
            <TabsTrigger value="thoughts">{t('thinkingTab.tabThoughts')}</TabsTrigger>
            <TabsTrigger value="agents">{t('thinkingTab.tabAgents')}</TabsTrigger>
            <TabsTrigger value="tools">{t('thinkingTab.tabTools')}</TabsTrigger>
            <TabsTrigger value="files">{t('thinkingTab.tabFiles')}</TabsTrigger>
            <TabsTrigger value="read">{t('thinkingTab.tabRead')}</TabsTrigger>
            <TabsTrigger value="referenced">{t('thinkingTab.tabReferenced')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Sub-tab content */}
      <div className="min-h-0 flex-1">
        {activeSubTab === 'thoughts' && <ThoughtTracesTab thoughtTraces={thoughtTraces} />}
        {activeSubTab === 'agents' && <AgentsTab />}
        {activeSubTab === 'tools' && <ToolCallsTab toolCalls={toolCalls} />}
        {activeSubTab === 'files' && <FilesTab />}
        {activeSubTab === 'read' && (
          <CitationListView filter="read" citations={deepResearchCitations} />
        )}
        {activeSubTab === 'referenced' && (
          <CitationListView filter="referenced" citations={deepResearchCitations} />
        )}
      </div>
    </div>
  )
}

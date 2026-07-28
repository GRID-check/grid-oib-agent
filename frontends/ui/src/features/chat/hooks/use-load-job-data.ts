/**
 * useLoadJobData Hook
 *
 * Loads deep research job data (report, citations, todos, tool calls, etc.)
 * either from the report API endpoint or by replaying the SSE stream.
 *
 * Use cases:
 * - "View Report" button clicks to load data on-demand
 * - Session restoration when reconnecting to completed jobs
 * - Importing historical job data
 *
 * Two primary methods:
 * 1. `loadReport(jobId)` - Quick fetch of just the report text via REST API
 * 2. `importJobStream(jobId)` - Full replay of SSE stream to get all artifacts
 *    (citations, todos, tool calls, agents, files, etc.)
 */

'use client'

import { useState, useCallback, useRef } from 'react'
import {
  getJobReport,
  getJobStatus,
  getJobState,
  createDeepResearchClient,
  type DeepResearchClient,
  type DeepResearchJobStatus,
  type TodoItem,
} from '@/adapters/api'
import { useChatStore } from '../store'
import {
  getDeepResearchJobLoadErrorDetails,
  getDeepResearchJobLoadFailureKind,
} from '../lib/deep-research-errors'
import { useAuth } from '@/adapters/auth'
import { useLayoutStore } from '@/features/layout/store'
import { useTranslations } from '@/i18n'
import type { ResearchPanelTab } from '@/features/layout/types'
import { normalizeDeepResearchTodos } from '../lib/deep-research-todos'
import { normalizeOrigin } from '../lib/wire-citation'

const STREAM_BACKED_RESEARCH_TABS = new Set<ResearchPanelTab>(['tasks', 'thinking'])

interface JobLoadScope {
  jobId: string
  conversationId: string | null
  requiresJobMatch: boolean
}

const conversationHasJob = (
  conversation: ReturnType<typeof useChatStore.getState>['currentConversation'],
  jobId: string
): boolean => {
  return Boolean(conversation?.messages.some((m) => m.deepResearchJobId === jobId))
}

const createJobLoadScope = (jobId: string): JobLoadScope => {
  const state = useChatStore.getState()
  const currentConversation = state.currentConversation

  if (conversationHasJob(currentConversation, jobId)) {
    return { jobId, conversationId: currentConversation?.id ?? null, requiresJobMatch: true }
  }

  if (state.deepResearchJobId === jobId) {
    return {
      jobId,
      conversationId: state.deepResearchOwnerConversationId ?? currentConversation?.id ?? null,
      requiresJobMatch: true,
    }
  }

  const matchingConversation = state.conversations.find((conversation) =>
    conversation.messages.some((message) => message.deepResearchJobId === jobId)
  )

  if (matchingConversation) {
    return { jobId, conversationId: matchingConversation.id, requiresJobMatch: true }
  }

  // Tests and a few legacy entry points can load by job ID before the message
  // has been persisted. In that case we still bind to the current session ID
  // so switching sessions aborts the eventual replay commit.
  return { jobId, conversationId: currentConversation?.id ?? null, requiresJobMatch: false }
}

/**
 * True when a DIFFERENT job is actively streaming live. Loading (and thus
 * clearing) deep research state in that case would wipe the live run's
 * progress and disconnect its SSE while the backend keeps working — mirrors
 * the isAnotherJobStreaming guard in AgentResponse.
 */
const isAnotherJobStreaming = (jobId: string): boolean => {
  const state = useChatStore.getState()
  return Boolean(
    state.isDeepResearchStreaming &&
      state.deepResearchJobId &&
      state.deepResearchJobId !== jobId
  )
}

/** True when THIS job is the one already streaming live into the panel. */
const isJobStreamingLive = (jobId: string): boolean => {
  const state = useChatStore.getState()
  return Boolean(state.isDeepResearchStreaming && state.deepResearchJobId === jobId)
}

/** Job statuses that mean the run is over, one way or another. */
const isTerminalJobStatus = (status: DeepResearchJobStatus): boolean =>
  status === 'success' || status === 'failure' || status === 'interrupted'

const isJobLoadScopeCurrent = (scope: JobLoadScope): boolean => {
  const state = useChatStore.getState()

  if (scope.conversationId && state.currentConversation?.id !== scope.conversationId) {
    return false
  }

  if (!scope.requiresJobMatch) {
    return true
  }

  return (
    state.deepResearchJobId === scope.jobId ||
    conversationHasJob(state.currentConversation, scope.jobId)
  )
}

export interface LoadJobDataOptions {
  /**
   * Whether to stream the full job to get all artifacts (citations, todos, tool calls, etc.)
   * If false, only fetches the final report via REST API.
   * @default false
   */
  streamFullJob?: boolean
}

export interface UseLoadJobDataReturn {
  /**
   * Load just the report text via REST API (fast, minimal data)
   * Use when you only need the final report content
   */
  loadReport: (jobId: string) => Promise<void>

  /**
   * Import the full job stream to get all artifacts
   * Replays the SSE stream from the beginning to populate:
   * - Report content
   * - Citations (referenced and cited sources)
   * - Todos/tasks
   * - Tool calls with inputs/outputs
   * - Agent/workflow executions
   * - File artifacts
   * - LLM thought traces
   *
   * Use when you need the complete research context, not just the report
   * Opens report tab after completion
   */
  importJobStream: (jobId: string) => Promise<void>

  /**
   * Import stream data only - does NOT change panel tab
   * Use when loading stream data for an already-open tab (e.g., Tasks/Thinking/Citations)
   */
  importStreamOnly: (jobId: string) => Promise<void>

  /**
   * Legacy method - calls either loadReport or importJobStream based on options
   * @deprecated Use loadReport or importJobStream directly for clarity
   */
  loadJobData: (jobId: string, options?: LoadJobDataOptions) => Promise<void>

  /**
   * Open a research panel tab and ensure the minimum data required for that tab is loaded.
   * Report uses the cheap report endpoint; detail tabs use full stream replay.
   */
  loadResearchPanelTab: (jobId: string, tab: ResearchPanelTab) => Promise<void>

  /** Whether data is currently being loaded */
  isLoading: boolean

  /** Error message if loading failed */
  error: string | null

  /** Clear any error state */
  clearError: () => void
}

/**
 * Hook for loading deep research job data on-demand
 *
 * Can either:
 * 1. Fetch just the report via REST API (fast, minimal data)
 * 2. Replay the full SSE stream to get all artifacts (comprehensive)
 */
export const useLoadJobData = (): UseLoadJobDataReturn => {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<DeepResearchClient | null>(null)

  // Localized end-user copy for load failures (chat.deepResearchErrors.*).
  // These strings surface directly in the UI (error cards, err.message
  // tooltips), so they must never be raw technical/backend text.
  const tChat = useTranslations('chat')
  const { idToken } = useAuth()
  const setReportContent = useChatStore((s) => s.setReportContent)
  const addDeepResearchToolCall = useChatStore((s) => s.addDeepResearchToolCall)
  const completeDeepResearchToolCall = useChatStore((s) => s.completeDeepResearchToolCall)
  const clearDeepResearch = useChatStore((s) => s.clearDeepResearch)
  const setCurrentStatus = useChatStore((s) => s.setCurrentStatus)
  const setLoadedJobId = useChatStore((s) => s.setLoadedJobId)
  const setStreamLoaded = useChatStore((s) => s.setStreamLoaded)
  const stopAllDeepResearchSpinners = useChatStore((s) => s.stopAllDeepResearchSpinners)
  const addErrorCard = useChatStore((s) => s.addErrorCard)
  const completeDeepResearch = useChatStore((s) => s.completeDeepResearch)
  const setStreaming = useChatStore((s) => s.setStreaming)
  const patchConversationMessage = useChatStore((s) => s.patchConversationMessage)
  const addDeepResearchBanner = useChatStore((s) => s.addDeepResearchBanner)
  const attachToDeepResearchJob = useChatStore((s) => s.attachToDeepResearchJob)

  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)

  const clearError = useCallback(() => {
    setError(null)
  }, [])

  /**
   * Follow a run that is still in progress: bind it to the panel so
   * `useDeepResearch` connects its SSE stream (replay first, then live) and
   * show the Tasks tab, where the progress actually appears.
   *
   * This is what makes a job that was started somewhere else — a workflow run
   * (manual or scheduled), or a run opened from the run history / another
   * device — watchable instead of a dead "the run is still in progress" error.
   */
  const followRunningJob = useCallback(
    (jobId: string): void => {
      attachToDeepResearchJob(jobId)
      setResearchPanelTab('tasks')
      openRightPanel('research')
    },
    [attachToDeepResearchJob, setResearchPanelTab, openRightPanel]
  )

  const syncMissingJobToFailureState = useCallback(
    (jobId: string): void => {
      const state = useChatStore.getState()
      const conversation = state.currentConversation
      if (!conversation) return

      const trackingMessage = [...conversation.messages]
        .reverse()
        .find((m) => m.messageType === 'agent_response' && m.deepResearchJobId === jobId)

      let hadCompletedReport =
        Boolean(trackingMessage?.deepResearchReportExpired) ||
        Boolean(
          trackingMessage?.deepResearchJobStatus === 'success' &&
          (trackingMessage.showViewReport || trackingMessage.reportContent?.trim())
        )

      if (!hadCompletedReport) {
        hadCompletedReport = conversation.messages.some(
          (m) =>
            m.messageType === 'deep_research_banner' &&
            m.deepResearchBannerData?.jobId === jobId &&
            m.deepResearchBannerData?.bannerType === 'success'
        )
      }

      if (trackingMessage?.id) {
        patchConversationMessage(conversation.id, trackingMessage.id, {
          deepResearchJobStatus: 'failure',
          isDeepResearchActive: false,
          showViewReport: false,
          deepResearchReportExpired: hadCompletedReport,
        })
      }

      const hasTerminalBanner = conversation.messages.some(
        (m) =>
          m.messageType === 'deep_research_banner' &&
          m.deepResearchBannerData?.jobId === jobId &&
          ['success', 'failure', 'cancelled', 'expired'].includes(
            m.deepResearchBannerData?.bannerType || ''
          )
      )

      if (hadCompletedReport || !hasTerminalBanner) {
        addDeepResearchBanner(hadCompletedReport ? 'expired' : 'failure', jobId, conversation.id)
      }
    },
    [patchConversationMessage, addDeepResearchBanner]
  )

  /**
   * Load job data using REST API (report only)
   */
  const _loadReportOnly = useCallback(
    async (jobId: string): Promise<boolean> => {
      const response = await getJobReport(jobId, idToken || undefined)

      if (response.has_report && response.report) {
        setReportContent(response.report, 'final_report')
        return true
      }

      return false
    },
    [idToken, setReportContent]
  )

  /**
   * Load job state for additional artifacts (tool calls, outputs)
   * This is faster than streaming but provides less data than full stream replay
   */
  const loadJobState = useCallback(
    async (jobId: string, scope: JobLoadScope): Promise<void> => {
      try {
        const stateResponse = await getJobState(jobId, idToken || undefined)

        if (stateResponse.has_state && stateResponse.artifacts) {
          if (!isJobLoadScopeCurrent(scope)) return

          const { tools, outputs } = stateResponse.artifacts

          tools?.forEach(
            (tool: { name: string; input?: Record<string, unknown>; output?: string }) => {
              const toolCallId = addDeepResearchToolCall({
                name: tool.name,
                input: tool.input,
                workflow: undefined,
              })
              if (tool.output) {
                completeDeepResearchToolCall(toolCallId, tool.output)
              }
            }
          )

          outputs?.forEach(
            (output: {
              type: string
              content: string
              output_category?: string
              cards?: unknown[]
            }) => {
              if (output.type === 'report' || output.output_category === 'final_report') {
                setReportContent(output.content, 'final_report')
                if (output.cards) {
                  useChatStore.getState().setDeepResearchCards(output.cards)
                }
              }
            }
          )
        }
      } catch (stateError) {
        console.warn('Failed to load job state:', stateError)
      }
    },
    [idToken, addDeepResearchToolCall, completeDeepResearchToolCall, setReportContent]
  )

  /**
   * Load job data using REST APIs (report + state) - fast approach
   * Fetches both report and state in parallel for speed
   */
  const loadJobDataFast = useCallback(
    async (jobId: string, scope: JobLoadScope): Promise<void> => {
      const [reportResult] = await Promise.allSettled([
        getJobReport(jobId, idToken || undefined),
        loadJobState(jobId, scope),
      ])

      if (!isJobLoadScopeCurrent(scope)) return

      if (
        reportResult.status === 'fulfilled' &&
        reportResult.value.has_report &&
        reportResult.value.report
      ) {
        setReportContent(reportResult.value.report, 'final_report')
      }
    },
    [idToken, loadJobState, setReportContent]
  )

  /**
   * Stream the full job from the beginning to get all artifacts.
   * Buffers ALL events in memory and commits to the store in a single
   * setState call when the stream ends, preventing hundreds of individual
   * set() calls that cause render storms and Aw Snap crashes.
   */
  const streamFullJob = useCallback(
    (jobId: string, scope: JobLoadScope): Promise<void> => {
      return new Promise((resolve, reject) => {
        // Stacks to track active items per name (for matching start/end when events interleave)
        const activeLLMStack: string[] = []
        const activeToolStacks = new Map<string, string[]>()
        let idCounter = 0

        // Accumulation buffer — everything stays here until the stream ends
        const buffer = {
          agents: new Map<string, { name: string; input?: string; output?: string }>(),
          llmSteps: new Map<
            string,
            {
              name: string
              workflow?: string
              content: string
              thinking?: string
              usage?: { input_tokens: number; output_tokens: number }
            }
          >(),
          toolCalls: new Map<
            string,
            {
              name: string
              input?: Record<string, unknown>
              output?: string
              workflow?: string
              agentId?: string
            }
          >(),
          todos: null as TodoItem[] | null,
          citations: [] as Array<{
            url: string
            content: string
            isCited: boolean
            title?: string
            citationKey?: string
            collection?: string
            sourceType?: string
            tool?: string
            origin?: string
            fileName?: string
            page?: number
          }>,
          files: new Map<string, string>(), // filename -> latest content (deduped)
          reportContent: null as string | null,
          reportCards: null as unknown[] | null,
        }

        /**
         * Convert buffer to store-compatible arrays and write everything
         * in a single useChatStore.setState() call.
         */
        const commitToStore = (): boolean => {
          if (!isJobLoadScopeCurrent(scope)) {
            return false
          }

          const now = new Date()

          const agents = Array.from(buffer.agents.entries()).map(([id, a]) => ({
            id,
            name: a.name,
            input: a.input,
            output: a.output,
            status: 'complete' as const,
            startedAt: now,
            completedAt: now,
          }))

          const llmSteps = Array.from(buffer.llmSteps.entries()).map(([id, s]) => ({
            id,
            name: s.name,
            workflow: s.workflow,
            content: s.content,
            thinking: s.thinking,
            usage: s.usage,
            isComplete: true,
            timestamp: now,
          }))

          const toolCalls = Array.from(buffer.toolCalls.entries()).map(([id, t]) => ({
            id,
            name: t.name,
            input: t.input,
            output: t.output,
            workflow: t.workflow,
            agentId: t.agentId,
            status: 'complete' as const,
            timestamp: now,
          }))

          const citations = buffer.citations.map((c, idx) => ({
            id: `citation-${idx}`,
            url: c.url || undefined,
            content: c.content,
            isCited: c.isCited,
            timestamp: now,
            title: c.title,
            citationKey: c.citationKey,
            collection: c.collection,
            sourceType: c.sourceType,
            tool: c.tool,
            origin: normalizeOrigin(c.origin),
            fileName: c.fileName,
            page: c.page,
          }))

          const files = Array.from(buffer.files.entries()).map(([filename, content], idx) => ({
            id: `file-${idx}`,
            filename,
            content,
            timestamp: now,
          }))

          const todos = buffer.todos ? normalizeDeepResearchTodos(buffer.todos) : undefined

          useChatStore.setState((state) => ({
            ...(buffer.reportContent !== null && {
              reportContent: buffer.reportContent,
              reportContentCategory: 'final_report' as const,
            }),
            ...(todos && { deepResearchTodos: todos }),
            ...(agents.length > 0 && { deepResearchAgents: agents }),
            ...(llmSteps.length > 0 && { deepResearchLLMSteps: llmSteps }),
            ...(toolCalls.length > 0 && { deepResearchToolCalls: toolCalls }),
            ...(citations.length > 0 && { deepResearchCitations: citations }),
            ...(files.length > 0 && { deepResearchFiles: files }),
            currentStatus: buffer.reportContent !== null ? 'complete' : state.currentStatus,
          }))

          if (buffer.reportCards) {
            useChatStore.getState().setDeepResearchCards(buffer.reportCards)
          }
          return true
        }

        if (clientRef.current) {
          clientRef.current.disconnect()
          clientRef.current = null
        }

        let client: DeepResearchClient | null = null
        // The client fires onError right after a terminal failure job.status —
        // once the load settled that late error must not be logged as a failure.
        let settled = false
        const disconnectReplayClient = (): void => {
          if (!client) return
          client.disconnect()
          if (clientRef.current === client) {
            clientRef.current = null
          }
        }

        client = createDeepResearchClient({
          jobId,
          authToken: idToken || undefined,
          callbacks: {
            onStreamStart: () => {
              if (!isJobLoadScopeCurrent(scope)) return
              setCurrentStatus('researching')
            },

            onJobStatus: (status: DeepResearchJobStatus) => {
              if (status === 'success' || status === 'failure' || status === 'interrupted') {
                disconnectReplayClient()
                commitToStore()

                // This replays a job that is already terminal — a re-delivered
                // terminal 'failure' status is data, not a load error. The load
                // itself succeeded, so complete it normally (no error card, and
                // the stream stays cached instead of re-replaying on every tab
                // click).
                settled = true
                resolve()
              }
            },

            onWorkflowStart: (name, input, _eventId, agentId) => {
              if (!agentId) return
              if (!buffer.agents.has(agentId)) {
                buffer.agents.set(agentId, {
                  name,
                  input: input
                    ? typeof input === 'string'
                      ? input
                      : JSON.stringify(input)
                    : undefined,
                })
              }
            },

            onWorkflowEnd: (_name, output, _eventId, agentId) => {
              if (!agentId) return
              const agent = buffer.agents.get(agentId)
              if (agent) {
                agent.output = output
                  ? typeof output === 'string'
                    ? output
                    : JSON.stringify(output)
                  : undefined
              }
            },

            onLLMStart: (name, workflow) => {
              const uniqueId = `llm-${idCounter++}`
              activeLLMStack.push(uniqueId)
              buffer.llmSteps.set(uniqueId, { name, workflow, content: '' })
            },

            onLLMChunk: (chunk) => {
              const currentId = activeLLMStack[activeLLMStack.length - 1]
              if (currentId) {
                const step = buffer.llmSteps.get(currentId)
                if (step) {
                  step.content += chunk
                }
              }
            },

            onLLMEnd: (_output, thinking, usage) => {
              const currentId = activeLLMStack.pop()
              if (currentId) {
                const step = buffer.llmSteps.get(currentId)
                if (step) {
                  step.thinking = thinking
                  step.usage = usage
                }
              }
            },

            onToolStart: (name, input, workflow, _eventId, agentId) => {
              if (name === 'task') return
              const uniqueId = `tool-${idCounter++}`
              buffer.toolCalls.set(uniqueId, { name, input, workflow, agentId })
              let stack = activeToolStacks.get(name)
              if (!stack) {
                stack = []
                activeToolStacks.set(name, stack)
              }
              stack.push(uniqueId)
            },

            onToolEnd: (name, output, _eventId, _agentId) => {
              if (name === 'task') return
              const stack = activeToolStacks.get(name)
              const uniqueId = stack?.pop()
              if (uniqueId) {
                const tool = buffer.toolCalls.get(uniqueId)
                if (tool) {
                  // output is already a string on the wire — stringifying it
                  // again would double-JSON-encode it on replay.
                  tool.output = output
                    ? typeof output === 'string'
                      ? output
                      : JSON.stringify(output)
                    : undefined
                }
              }
            },

            onTodoUpdate: (todos: TodoItem[], workflow?: string) => {
              if (workflow) return
              buffer.todos = todos
            },

            onCitationUpdate: (url, content, isCited, extras) => {
              buffer.citations.push({
                url,
                content,
                isCited: isCited ?? false,
                title: extras?.title,
                citationKey: extras?.citationKey,
                collection: extras?.collection,
                sourceType: extras?.sourceType,
                tool: extras?.tool,
                origin: extras?.origin,
                fileName: extras?.fileName,
                page: extras?.page,
              })
            },

            onFileUpdate: (filename, content) => {
              buffer.files.set(filename, content)
            },

            onOutputUpdate: (content, outputCategory, _workflow, cards) => {
              if (outputCategory !== 'final_report') return
              buffer.reportContent = content
              if (cards) buffer.reportCards = cards
            },

            onComplete: () => {
              settled = true
              commitToStore()
              resolve()
            },

            onError: (err) => {
              if (settled) return
              console.error('Stream error while loading job data:', err)
              commitToStore()
              reject(err)
            },

            onDisconnect: () => {
              settled = true
              commitToStore()
              resolve()
            },
          },
        })

        clientRef.current = client
        client.connect()
      })
    },
    [idToken, setCurrentStatus]
  )

  /**
   * Main function to load job data
   * Checks ephemeral cache first - if data exists, just opens the panel
   * Otherwise fetches from backend
   */
  const loadJobData = useCallback(
    async (jobId: string, options: LoadJobDataOptions = {}): Promise<void> => {
      const { streamFullJob: shouldStreamFull = false } = options
      const scope = createJobLoadScope(jobId)

      // Check ephemeral cache first - if we have data for this job, just show it
      const currentState = useChatStore.getState()
      const hasReportData =
        currentState.deepResearchJobId === jobId &&
        currentState.reportContent &&
        currentState.reportContent.trim().length > 0

      // For stream requests, also check if stream is already loaded
      const hasStreamData =
        currentState.deepResearchJobId === jobId && currentState.deepResearchStreamLoaded

      // If we have what we need, just open the panel
      if (hasReportData && (!shouldStreamFull || hasStreamData)) {
        setResearchPanelTab('report')
        openRightPanel('research')
        return
      }

      // A different job is streaming live — loading this one would clear its
      // state and disconnect the live SSE. Skip the load entirely.
      if (isAnotherJobStreaming(jobId)) {
        return
      }

      // Already following this job live — re-binding would restart its stream
      // and drop the progress collected so far.
      if (isJobStreamingLive(jobId)) {
        openRightPanel('research')
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const statusResponse = await getJobStatus(jobId, idToken || undefined)
        const jobStatus = statusResponse.status

        if (!isJobLoadScopeCurrent(scope)) return

        if (!isTerminalJobStatus(jobStatus)) {
          // The run is still going: follow it live rather than reporting a
          // dead end. There is no report yet — the Tasks tab shows progress.
          followRunningJob(jobId)
          return
        }

        // Re-check after the await: a live run for another job may have
        // started while the status request was in flight.
        if (isAnotherJobStreaming(jobId)) return

        clearDeepResearch()

        if (shouldStreamFull) {
          await streamFullJob(jobId, scope)
          if (!isJobLoadScopeCurrent(scope)) return
          setStreamLoaded(true)
        } else {
          await loadJobDataFast(jobId, scope)
          if (!isJobLoadScopeCurrent(scope)) return
        }

        // Defensive cleanup: loaded data may have stale 'running' items
        // if the backend never sent completion events. Only treat as
        // successful for success jobs; interrupted/failed jobs should
        // leave un-attempted tasks as 'stopped'.
        stopAllDeepResearchSpinners(jobStatus === 'success')

        // Set job ID for cache tracking (so subsequent clicks show cached data)
        setLoadedJobId(jobId)

        setResearchPanelTab('report')
        openRightPanel('research')
      } catch (err) {
        if (!isJobLoadScopeCurrent(scope)) return

        const failureKind = getDeepResearchJobLoadFailureKind(err)
        const errorDetails = getDeepResearchJobLoadErrorDetails(err)
        const errorMessage =
          failureKind === 'unavailable'
            ? tChat('deepResearchErrors.reportUnavailable')
            : failureKind === 'backend_unreachable'
              ? tChat('deepResearchErrors.serviceUnreachable')
              : err instanceof Error
                ? err.message
                : tChat('deepResearchErrors.loadFailed')
        setError(errorMessage)
        if (failureKind === 'unavailable') {
          syncMissingJobToFailureState(jobId)
          stopAllDeepResearchSpinners()
          completeDeepResearch()
          setStreaming(false)
        } else if (failureKind === 'backend_unreachable') {
          addErrorCard('connection.failed', errorMessage, errorDetails)
        } else {
          console.error('Failed to load job data:', err)
          addErrorCard('agent.deep_research_load_failed', errorMessage)
          stopAllDeepResearchSpinners()
          completeDeepResearch()
          setStreaming(false)
        }
      } finally {
        setIsLoading(false)
      }
    },
    [
      idToken,
      tChat,
      clearDeepResearch,
      followRunningJob,
      loadJobDataFast,
      streamFullJob,
      setLoadedJobId,
      setStreamLoaded,
      stopAllDeepResearchSpinners,
      setResearchPanelTab,
      openRightPanel,
      addErrorCard,
      completeDeepResearch,
      setStreaming,
      syncMissingJobToFailureState,
    ]
  )

  /**
   * Public method: Load report + state via REST APIs (fast)
   */
  const loadReport = useCallback(
    async (jobId: string): Promise<void> => {
      await loadJobData(jobId, { streamFullJob: false })
    },
    [loadJobData]
  )

  /**
   * Public method: Import full job stream (slow but comprehensive)
   * Opens report tab after completion
   */
  const importJobStream = useCallback(
    async (jobId: string): Promise<void> => {
      await loadJobData(jobId, { streamFullJob: true })
    },
    [loadJobData]
  )

  /**
   * Import stream data only - does NOT change panel tab
   * Use when loading stream data for an already-open tab (e.g., Tasks/Thinking/Citations)
   * Checks ephemeral cache first to avoid duplicate API calls
   * A job still in progress is followed live instead of replayed — that path
   * switches the panel to Tasks, where a run's live progress renders.
   */
  const importStreamOnly = useCallback(
    async (jobId: string): Promise<void> => {
      const scope = createJobLoadScope(jobId)

      // Check if stream is already loaded for this job
      const currentState = useChatStore.getState()
      if (currentState.deepResearchJobId === jobId && currentState.deepResearchStreamLoaded) {
        return
      }

      // A different job is streaming live — loading this one would clear its
      // state and disconnect the live SSE. Skip the load entirely.
      if (isAnotherJobStreaming(jobId)) {
        return
      }

      // This job's live SSE is already connected and populating the panel.
      if (isJobStreamingLive(jobId)) {
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const statusResponse = await getJobStatus(jobId, idToken || undefined)
        const jobStatus = statusResponse.status

        if (!isJobLoadScopeCurrent(scope)) return

        if (!isTerminalJobStatus(jobStatus)) {
          // Still in progress: attach the live stream so the tab fills up as
          // the run works, instead of staying empty until it finishes.
          followRunningJob(jobId)
          return
        }

        // Re-check after the await: a live run for another job may have
        // started while the status request was in flight.
        if (isAnotherJobStreaming(jobId)) return

        clearDeepResearch()
        await streamFullJob(jobId, scope)
        if (!isJobLoadScopeCurrent(scope)) return
        // Defensive cleanup: loaded data may have stale 'running' items.
        // Only mark as successful completion for success jobs; interrupted/failed
        // jobs should leave un-attempted tasks as 'stopped'.
        stopAllDeepResearchSpinners(jobStatus === 'success')
        setStreamLoaded(true)
        setLoadedJobId(jobId)
      } catch (err) {
        if (!isJobLoadScopeCurrent(scope)) return

        const failureKind = getDeepResearchJobLoadFailureKind(err)
        const errorDetails = getDeepResearchJobLoadErrorDetails(err)
        const errorMessage =
          failureKind === 'unavailable'
            ? tChat('deepResearchErrors.reportUnavailable')
            : failureKind === 'backend_unreachable'
              ? tChat('deepResearchErrors.serviceUnreachable')
              : err instanceof Error
                ? err.message
                : tChat('deepResearchErrors.loadFailed')
        setError(errorMessage)
        if (failureKind === 'unavailable') {
          syncMissingJobToFailureState(jobId)
          stopAllDeepResearchSpinners()
          completeDeepResearch()
          setStreaming(false)
        } else if (failureKind === 'backend_unreachable') {
          addErrorCard('connection.failed', errorMessage, errorDetails)
        } else {
          console.error('Failed to load stream data:', err)
          addErrorCard('agent.deep_research_load_failed', errorMessage)
          stopAllDeepResearchSpinners()
          completeDeepResearch()
          setStreaming(false)
        }
      } finally {
        setIsLoading(false)
      }
    },
    [
      idToken,
      tChat,
      clearDeepResearch,
      followRunningJob,
      streamFullJob,
      stopAllDeepResearchSpinners,
      setStreamLoaded,
      setLoadedJobId,
      syncMissingJobToFailureState,
      addErrorCard,
      completeDeepResearch,
      setStreaming,
    ]
  )

  /**
   * Shared tab-loading policy for all ResearchPanel entry points.
   *
   * This keeps "View Report", banner actions, and direct tab clicks aligned:
   * - Report tab fetches the final report quickly via /report.
   * - Tasks/Thinking hydrate rich details by replaying /stream.
   */
  const loadResearchPanelTab = useCallback(
    async (jobId: string, tab: ResearchPanelTab): Promise<void> => {
      setResearchPanelTab(tab)
      openRightPanel('research')

      const currentState = useChatStore.getState()

      if (tab === 'report') {
        const hasReportForJob =
          currentState.deepResearchJobId === jobId && currentState.reportContent.trim().length > 0
        const isLiveReportForJob =
          currentState.deepResearchJobId === jobId && currentState.isDeepResearchStreaming

        if (hasReportForJob || isLiveReportForJob) {
          return
        }

        await loadJobData(jobId, { streamFullJob: false })
        return
      }

      if (STREAM_BACKED_RESEARCH_TABS.has(tab)) {
        const hasStreamForJob =
          currentState.deepResearchJobId === jobId && currentState.deepResearchStreamLoaded
        const isLiveStreamForJob =
          currentState.deepResearchJobId === jobId && currentState.isDeepResearchStreaming

        if (hasStreamForJob || isLiveStreamForJob) {
          return
        }

        await importStreamOnly(jobId)
      }
    },
    [loadJobData, importStreamOnly, setResearchPanelTab, openRightPanel]
  )

  return {
    loadReport,
    importJobStream,
    importStreamOnly,
    loadJobData,
    loadResearchPanelTab,
    isLoading,
    error,
    clearError,
  }
}

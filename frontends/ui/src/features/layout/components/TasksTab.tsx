/**
 * TasksTab Component
 *
 * Tab within ResearchPanel showing task/todo items from DEEP RESEARCH only.
 * Displays the running todo list from artifact.update events with type: "todo".
 *
 * SSE Events: artifact.update with type: "todo"
 */

'use client'

import { type FC, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useChatStore } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { TaskCard } from './TaskCard'

/** How often the coarse elapsed-time indicator refreshes (30s). */
const ELAPSED_TICK_MS = 30000

/**
 * Whole minutes elapsed since a live run started in this tab.
 * Returns null while no run is active, before the first full minute, or after
 * a reload (where the true start time is unknown and the indicator is hidden).
 * Re-renders at a coarse interval; the timer is cleaned up on unmount and when
 * the run reaches a terminal state.
 */
const useElapsedMinutes = (startedAt: number | null, isActive: boolean): number | null => {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isActive || !startedAt) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(interval)
  }, [isActive, startedAt])

  if (!isActive || !startedAt) return null
  const minutes = Math.floor((now - startedAt) / 60000)
  return minutes >= 1 ? minutes : null
}

/**
 * Tasks tab content showing todos/tasks from deep research.
 * Uses deepResearchTodos from the store (populated by SSE artifact.update events).
 */
export const TasksTab: FC = () => {
  const t = useTranslations('research')
  const {
    deepResearchTodos,
    currentStatus,
    isDeepResearchStreaming,
    deepResearchStartedAt,
    isDeepResearchStalled,
    deepResearchConnectionLost,
    reconnectDeepResearchFn,
    deepResearchJobId,
    deepResearchStatus,
    deepResearchOwnerConversationId,
  } = useChatStore(
    useShallow((s) => ({
      deepResearchTodos: s.deepResearchTodos,
      currentStatus: s.currentStatus,
      isDeepResearchStreaming: s.isDeepResearchStreaming,
      deepResearchStartedAt: s.deepResearchStartedAt,
      isDeepResearchStalled: s.isDeepResearchStalled,
      deepResearchConnectionLost: s.deepResearchConnectionLost,
      reconnectDeepResearchFn: s.reconnectDeepResearchFn,
      deepResearchJobId: s.deepResearchJobId,
      deepResearchStatus: s.deepResearchStatus,
      deepResearchOwnerConversationId: s.deepResearchOwnerConversationId,
    }))
  )

  const elapsedMinutes = useElapsedMinutes(deepResearchStartedAt ?? null, isDeepResearchStreaming)

  const isEmpty = deepResearchTodos.length === 0

  // Calculate progress stats
  const completedCount = deepResearchTodos.filter((t) => t.status === 'completed').length
  const totalCount = deepResearchTodos.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const isWritingReport = isDeepResearchStreaming && currentStatus === 'writing'

  // Recovery notice for a stream that stopped delivering progress (UX-11a/UX-11b).
  // Connection-lost is the stronger signal (retries exhausted), so it wins over a
  // mere stall. Both keep the job alive and offer a Reconnect action.
  const showConnectionLost = isDeepResearchStreaming && deepResearchConnectionLost
  const showStalled = isDeepResearchStreaming && isDeepResearchStalled && !deepResearchConnectionLost
  const showRecoveryNotice = showConnectionLost || showStalled

  // Outcome notice for an ATTACHED run — one followed here without an owning
  // chat thread (a workflow run opened from its run history). Those runs get
  // no thread banner, so the panel itself has to say how the run ended.
  const isAttachedRun = Boolean(deepResearchJobId) && !deepResearchOwnerConversationId
  const attachedOutcome =
    isAttachedRun && !isDeepResearchStreaming && deepResearchStatus
      ? deepResearchStatus === 'success'
        ? 'success'
        : deepResearchStatus === 'failure' || deepResearchStatus === 'interrupted'
          ? deepResearchStatus
          : null
      : null

  const outcomeNotice = attachedOutcome ? (
    <div
      role="status"
      className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 ${
        attachedOutcome === 'success' ? 'bg-info-subtle' : 'bg-warning-subtle'
      }`}
      data-testid="deep-research-outcome-notice"
    >
      {attachedOutcome === 'success' ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-info" aria-hidden="true" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      )}
      <span
        className={`text-sm ${attachedOutcome === 'success' ? 'text-info' : 'text-warning'}`}
      >
        {attachedOutcome === 'success'
          ? t('tasksTab.attachedRunFinished')
          : attachedOutcome === 'failure'
            ? t('tasksTab.attachedRunFailed')
            : t('tasksTab.attachedRunStopped')}
      </span>
    </div>
  ) : null

  const recoveryNotice = showRecoveryNotice ? (
    <div
      role="alert"
      className="flex shrink-0 flex-col gap-2 rounded-md bg-warning-subtle px-3 py-2"
      data-testid="deep-research-recovery-notice"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="text-sm font-medium text-warning">
          {showConnectionLost
            ? t('tasksTab.connectionLostTitle')
            : t('tasksTab.stalledTitle')}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {showConnectionLost
          ? t('tasksTab.connectionLostBody')
          : t('tasksTab.stalledBody')}
      </span>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => reconnectDeepResearchFn?.()}
          disabled={!reconnectDeepResearchFn}
        >
          {t('tasksTab.reconnect')}
        </Button>
      </div>
    </div>
  ) : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header with progress indicator */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">{t('tasksTab.title')}</span>
          {totalCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {completedCount}/{totalCount}
            </span>
          )}
          {/* Coarse elapsed-time indicator for the live run (UX: sets a
              duration expectation; hidden after reload where the true start
              time is unknown). */}
          {elapsedMinutes !== null && (
            <span className="text-xs text-muted-foreground" data-testid="tasks-elapsed-time">
              {t('tasksTab.elapsed', { minutes: elapsedMinutes })}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('tasksTab.description')}
        </span>
      </div>

      {/* Stall / connection-loss recovery notice — shown in-context with the todos */}
      {recoveryNotice}

      {/* How an attached (thread-less) run ended */}
      {outcomeNotice}

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <CheckCircle2 className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('tasksTab.empty')}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('tasksTab.emptyHelp')}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain">
          {/* Progress bar showing completion percentage */}
          <div className="shrink-0">
            <Progress value={progressPercent} aria-label={t('tasksTab.progressAria')} />
          </div>

          {/* Writing report indicator */}
          {isWritingReport && (
            <div className="flex shrink-0 items-center gap-2 rounded-md bg-info-subtle px-3 py-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
              <span className="text-sm text-info">
                {t('tasksTab.writingReport')}
              </span>
            </div>
          )}

          {/* Task list */}
          <div className="flex flex-col gap-2">
            {deepResearchTodos.map((todo) => (
              <div key={todo.id} className="shrink-0">
                <TaskCard todo={todo} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

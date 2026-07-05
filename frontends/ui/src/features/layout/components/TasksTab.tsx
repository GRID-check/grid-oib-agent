/**
 * TasksTab Component
 *
 * Tab within ResearchPanel showing task/todo items from DEEP RESEARCH only.
 * Displays the running todo list from artifact.update events with type: "todo".
 *
 * SSE Events: artifact.update with type: "todo"
 */

'use client'

import { type FC } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CheckCircle2 } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { useChatStore } from '@/features/chat'
import { TaskCard } from './TaskCard'

/**
 * Tasks tab content showing todos/tasks from deep research.
 * Uses deepResearchTodos from the store (populated by SSE artifact.update events).
 */
export const TasksTab: FC = () => {
  const { deepResearchTodos, currentStatus, isDeepResearchStreaming } = useChatStore(
    useShallow((s) => ({
      deepResearchTodos: s.deepResearchTodos,
      currentStatus: s.currentStatus,
      isDeepResearchStreaming: s.isDeepResearchStreaming,
    }))
  )

  const isEmpty = deepResearchTodos.length === 0

  // Calculate progress stats
  const completedCount = deepResearchTodos.filter((t) => t.status === 'completed').length
  const totalCount = deepResearchTodos.length
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const isWritingReport = isDeepResearchStreaming && currentStatus === 'writing'

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header with progress indicator */}
      <div className="flex shrink-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted-foreground">Tasks</span>
          {totalCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          Research plan breakdown and progress during deep research.
        </span>
      </div>

      {/* Content */}
      {isEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <CheckCircle2 className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Research tasks will appear here.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Shows the plan breakdown and progress during deep research.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {/* Progress bar showing completion percentage */}
          <div className="shrink-0">
            <Progress value={progressPercent} aria-label="Task completion progress" />
          </div>

          {/* Writing report indicator */}
          {isWritingReport && (
            <div className="flex shrink-0 items-center gap-2 rounded-md bg-info-subtle px-3 py-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
              <span className="text-sm text-info">
                Writing final report... This may take a few minutes.
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

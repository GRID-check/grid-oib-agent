'use client'

import { useMemo } from 'react'
import { useDocumentTitle } from '@/shared/hooks/use-document-title'
import { useTranslations } from '@/i18n/context'
import { useChatStore } from '../store'

/**
 * While a deep-research job is actively streaming, reflect its progress in the
 * browser tab so a backgrounded tab stays informative — e.g. "42% · Research —
 * Grid", or "⏳ Research — Grid" when no percentage is derivable yet.
 *
 * Progress is derived from the live todo list (completed / total). When the job
 * finishes or clears, the override is dropped and {@link useDocumentTitle}
 * restores the route-metadata title (e.g. "<Project> · Chat — Grid"). Scope
 * this to the chat page only, so the research override never leaks onto other
 * routes.
 */
export function useDeepResearchTitle(): void {
  const isStreaming = useChatStore((s) => s.isDeepResearchStreaming)
  const todos = useChatStore((s) => s.deepResearchTodos)
  const t = useTranslations('nav')

  const title = useMemo<string | null>(() => {
    if (!isStreaming) return null

    const label = t('sections.research')
    const total = todos.length
    if (total > 0) {
      const completed = todos.filter((todo) => todo.status === 'completed').length
      const percent = Math.round((completed / total) * 100)
      return t('tabTitle.researchProgress', { percent, label })
    }

    return t('tabTitle.researchActive', { label })
  }, [isStreaming, todos, t])

  useDocumentTitle(title)
}

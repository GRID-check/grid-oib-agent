'use client'

import { type FC, memo, useCallback } from 'react'
import { Globe, MessageSquareText, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/adapters/auth'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'

interface ChatToolbarProps {
  sessionTitle?: string
  onNewSession?: () => void
  isNewSessionDisabled?: boolean
}

export const ChatToolbar: FC<ChatToolbarProps> = memo(function ChatToolbar({
  sessionTitle = '',
  onNewSession,
  isNewSessionDisabled = false,
}) {
  const { isAuthenticated } = useAuth()
  const t = useTranslations('research')
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)
  const isResearchPanelOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const isDeepResearchStreaming = useChatStore((s) => s.isDeepResearchStreaming)
  const deepResearchJobId = useChatStore((s) => s.deepResearchJobId)
  const { loadResearchPanelTab, isLoading: isStreamLoading } = useLoadJobData()

  const handleMenuClick = useCallback(() => {
    if (isAuthenticated) toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  const handleAddSourcesClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel } = useLayoutStore.getState()
    if (rightPanel === 'data-sources') closeRightPanel()
    else openRightPanel('data-sources')
  }, [isAuthenticated])

  const handleResearchClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel, researchPanelTab } =
      useLayoutStore.getState()
    if (rightPanel === 'research') {
      closeRightPanel()
      return
    }
    openRightPanel('research')
    // Re-hydrate the active tab from the job when one exists (same behavior
    // the panel's own toggle tag had before it moved into the toolbar).
    if (deepResearchJobId && !isStreamLoading) {
      void loadResearchPanelTab(deepResearchJobId, researchPanelTab)
    }
  }, [isAuthenticated, deepResearchJobId, isStreamLoading, loadResearchPanelTab])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  return (
    <header className="shrink-0 border-b bg-muted/30">
      <div className="flex h-12 items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewSessionClick}
            disabled={!isAuthenticated || isNewSessionDisabled}
            aria-label={t('chatToolbar.createNewSession')}
            title={
              !isAuthenticated
                ? t('chatToolbar.signInToCreate')
                : isNewSessionDisabled
                  ? t('chatToolbar.cannotCreateActive')
                  : t('chatToolbar.createNewSession')
            }
          >
            {t('chatToolbar.newChat')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleMenuClick}
            disabled={!isAuthenticated}
            aria-label={t('chatToolbar.toggleSessions')}
            title={!isAuthenticated ? t('chatToolbar.signInToView') : t('chatToolbar.toggleSessions')}
          >
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            <span className="hidden text-sm font-semibold sm:inline">{t('chatToolbar.sessions')}</span>
          </Button>
          {sessionTitle ? <Separator orientation="vertical" className="h-5" /> : null}
          {sessionTitle ? (
            <span className="hidden max-w-[520px] truncate text-sm font-medium text-foreground md:block">
              {sessionTitle}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={isResearchPanelOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={handleResearchClick}
            disabled={!isAuthenticated}
            aria-label={
              isResearchPanelOpen ? t('researchPanel.closePanel') : t('researchPanel.openPanel')
            }
            aria-expanded={isResearchPanelOpen}
            title={
              !isAuthenticated
                ? t('researchPanel.signInToAccess')
                : isResearchPanelOpen
                  ? t('researchPanel.closePanel')
                  : t('researchPanel.openPanel')
            }
            data-testid="research-panel-toggle"
          >
            {isDeepResearchStreaming ? (
              <Spinner size="sm" label={t('researchPanel.researching')} />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="hidden text-sm sm:inline">{t('chatToolbar.research')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAddSourcesClick}
            disabled={!isAuthenticated}
            aria-label={t('chatToolbar.addSources')}
            title={!isAuthenticated ? t('chatToolbar.signInToManage') : t('chatToolbar.addSources')}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            <span className="hidden text-sm sm:inline">{t('chatToolbar.sources')}</span>
          </Button>
        </div>
      </div>
    </header>
  )
})

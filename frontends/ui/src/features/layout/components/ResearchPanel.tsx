/**
 * ResearchPanel Component
 *
 * Right-side panel showing Tasks, Thinking, or Report content.
 * Includes top action bar with tabs.
 *
 * This panel PUSHES the chat area (takes 60% width) rather than overlaying it.
 */

'use client'

import { type FC, type ReactNode, memo, useCallback, useRef, useEffect } from 'react'
import { CircleStop, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { cancelJob } from '@/adapters/api'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { useAuth } from '@/adapters/auth'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'
import { TasksTab } from './TasksTab'
import { ThinkingTab } from './ThinkingTab'
import { ReportTab } from './ReportTab'
import type { ResearchPanelTab } from '../types'

const TABS_REQUIRING_STREAM: ResearchPanelTab[] = ['tasks', 'thinking']

/** Fallback timeout: if the SSE stream doesn't deliver the interrupted
 *  status within this window after cancel, clean up the UI optimistically. */
const CANCEL_FALLBACK_TIMEOUT_MS = 5000

interface ResearchPanelProps {
  /** Content to display in the panel */
  children?: ReactNode
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
}

/**
 * Research panel with tabbed content (Tasks, Thinking, Report).
 * Opens from the right side of the screen, pushing the chat area.
 * Takes 60% of the screen width when open.
 */
export const ResearchPanel: FC<ResearchPanelProps> = memo(function ResearchPanel({
  children,
  isAuthenticated = false,
}) {
  const t = useTranslations('research')
  const isOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const researchPanelTab = useLayoutStore((s) => s.researchPanelTab)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const isDeepResearchStreaming = useChatStore((state) => state.isDeepResearchStreaming)
  const deepResearchJobId = useChatStore((state) => state.deepResearchJobId)
  const { loadResearchPanelTab, isLoading: isStreamLoading } = useLoadJobData()
  const { idToken } = useAuth()

  const prefersReducedMotion = useReducedMotion()
  const isMobile = useIsMobile()
  const cancelFallbackRef = useRef<NodeJS.Timeout | null>(null)
  const pendingTabLoadRef = useRef<{ jobId: string; tab: ResearchPanelTab } | null>(null)

  // Clean up cancel fallback timer on unmount
  useEffect(() => {
    return () => {
      if (cancelFallbackRef.current) {
        clearTimeout(cancelFallbackRef.current)
        cancelFallbackRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (isStreamLoading) return

    const pendingLoad = pendingTabLoadRef.current
    if (!pendingLoad) return

    pendingTabLoadRef.current = null
    if (pendingLoad.jobId !== deepResearchJobId) return

    void loadResearchPanelTab(pendingLoad.jobId, pendingLoad.tab)
  }, [deepResearchJobId, isStreamLoading, loadResearchPanelTab])

  const handleClose = useCallback(() => {
    closeRightPanel()
  }, [closeRightPanel])

  const handleStopResearch = useCallback(async () => {
    if (!deepResearchJobId) return
    const cancelledJobId = deepResearchJobId
    try {
      await cancelJob(cancelledJobId, idToken || undefined)

      // Fallback: if the SSE stream is broken or stalled and the
      // useDeepResearch hook's onJobStatus never receives the
      // "interrupted" event, clean up locally after a grace period.
      // This is a safety net in addition to the hook's own fallback.
      if (cancelFallbackRef.current) clearTimeout(cancelFallbackRef.current)
      cancelFallbackRef.current = setTimeout(() => {
        cancelFallbackRef.current = null
        const state = useChatStore.getState()
        if (!state.isDeepResearchStreaming || state.deepResearchJobId !== cancelledJobId) {
          return // Already cleaned up by SSE or hook fallback
        }
        console.warn(
          '[ResearchPanel] Cancel fallback: SSE did not deliver interrupted status. Cleaning up locally.'
        )
        state.stopAllDeepResearchSpinners()
        const ownerConvId = state.deepResearchOwnerConversationId
        const messageId = state.activeDeepResearchMessageId
        const hasReport = Boolean(state.reportContent?.trim())
        if (ownerConvId && messageId) {
          state.patchConversationMessage(ownerConvId, messageId, {
            content: '',
            deepResearchJobStatus: 'interrupted',
            isDeepResearchActive: false,
            showViewReport: hasReport,
          })
        }
        state.addDeepResearchBanner('cancelled', cancelledJobId, ownerConvId || undefined)
        state.completeDeepResearch()
        state.setStreaming(false)
      }, CANCEL_FALLBACK_TIMEOUT_MS)
    } catch (error) {
      console.error('Failed to cancel job:', error)
      toast.error(t('researchPanel.couldNotStop'), {
        description: t('researchPanel.couldNotStopDesc'),
      })
    }
  }, [deepResearchJobId, idToken])

  const handleToggle = useCallback(() => {
    if (!isAuthenticated) return

    if (isOpen) {
      closeRightPanel()
    } else {
      openRightPanel('research')

      if (deepResearchJobId && !isStreamLoading) {
        void loadResearchPanelTab(deepResearchJobId, researchPanelTab)
      }
    }
  }, [
    isAuthenticated,
    isOpen,
    closeRightPanel,
    openRightPanel,
    researchPanelTab,
    deepResearchJobId,
    isStreamLoading,
    loadResearchPanelTab,
  ])

  const handleTabChange = useCallback(
    (value: string) => {
      const tab = value as ResearchPanelTab

      if (deepResearchJobId && !isStreamLoading) {
        void loadResearchPanelTab(deepResearchJobId, tab)
        return
      }

      if (deepResearchJobId && isStreamLoading) {
        // Preserve the selected tab immediately, then load its required data
        // once the current replay/fetch finishes. Without this, a mid-load
        // tab switch can appear selected but never trigger its own fetch.
        pendingTabLoadRef.current = { jobId: deepResearchJobId, tab }
      }

      setResearchPanelTab(tab)
    },
    [setResearchPanelTab, deepResearchJobId, isStreamLoading, loadResearchPanelTab]
  )

  return (
    // Wrapper: uses flex to keep button visible while panel animates
    <div
      className="relative flex h-full"
      style={{
        // Mobile: the open panel takes the whole viewport width (the chat
        // column collapses to 0% in MainLayout); desktop keeps the 50% split.
        width: isOpen ? (isMobile ? '100%' : 'calc(50% + 40px)') : '40px',
        minWidth: isOpen ? (isMobile ? '100%' : 'calc(50% + 40px)') : '40px',
        transition: prefersReducedMotion
          ? 'none'
          : 'width 600ms ease-in-out, min-width 600ms ease-in-out',
      }}
    >
      {/* Toggle Tag Button - protruding from left side, always visible */}
      <button
        onClick={handleToggle}
        disabled={!isAuthenticated}
        className={cn(
          'relative z-10 mt-3 flex h-[152px] w-10 shrink-0 items-center justify-center self-start overflow-hidden rounded-l-lg border bg-background outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          isAuthenticated ? 'cursor-pointer hover:border-brand' : 'cursor-not-allowed opacity-50'
        )}
        aria-label={isOpen ? t('researchPanel.closePanel') : t('researchPanel.openPanel')}
        aria-expanded={isOpen}
        title={
          isAuthenticated
            ? isOpen
              ? t('researchPanel.closePanel')
              : t('researchPanel.openPanel')
            : t('researchPanel.signInToAccess')
        }
        data-testid="research-panel-toggle"
      >
        <span className="absolute left-1/2 top-3 flex h-6 w-6 -translate-x-1/2 items-center justify-center">
          {isDeepResearchStreaming ? (
            <Spinner size="sm" label={t('researchPanel.researching')} />
          ) : (
            <Sparkles className="h-6 w-6" aria-hidden="true" />
          )}
        </span>
        <span className="absolute left-1/2 top-[84px] -translate-x-1/2 -rotate-90 whitespace-nowrap text-sm font-semibold">
          {t('researchPanel.showResearch')}
        </span>
      </button>

      {/* Outer container: clips content, fills remaining space */}
      <div
        className="-ml-px h-full flex-1 overflow-hidden rounded-tl-xl border-l border-t bg-background"
        aria-hidden={!isOpen}
      >
        {/* Inner container: fixed width so content stays stable */}
        <div
          className="flex h-full w-full flex-col"
          style={{
            visibility: isOpen ? 'visible' : 'hidden',
            opacity: isOpen ? 1 : 0,
            transition: prefersReducedMotion
              ? 'none'
              : isOpen
                ? 'opacity 100ms ease-in-out, visibility 0ms'
                : 'opacity 100ms ease-in-out 500ms, visibility 0ms 600ms',
          }}
        >
          {/* Header with tabs and close button */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b py-3 pl-3 pr-3 sm:py-4 sm:pl-6 sm:pr-8">
            <div className="flex min-w-0 items-center gap-2 sm:gap-4">
              <Tabs value={researchPanelTab} onValueChange={handleTabChange}>
                <TabsList>
                  <TabsTrigger value="tasks">{t('researchPanel.tabTasks')}</TabsTrigger>
                  <TabsTrigger value="thinking">{t('researchPanel.tabThinking')}</TabsTrigger>
                  <TabsTrigger value="report">{t('researchPanel.tabReport')}</TabsTrigger>
                </TabsList>
              </Tabs>
              {/* Stop Researching button - always visible, disabled when not streaming */}
              <Button
                variant="ghost"
                size="sm"
                onClick={isDeepResearchStreaming ? handleStopResearch : undefined}
                disabled={!isDeepResearchStreaming}
                aria-label={t('researchPanel.stopResearching')}
                title={isDeepResearchStreaming ? t('researchPanel.stopResearching') : t('researchPanel.noActiveResearch')}
                data-testid="research-panel-stop"
              >
                <CircleStop className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">{t('researchPanel.stopResearchingButton')}</span>
              </Button>
            </div>
            <div className="flex items-center gap-4">
              {/* Close button */}
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={handleClose}
                aria-label={t('researchPanel.closePanel')}
                title={t('researchPanel.closePanel')}
                data-testid="research-panel-close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {/* Content Area - each tab manages its own scrolling and footer */}
          <div className="flex flex-1 flex-col overflow-hidden px-4 py-4 sm:py-5 sm:pl-6 sm:pr-8">
            {isStreamLoading ? (
              <div className="flex h-full flex-col items-center justify-center gap-4">
                <Spinner label={t('researchPanel.loadingData')} />
                <span className="text-sm text-muted-foreground">
                  {TABS_REQUIRING_STREAM.includes(researchPanelTab)
                    ? t('researchPanel.loadingDataEllipsis')
                    : t('researchPanel.loadingReport')}
                </span>
              </div>
            ) : (
              <>
                {researchPanelTab === 'tasks' && <TasksTab />}
                {researchPanelTab === 'thinking' && <ThinkingTab />}
                {researchPanelTab === 'report' && <ReportTab>{children}</ReportTab>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

/**
 * ResearchPanel Component
 *
 * Right-side panel showing Tasks, Thinking, or Report content.
 * Includes top action bar with tabs.
 *
 * This panel PUSHES the chat area (shares the width 50/50) rather than
 * overlaying it. Opening and closing is driven from the ChatToolbar's
 * Research toggle; the panel itself only offers a close button.
 */

'use client'

import { type FC, type ReactNode, memo, useCallback, useRef, useEffect, useState } from 'react'
import { CircleStop, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cancelJob } from '@/adapters/api'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { useAuth } from '@/adapters/auth'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useTranslations } from '@/i18n'
import { useEscapeKey } from '@/shared/hooks/use-escape-key'
import { usePanelFocus } from '@/shared/hooks/use-panel-focus'
import { useLayoutStore } from '../store'
import { TasksTab } from './TasksTab'
import { ThinkingTab } from './ThinkingTab'
import { ReportTab } from './ReportTab'
import { StopResearchConfirmationModal } from './StopResearchConfirmationModal'
import type { ResearchPanelTab } from '../types'

const TABS_REQUIRING_STREAM: ResearchPanelTab[] = ['tasks', 'thinking']

/** Fallback timeout: if the SSE stream doesn't deliver the interrupted
 *  status within this window after cancel, clean up the UI optimistically. */
const CANCEL_FALLBACK_TIMEOUT_MS = 5000

interface ResearchPanelProps {
  /** Content to display in the panel */
  children?: ReactNode
  /**
   * Whether report source lines show origin badges (WorkOS
   * `source-origin-badges` flag, FB-2). Threaded to ReportTab. Defaults to
   * true (fail-open) so existing callers/specs are unaffected.
   */
  showSourceBadges?: boolean
}

/**
 * Research panel with tabbed content (Tasks, Thinking, Report).
 * Opens from the right side of the screen, pushing the chat area.
 * Takes half of the screen width when open (full width on mobile).
 */
export const ResearchPanel: FC<ResearchPanelProps> = memo(function ResearchPanel({
  children,
  showSourceBadges = true,
}) {
  const t = useTranslations('research')
  const isOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const researchPanelTab = useLayoutStore((s) => s.researchPanelTab)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const closeRightPanel = useLayoutStore((s) => s.closeRightPanel)
  const isDeepResearchStreaming = useChatStore((state) => state.isDeepResearchStreaming)
  const deepResearchJobId = useChatStore((state) => state.deepResearchJobId)
  const { loadResearchPanelTab, isLoading: isStreamLoading } = useLoadJobData()
  const { idToken } = useAuth()

  const prefersReducedMotion = useReducedMotion()
  const isMobile = useIsMobile()
  // Cancelling a run is irreversible, so — like every delete flow in the
  // product — it goes through an explicit confirmation dialog first.
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const cancelFallbackRef = useRef<NodeJS.Timeout | null>(null)
  const pendingTabLoadRef = useRef<{ jobId: string; tab: ResearchPanelTab } | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // On open, move focus to the close button and remember the opener (the
  // toolbar's Research toggle) so Escape can return focus to it. Skipped when
  // the panel auto-opens while a text field is focused, so it never steals the
  // caret.
  const { restoreFocus } = usePanelFocus(isOpen, closeButtonRef)

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

  const handleEscape = useCallback(() => {
    restoreFocus()
    closeRightPanel()
  }, [restoreFocus, closeRightPanel])

  // Escape closes the panel; the listener is inert while the panel is closed.
  useEscapeKey(isOpen, handleEscape)

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
    // Wrapper animates its width; the panel content fades in once it lands.
    <aside
      role="dialog"
      // Full-screen on mobile, where the panel covers the page and behaves
      // modally; on desktop it shares the split with the still-usable chat
      // column, so it is a non-modal dialog.
      aria-modal={isMobile}
      className="relative h-full overflow-hidden"
      style={{
        // Mobile: the open panel takes the whole viewport width (the chat
        // column collapses to 0% in MainLayout); desktop keeps the 50% split.
        width: isOpen ? (isMobile ? '100%' : '50%') : '0%',
        transition: prefersReducedMotion ? 'none' : 'width 300ms ease-in-out',
      }}
      aria-hidden={!isOpen}
      aria-label={t('chatToolbar.research')}
    >
      {/* Outer container: clips content while the wrapper animates */}
      <div className="h-full overflow-hidden border-l bg-background">
        <div
          className="flex h-full w-full flex-col"
          style={{
            visibility: isOpen ? 'visible' : 'hidden',
            opacity: isOpen ? 1 : 0,
            transition: prefersReducedMotion
              ? 'none'
              : isOpen
                ? 'opacity 100ms ease-in-out, visibility 0ms'
                : 'opacity 100ms ease-in-out 200ms, visibility 0ms 300ms',
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
              {/* Stop Researching button - always visible, disabled when not streaming.
                  Opens a confirmation dialog first: a cancelled run cannot be resumed. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={isDeepResearchStreaming ? () => setShowStopConfirm(true) : undefined}
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
                ref={closeButtonRef}
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
              // Tab-shaped skeleton rows (matching the sibling loading states in
              // file-browser-pane / project-members-form) instead of a bare
              // centered spinner, so the switch reads as content loading in place.
              <div
                className="flex flex-col gap-3"
                role="status"
                aria-label={
                  TABS_REQUIRING_STREAM.includes(researchPanelTab)
                    ? t('researchPanel.loadingDataEllipsis')
                    : t('researchPanel.loadingReport')
                }
              >
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-md" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-1/2" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {researchPanelTab === 'tasks' && <TasksTab />}
                {researchPanelTab === 'thinking' && <ThinkingTab />}
                {researchPanelTab === 'report' && (
                  <ReportTab showSourceBadges={showSourceBadges}>{children}</ReportTab>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation before cancelling the run — it cannot be resumed. */}
      <StopResearchConfirmationModal
        open={showStopConfirm}
        onOpenChange={setShowStopConfirm}
        onConfirm={() => {
          void handleStopResearch()
        }}
      />
    </aside>
  )
})

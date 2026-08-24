/**
 * DeepResearchBanner Component
 *
 * Displays status banners for deep research jobs in the chat area.
 * Variants:
 * - "starting": Research in progress, with View Progress action
 * - "success": Research completed, report is ready
 * - "failure": Research failed or was interrupted
 * - "expired": Research report was deleted or expired server-side
 */

'use client'

import { type FC, useCallback } from 'react'
import { CheckCircle2, Info, AlertTriangle, XCircle } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { useLayoutStore } from '@/features/layout/store'
import { useLoadJobData } from '../hooks/use-load-job-data'
import type { DeepResearchBannerType } from '../types'

export interface DeepResearchBannerProps {
  /** Type of banner: starting, success, failure, cancelled, or expired */
  bannerType: DeepResearchBannerType
  /** Job ID for identification */
  jobId: string
  /** Number of tool calls (for success banner) */
  toolCallCount?: number
  /** Timestamp of the status update (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /**
   * When this turn escalated shallow→deep, the classifier's escalation reason.
   * Rendered as a one-line narration directly ABOVE the banner
   * (`Eskaliert zur Tiefenrecherche: <reason>`) per the transparency contract.
   */
  escalationReason?: string
}

/** Banner status type */
type BannerStatus = 'success' | 'info' | 'warning' | 'error'

/** Maps banner status to Alert variant + icon */
const STATUS_META: Record<BannerStatus, { variant: 'success' | 'info' | 'warning' | 'destructive'; Icon: typeof Info }> = {
  success: { variant: 'success', Icon: CheckCircle2 },
  info: { variant: 'info', Icon: Info },
  warning: { variant: 'warning', Icon: AlertTriangle },
  error: { variant: 'destructive', Icon: XCircle },
}

interface BannerConfig {
  heading: string
  subheading: string
  buttonText?: string
  buttonTab?: 'report' | 'tasks' | 'thinking'
  status: BannerStatus
}

/**
 * Banner configuration for each banner type
 */
const getBannerConfig = (
  bannerType: DeepResearchBannerType,
  t: Translator,
  stats?: { toolCallCount?: number }
): BannerConfig => {
  switch (bannerType) {
    case 'success': {
      // The stats suffix on the success heading.
      //
      // The token total used to sit here too. `600ea144` renamed it away from
      // "Tokens" to „Textmenge", which is honest about what it counts and still
      // meaningless to the person reading it: there is no unit a Ziviltechniker
      // has ever been shown, "12.4K" of nothing is not a quantity anybody can
      // compare or act on, and it reported a measure of OUR cost inside a
      // sentence about THEIR report. A euphemism does not rescue a statistic
      // that should not be there, so the statistic is gone with the word.
      //
      // The tool-call count stays. It counts an action the Agenten panel beside
      // it lists one per row, so the number here and the rows there can be read
      // against each other, and it answers a question a reader actually has
      // about a run that took minutes: how much went on.
      const statsParts: string[] = []
      if (stats?.toolCallCount && stats.toolCallCount > 0) {
        statsParts.push(t('deepResearch.stats.toolCalls', { count: stats.toolCallCount }))
      }
      const statsText = statsParts.length > 0 ? ` (${statsParts.join(' · ')})` : ''

      return {
        heading: t('deepResearch.success.heading', { stats: statsText }),
        subheading: t('deepResearch.success.subheading'),
        buttonText: t('deepResearch.viewReport'),
        buttonTab: 'report',
        status: 'success',
      }
    }
    case 'failure':
      return {
        heading: t('deepResearch.failure.heading'),
        subheading: t('deepResearch.failure.subheading'),
        buttonText: t('deepResearch.viewThinking'),
        buttonTab: 'thinking',
        status: 'error',
      }
    case 'cancelled':
      return {
        heading: t('deepResearch.cancelled.heading'),
        subheading: t('deepResearch.cancelled.subheading'),
        buttonText: t('deepResearch.viewProgress'),
        buttonTab: 'tasks',
        status: 'warning',
      }
    case 'expired':
      return {
        heading: t('deepResearch.expired.heading'),
        subheading: t('deepResearch.expired.subheading'),
        status: 'warning',
      }
    case 'starting':
      return {
        heading: t('deepResearch.starting.heading'),
        subheading: t('deepResearch.starting.subheading'),
        buttonText: t('deepResearch.viewProgress'),
        buttonTab: 'tasks',
        status: 'info',
      }
  }
}

/**
 * Deep research status banner displayed in the chat area
 */
export const DeepResearchBanner: FC<DeepResearchBannerProps> = ({
  bannerType,
  jobId,
  toolCallCount,
  timestamp,
  escalationReason,
}) => {
  const t = useTranslations('chat')
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const { loadResearchPanelTab } = useLoadJobData()
  const config = getBannerConfig(bannerType, t, { toolCallCount })

  // Job is complete if banner type indicates completion (success, failure, cancelled, expired)
  // 'starting' banner means job is still in progress - don't try to load archived data
  const isJobComplete = bannerType !== 'starting'

  const handleButtonClick = useCallback(async () => {
    const buttonTab = config.buttonTab
    if (!buttonTab) return

    if (isJobComplete) {
      await loadResearchPanelTab(jobId, buttonTab)
      return
    }

    setResearchPanelTab(buttonTab)
    openRightPanel('research')
    // For incomplete jobs (starting), the live SSE connection is already populating data
  }, [
    config.buttonTab,
    openRightPanel,
    setResearchPanelTab,
    jobId,
    loadResearchPanelTab,
    isJobComplete,
  ])

  // Surface each completed banner's configured action so the user can act on the
  // outcome — View Report on success, and View Thinking / View Progress on
  // failure or cancellation so a failed run can actually be diagnosed (UX-12).
  // The live "starting" banner stays action-free (its progress is already
  // streaming into the panel), and "expired" has no action to offer.
  const actions =
    bannerType !== 'starting' && config.buttonText && config.buttonTab ? (
      <Button
        variant="outline"
        size="sm"
        onClick={handleButtonClick}
        aria-label={config.buttonText}
      >
        {config.buttonText}
      </Button>
    ) : undefined

  const { variant, Icon } = STATUS_META[config.status]

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col gap-1 duration-base ease-entrance motion-reduce:animate-none">
      {escalationReason?.trim() && (
        <p className="px-1 text-xs leading-relaxed text-warning" role="status">
          {t('deepResearch.escalationNarration', { reason: escalationReason.trim() })}
        </p>
      )}
      <Alert variant={variant}>
        <Icon />
        <AlertTitle>{config.heading}</AlertTitle>
        <AlertDescription>
          <span>{config.subheading}</span>
          {actions && <div className="mt-1">{actions}</div>}
        </AlertDescription>
      </Alert>
      {timestamp && (
        <span className="text-subtle mr-3 self-end text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}

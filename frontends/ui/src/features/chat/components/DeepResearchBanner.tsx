// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { formatTime } from '@/shared/utils/format-time'
import { useLayoutStore } from '@/features/layout/store'
import { useLoadJobData } from '../hooks/use-load-job-data'
import type { DeepResearchBannerType } from '../types'

export interface DeepResearchBannerProps {
  /** Type of banner: starting, success, failure, cancelled, or expired */
  bannerType: DeepResearchBannerType
  /** Job ID for identification */
  jobId: string
  /** Total tokens used (for success banner) */
  totalTokens?: number
  /** Number of tool calls (for success banner) */
  toolCallCount?: number
  /** Timestamp of the status update (Date or ISO string from persisted state) */
  timestamp?: Date | string
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

/** Format token count with K suffix for thousands */
const formatTokens = (count: number): string => {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`
  }
  return count.toString()
}

/**
 * Banner configuration for each banner type
 */
const getBannerConfig = (
  bannerType: DeepResearchBannerType,
  stats?: { totalTokens?: number; toolCallCount?: number }
): BannerConfig => {
  switch (bannerType) {
    case 'success': {
      // Build stats suffix for success banner
      const statsParts: string[] = []
      if (stats?.totalTokens && stats.totalTokens > 0) {
        statsParts.push(`${formatTokens(stats.totalTokens)} tokens`)
      }
      if (stats?.toolCallCount && stats.toolCallCount > 0) {
        statsParts.push(`${stats.toolCallCount} tool calls`)
      }
      const statsText = statsParts.length > 0 ? ` (${statsParts.join(' · ')})` : ''

      return {
        heading: `Report Completed!${statsText}`,
        subheading: 'Research has finished and a report is ready to view in the research panel.',
        buttonText: 'View Report',
        buttonTab: 'report',
        status: 'success',
      }
    }
    case 'failure':
      return {
        heading: 'Report Failed to Complete',
        subheading:
          'Something prevented the research report from completing. Check the thinking for details.',
        buttonText: 'View Thinking',
        buttonTab: 'thinking',
        status: 'error',
      }
    case 'cancelled':
      return {
        heading: 'Research Cancelled',
        subheading:
          'Research was stopped by user. You can view any partial progress in the research panel.',
        buttonText: 'View Progress',
        buttonTab: 'tasks',
        status: 'warning',
      }
    case 'expired':
      return {
        heading: 'Report Expired',
        subheading: 'The report has expired and is no longer available.',
        status: 'warning',
      }
    case 'starting':
      return {
        heading: 'Starting Deep Research',
        subheading:
          'Chat is paused while the report is created to prevent generating multiple reports. You can click away while this runs — it may take several minutes.',
        buttonText: 'View Progress',
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
  totalTokens,
  toolCallCount,
  timestamp,
}) => {
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const { loadResearchPanelTab } = useLoadJobData()
  const config = getBannerConfig(bannerType, { totalTokens, toolCallCount })

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

  // Keep archived/error-state banners informational. The report CTA is the
  // only banner action we keep visible to avoid competing recovery paths.
  const actions =
    bannerType === 'success' && config.buttonText ? (
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
    <div className="flex w-full flex-col gap-1">
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

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

import { type FC, type MouseEvent, useCallback } from 'react'
import { CheckCircle2, Info, AlertTriangle, XCircle } from 'lucide-react'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { useLayoutStore } from '@/features/layout/store'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { openFiledDocument } from '@/features/documents/lib/open-filed-document'
import { useChatStore } from '../store'
import { useLoadJobData } from '../hooks/use-load-job-data'
import type { DeepResearchBannerType, DeepResearchFiledDocument } from '../types'

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
   * When this turn escalated shallow→deep, the agent's own escalation reason.
   * Rendered as a one-line narration directly ABOVE the banner
   * (`Eskaliert zur Tiefenrecherche: <reason>`) per the transparency contract.
   */
  escalationReason?: string
  /**
   * The document this run's report was filed as, once one exists.
   *
   * Absent is the normal state, not a pending one — see
   * `DeepResearchBannerData.filedDocument`. The banner renders nothing about a
   * file when it is missing: offering to open a document that does not exist
   * would be a worse failure than the silence.
   */
  filedDocument?: DeepResearchFiledDocument
  /**
   * A filing this run's starting banner promised, which then did not land.
   *
   * The one absence that is NOT silent. Everywhere else a missing
   * `filedDocument` means nothing was promised — see above — but this flag is
   * the report route saying it tried, for a project it had resolved, which is
   * the same condition that made the disclosure render in the first place. So
   * the reader who read „wird abgelegt" is the reader who sees the retraction,
   * and nobody else.
   */
  filingFailed?: boolean
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
  filedDocument,
  filingFailed,
}) => {
  const t = useTranslations('chat')
  // Read here rather than threaded through ChatArea, the same way the layout
  // store already is: both the disclosure and the deep link are facts about
  // where this chat is, not about the message the banner sits in.
  const projectId = useChatStore((s) => s.projectId)
  const isMobile = useIsMobile()
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

  // Where the report will land, said while the run can still be stopped.
  //
  // This line IS the authorization. The design calls the filing "commissioned"
  // — the user asked for a report and was told where it goes — but deep
  // research escalates out of a chat turn rather than a submit form, and the
  // escalation can be the agent's own decision (`escalationReason` above), so
  // "the user asked" is not reliably true either. What can be made true is that
  // nobody is surprised: the destination is named before the file exists, at
  // the one moment stopping the run is still an option. A modal after the fact
  // was rejected in the design and is not to be added — it is answered yes
  // every time, which makes it a receipt, not a decision.
  //
  // Outside a project there is nothing to disclose: the report route resolves
  // the project from the request and files nothing without one.
  const filingDisclosure =
    bannerType === 'starting' && projectId ? t('deepResearch.starting.filingDisclosure') : undefined

  // The filed document, offered only when the BFF has said one exists. Reuses
  // the Files deep link every other document surface uses (`documentFilesHref`,
  // also the sharing registry's `document` descriptor) rather than inventing a
  // second URL shape for the same destination.
  const filedHref =
    bannerType === 'success' && filedDocument && projectId
      ? documentFilesHref(projectId, filedDocument.documentId)
      : undefined

  // The retraction of `filingDisclosure`, and it is deliberately built out of
  // the same three conditions that built the promise.
  //
  // `bannerType` and `projectId` mirror the disclosure exactly: outside a
  // project no line was ever printed, so there is nothing to take back, and a
  // banner in that state stays as silent as it always was. `!filedHref` is the
  // guard against the two lines ever appearing together — a document that
  // exists outranks a later attempt that failed.
  //
  // WHY this is said at all, given the rule one line up that the banner never
  // claims a file that does not exist: that rule forbids inventing a document,
  // not correcting a promise. Absence of `filed` means four different things on
  // the wire and the route separates them (`filingFailed`); three of them are
  // states in which nobody was told anything, and this is the fourth. A reader
  // who saw „wird abgelegt" is on their way to Berichte. Saying nothing does
  // not spare them the failure, it only makes them find it alone, with the
  // explanation in a server log they cannot read.
  //
  // And it is said the way the promise was said: one muted line, in the same
  // `text-subtle text-xs` slot, inside a banner that stays `success` because
  // the RESEARCH succeeded. No red, no icon, no `warning` variant — the run is
  // not in error and colour in this product belongs to provenance
  // (`docs/design/grid-design-language.md`). No reason either: a refused quota,
  // a revoked permission and a report too long to render are one fact here.
  const filingRetraction =
    bannerType === 'success' && filingFailed && !filedHref && projectId
      ? t('deepResearch.success.filingFailedLine')
      : undefined

  // Beside the conversation, not instead of it.
  //
  // The reader commissioned a run that took minutes; answering "go somewhere
  // else to look at it" spends the thread they were in. `FilePreviewHost`
  // already renders a document as a second pane in the chat split — the pattern
  // citations use — so this routes into that instead of navigating, through the
  // same `openFiledDocument` the diagram fence calls. Two ways to open one
  // thing is two things that can disagree.
  //
  // Still a real link underneath: modified clicks, "copy link address" and the
  // phone all reach the Files route, because the peek is suppressed below the
  // `md` breakpoint and a control that does nothing there would be worse than
  // one that navigates.
  const openFiled = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!filedHref || !filedDocument || !projectId) return
      if (isMobile || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      void openFiledDocument({ documentId: filedDocument.documentId, projectId }).then((opened) => {
        if (!opened) window.location.assign(filedHref)
      })
    },
    [filedHref, filedDocument, projectId, isMobile],
  )

  const { variant, Icon } = STATUS_META[config.status]

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col gap-1 duration-base ease-entrance motion-reduce:animate-none">
      {escalationReason?.trim() && (
        // Muted ink, not `text-warning`. The line narrates WHY the run escalated
        // — information, not a fault — and the office gold it used to carry is a
        // provenance/attention signal travelling with neither an icon nor a
        // label, one inch above an `info` Alert whose blue says the opposite
        // about the same run. Colour never travels alone; this sentence needs
        // none.
        <p className="px-1 text-xs leading-relaxed text-muted-foreground" role="status">
          {t('deepResearch.escalationNarration', { reason: escalationReason.trim() })}
        </p>
      )}
      <Alert variant={variant}>
        <Icon />
        <AlertTitle>{config.heading}</AlertTitle>
        <AlertDescription>
          <span>{config.subheading}</span>
          {filingDisclosure && <span className="text-subtle text-xs">{filingDisclosure}</span>}
          {filedHref && filedDocument && (
            <span className="text-subtle text-xs">
              {t('deepResearch.success.filedLine', { filename: filedDocument.filename })}
            </span>
          )}
          {filingRetraction && (
            <span className="text-subtle text-xs" data-testid="research-filing-failed">
              {filingRetraction}
            </span>
          )}
          {(actions || filedHref) && (
            <div className="mt-1 flex flex-wrap gap-2">
              {actions}
              {filedHref && (
                <Button variant="outline" size="sm" asChild>
                  <a href={filedHref} onClick={openFiled} data-testid="research-open-filed">
                    {t('deepResearch.openInProject')}
                  </a>
                </Button>
              )}
            </div>
          )}
        </AlertDescription>
      </Alert>
      {timestamp && (
        <span className="text-subtle mr-3 self-end text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}

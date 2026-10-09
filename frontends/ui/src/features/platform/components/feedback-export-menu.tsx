'use client'

/**
 * The answer-feedback export, as three plain download links in a menu.
 *
 * The first is the one people mean by "export the feedback": every vote in the
 * window, both directions, as a workbook with the weeks and a column guide. The
 * page's filters are a second, explicit choice, with what they hold spelled out
 * under it — the old single button followed the drill-in, which defaults to the
 * failures, and its file looked like the whole thing. The CSV is for scripts.
 *
 * Links rather than a fetch: the route sets `Content-Disposition`, so the
 * download costs the bundle nothing and works without JavaScript state.
 */

import type { JSX } from 'react'
import { ChevronDown, Download, FileSpreadsheet, FileText, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemText,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'

const EXPORT_ROUTE = '/api/platform/answer-feedback/export'

export interface FeedbackExportMenuProps {
  /** The window, owned by the page. */
  days: number
  /** The drill-in's own query string: the filters the selection export applies. */
  selectionSearch: string
  /** What the selection holds, in words, shown under its item. */
  selectionSummary: string
}

/** The three hrefs, exported so a spec can hold them to the route's parameters. */
export function feedbackExportHrefs(days: number, selectionSearch: string): {
  all: string
  selection: string
  csv: string
} {
  const windowParam = `days=${encodeURIComponent(String(days))}`
  return {
    all: `${EXPORT_ROUTE}?${windowParam}&format=xlsx`,
    selection: `${EXPORT_ROUTE}?${selectionSearch}&scope=selection&format=xlsx`,
    csv: `${EXPORT_ROUTE}?${windowParam}&format=csv`,
  }
}

export function FeedbackExportMenu({ days, selectionSearch, selectionSummary }: FeedbackExportMenuProps): JSX.Element {
  const t = useTranslations('platform')
  const hrefs = feedbackExportHrefs(days, selectionSearch)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="feedback-export">
          <Download className="size-3.5" aria-hidden />
          {t('answerFeedback.exportMenu.trigger')}
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} className="w-80">
        <DropdownMenuItem asChild>
          <a href={hrefs.all} download data-testid="feedback-export-all">
            <FileSpreadsheet aria-hidden />
            <DropdownMenuItemText
              title={t('answerFeedback.exportMenu.all')}
              hint={t('answerFeedback.exportMenu.allHint', { days })}
            />
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={hrefs.selection} download data-testid="feedback-export-selection">
            <Filter aria-hidden />
            <DropdownMenuItemText title={t('answerFeedback.exportMenu.selection')} hint={selectionSummary} />
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={hrefs.csv} download data-testid="feedback-export-csv">
            <FileText aria-hidden />
            <DropdownMenuItemText
              title={t('answerFeedback.exportMenu.csv')}
              hint={t('answerFeedback.exportMenu.csvHint', { days })}
            />
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

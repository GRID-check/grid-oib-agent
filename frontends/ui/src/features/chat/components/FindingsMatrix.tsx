/**
 * The Befundmatrix: one row per requirement the report read against the
 * project, over the prose and under the masthead.
 *
 * A planning office commissions a Prüfung, and the table every Gutachten
 * carries is this one: the requirement, the value, where it is written, and
 * whether it is met. The prose under it is the audit trail. The list is the
 * backend's (`message-findings.ts`); this renders it and nothing else.
 *
 * Colour never travels alone: every status carries its word, and the count
 * line above the table says the same in numbers. A row with a comment or a
 * reference opens on click; the `[N]` link jumps to the answer's own sources
 * row, the same anchor the prose markers use.
 */

import { useState, type FC } from 'react'
import { ChevronDown, CircleCheck, CircleHelp, CircleMinus, CircleX } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { Finding, Findings, FindingStatus } from '@/lib/conversations/message-findings'
import { findingCounts } from '@/lib/conversations/message-findings'
import { cn } from '@/lib/utils'

const STATUS_ICON: Record<FindingStatus, typeof CircleCheck> = {
  erfuellt: CircleCheck,
  nicht_erfuellt: CircleX,
  offen: CircleHelp,
  nicht_anwendbar: CircleMinus,
}

const STATUS_VARIANT: Record<FindingStatus, 'success' | 'destructive' | 'warning' | 'muted'> = {
  erfuellt: 'success',
  nicht_erfuellt: 'destructive',
  offen: 'warning',
  nicht_anwendbar: 'muted',
}

const referenceText = (
  finding: Finding,
  t: (key: string, values?: Record<string, string | number>) => string
) => {
  const reference = finding.reference
  if (!reference) return undefined
  const parts = [reference.document]
  if (reference.section) parts.push(reference.section)
  if (reference.page) parts.push(t('findings.page', { page: reference.page }))
  return parts.join(' · ')
}

const FindingRow: FC<{ finding: Finding; anchorPrefix?: string }> = ({ finding, anchorPrefix }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  const Icon = STATUS_ICON[finding.status]
  const reference = referenceText(finding, t)
  const expandable = Boolean(finding.comment)
  return (
    <>
      <tr
        className={cn(
          'border-border/60 border-t align-top',
          expandable && 'hover:bg-muted/40 cursor-pointer'
        )}
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        data-testid="finding-row"
        data-status={finding.status}
      >
        <td className="text-foreground py-2 pr-3 text-sm">
          <span className="flex items-start gap-1.5">
            {expandable && (
              <ChevronDown
                className={cn(
                  'text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform',
                  open && 'rotate-180'
                )}
                aria-hidden="true"
              />
            )}
            <span>
              {finding.requirement}
              {finding.area && (
                <span className="text-muted-foreground block text-xs">{finding.area}</span>
              )}
            </span>
          </span>
        </td>
        <td className="text-foreground py-2 pr-3 text-sm tabular-nums">{finding.value ?? '–'}</td>
        <td className="text-muted-foreground py-2 pr-3 text-xs">
          {reference ?? '–'}
          {anchorPrefix &&
            finding.citations.map((number) => (
              <a
                key={number}
                href={`#${anchorPrefix}${number}`}
                className="text-brand ml-1 underline decoration-dotted underline-offset-2"
                aria-label={t('answerSources.sourceNumber', { number })}
              >
                [{number}]
              </a>
            ))}
        </td>
        <td className="py-2 text-xs">
          <span className="flex flex-wrap items-center gap-1">
            <Chip size="sm" variant={STATUS_VARIANT[finding.status]}>
              <Icon aria-hidden />
              {t(`findings.status.${finding.status}`)}
            </Chip>
            {finding.grounding !== 'belegt' && (
              <Chip size="sm" variant="outline">
                {t(`findings.grounding.${finding.grounding}`)}
              </Chip>
            )}
          </span>
        </td>
      </tr>
      {open && finding.comment && (
        <tr className="bg-muted/30" data-testid="finding-detail">
          <td colSpan={4} className="text-muted-foreground px-3 py-2 text-sm">
            {finding.comment}
          </td>
        </tr>
      )}
    </>
  )
}

export const FindingsMatrix: FC<{ findings: Findings; anchorPrefix?: string }> = ({
  findings,
  anchorPrefix,
}) => {
  const t = useTranslations('chat')
  const counts = findingCounts(findings)
  const summary = (Object.keys(counts) as FindingStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${t(`findings.status.${status}`)}`)
    .join(' · ')
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="findings-matrix"
      aria-label={t('findings.label')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>{t('findings.label')}</SectionLabel>
        <span className="text-muted-foreground text-xs">{summary}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.requirement')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.value')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.reference')}</th>
              <th className="pb-1 font-medium">{t('findings.columns.status')}</th>
            </tr>
          </thead>
          <tbody>
            {findings.items.map((finding, index) => (
              <FindingRow
                key={`${index}-${finding.requirement}`}
                finding={finding}
                anchorPrefix={anchorPrefix}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

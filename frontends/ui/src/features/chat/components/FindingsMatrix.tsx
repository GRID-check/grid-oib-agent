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
import { findingCounts, hasFindingStatuses } from '@/lib/conversations/message-findings'
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

/** How a row stands against the previous report's row of the same requirement. */
export type FindingChange = 'new' | 'changed' | 'same'

export function changeOf(finding: Finding, previous: Findings | undefined): FindingChange {
  if (!previous) return 'same'
  const before = previous.items.find((item) => item.requirement === finding.requirement)
  if (!before) return 'new'
  return (before.status ?? '') !== (finding.status ?? '') || (before.value ?? '') !== (finding.value ?? '')
    ? 'changed'
    : 'same'
}

/** Requirements the previous report had and this one dropped. */
export function droppedFrom(previous: Findings | undefined, current: Findings): string[] {
  if (!previous) return []
  const now = new Set(current.items.map((item) => item.requirement))
  return previous.items
    .map((item) => item.requirement)
    .filter((requirement) => !now.has(requirement))
}

const OPEN_STATUSES: ReadonlySet<FindingStatus> = new Set(['offen', 'nicht_erfuellt'])

const FindingRow: FC<{
  finding: Finding
  anchorPrefix?: string
  change: FindingChange
  onCommission?: (finding: Finding) => Promise<boolean>
}> = ({ finding, anchorPrefix, change, onCommission }) => {
  const t = useTranslations('chat')
  const [open, setOpen] = useState(false)
  const Icon = finding.status ? STATUS_ICON[finding.status] : null
  const reference = referenceText(finding, t)
  const [commissioned, setCommissioned] = useState(false)
  const expandable = Boolean(finding.comment)
  const clearable =
    Boolean(onCommission) &&
    finding.status !== undefined &&
    OPEN_STATUSES.has(finding.status) &&
    !commissioned
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
              {change !== 'same' && (
                <Chip
                  size="sm"
                  variant="info"
                  className="ml-1.5 align-middle"
                  data-testid="finding-change"
                >
                  {t(`findings.change.${change}`)}
                </Chip>
              )}
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
            {finding.status && Icon && (
              <Chip size="sm" variant={STATUS_VARIANT[finding.status]}>
                <Icon aria-hidden />
                {t(`findings.status.${finding.status}`)}
              </Chip>
            )}
            {finding.grounding !== 'belegt' && (
              <Chip size="sm" variant="outline">
                {t(`findings.grounding.${finding.grounding}`)}
              </Chip>
            )}
            {clearable && (
              <button
                type="button"
                data-testid="finding-commission"
                onClick={(event) => {
                  event.stopPropagation()
                  void onCommission?.(finding).then((ok) => setCommissioned(ok))
                }}
                className="rounded-xs text-brand focus-visible:ring-ring/60 underline decoration-dotted underline-offset-2 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2"
              >
                {t('findings.clarify')}
              </button>
            )}
            {commissioned && (
              <Chip size="sm" variant="success" data-testid="finding-commissioned">
                {t('findings.commissioned')}
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

export const FindingsMatrix: FC<{
  findings: Findings
  anchorPrefix?: string
  /** The previous report's findings on the same subject, for the change marks. */
  previous?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommission?: (finding: Finding) => Promise<boolean>
}> = ({ findings, anchorPrefix, previous, onCommission }) => {
  const t = useTranslations('chat')
  const counts = findingCounts(findings)
  const dropped = droppedFrom(previous, findings)
  // Befunde when the report judged, Ergebnisse when it only stated: the same
  // table, the honest word for it, and no empty status column.
  const judged = hasFindingStatuses(findings)
  const label = judged ? t('findings.label') : t('findings.labelResults')
  const summary = (Object.keys(counts) as FindingStatus[])
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${t(`findings.status.${status}`)}`)
    .join(' · ')
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="findings-matrix"
      aria-label={label}
      data-judged={judged ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {judged && <span className="text-muted-foreground text-xs">{summary}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.requirement')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.value')}</th>
              <th className="pb-1 pr-3 font-medium">{t('findings.columns.reference')}</th>
              <th className="pb-1 font-medium">
                {judged ? t('findings.columns.status') : t('findings.columns.note')}
              </th>
            </tr>
          </thead>
          <tbody>
            {findings.items.map((finding, index) => (
              <FindingRow
                key={`${index}-${finding.requirement}`}
                finding={finding}
                anchorPrefix={anchorPrefix}
                change={changeOf(finding, previous)}
                onCommission={onCommission}
              />
            ))}
          </tbody>
        </table>
      </div>
      {dropped.length > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="findings-dropped">
          {t('findings.change.dropped', { count: dropped.length })} {dropped.join(' · ')}
        </p>
      )}
    </section>
  )
}

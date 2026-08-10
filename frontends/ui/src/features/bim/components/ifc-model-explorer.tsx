'use client'

/**
 * The model as DATA: overview, spatial structure, element table, properties.
 *
 * This is the half of the model page that does not need a GPU, and it is the
 * half that answers most questions. It renders identically whether the 3D
 * viewport is present, absent (no WebGPU) or still parsing, which is what makes
 * the browser support question a matter of degree rather than of the feature
 * working at all.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Boxes, CheckCircle2, Info, Layers3, Ruler, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatPropertyValue } from '../lib/format-value'
import type { BimModelSummary } from '@/lib/bim/types'
import type { BimHealth } from '@/lib/bim/validate'
import {
  flattenSpatialTree,
  formatElevation,
  shortIfcType,
  type BimViewerElement,
} from '../lib/model-index'
import type { BimElementDetail } from '../hooks/use-bim-model'

/**
 * Numbers follow the INTERFACE locale, not a hard-coded Austrian one.
 *
 * A German UI writes 74,2 m² and an English one 74.2 m²; pinning `de-AT` would
 * have put a German decimal comma in an English sentence, which reads as a
 * thousands separator and changes the number by a factor of ten.
 */
function formatMeasure(value: number | null, unit: string, locale: string): string {
  if (value === null) return '—'
  const rounded = Math.round(value * 100) / 100
  return `${rounded.toLocaleString(locale)} ${unit}`
}

interface StatProps {
  label: string
  value: string
  icon?: typeof Boxes
}

function Stat({ label, value, icon: Icon }: StatProps): JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5" aria-hidden="true" />}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export interface IfcModelOverviewProps {
  summary: BimModelSummary
  filename: string
}

export function IfcModelOverview({ summary, filename }: IfcModelOverviewProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  const areaUnit = summary.units.area?.symbol ?? 'm²'
  const volumeUnit = summary.units.volume?.symbol ?? 'm³'

  const facts: Array<[string, string]> = [
    [t('overview.project'), summary.projectName ?? '—'],
    [t('overview.site'), summary.siteName ?? '—'],
    [t('overview.building'), summary.buildingNames.join(', ') || '—'],
    [t('overview.schema'), summary.schema ?? '—'],
    [t('overview.exportedWith'), summary.header.originatingSystem ?? summary.header.preprocessorVersion ?? '—'],
    [t('overview.exportedAt'), summary.header.timeStamp ?? '—'],
    [t('overview.author'), summary.header.author.join(', ') || '—'],
    [t('overview.lengthUnit'), summary.units.length?.symbol ?? '—'],
  ]

  return (
    <section aria-labelledby="bim-overview-heading" className="space-y-3">
      <h2 id="bim-overview-heading" className="text-sm font-semibold">
        {t('overview.title')}
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label={t('overview.elements')} value={String(summary.totals.elements)} icon={Boxes} />
        <Stat label={t('overview.storeys')} value={String(summary.totals.storeys)} icon={Layers3} />
        <Stat label={t('overview.spaces')} value={String(summary.totals.spaces)} />
        <Stat
          label={t('overview.netFloorArea')}
          value={formatMeasure(summary.quantityTotals.netFloorAreaM2, areaUnit, locale)}
          icon={Ruler}
        />
        <Stat
          label={t('overview.grossFloorArea')}
          value={formatMeasure(summary.quantityTotals.grossFloorAreaM2, areaUnit, locale)}
        />
        <Stat
          label={t('overview.netVolume')}
          value={formatMeasure(summary.quantityTotals.netVolumeM3, volumeUnit, locale)}
        />
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b py-1 last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {summary.truncatedAt !== null && (
        <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          {t('overview.truncated', { limit: summary.truncatedAt })}
        </p>
      )}
      <p className="sr-only">{filename}</p>
    </section>
  )
}

export interface IfcModelHealthPanelProps {
  health: BimHealth
  /** Show only the findings an answer has to be qualified by. */
  compact?: boolean
  /** Called with the sample GlobalIds so the viewer can show which elements. */
  onShowElements?: (globalIds: string[]) => void
}

const SEVERITY_ICON = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
} as const

const SEVERITY_CLASS = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-muted-foreground',
} as const

/**
 * The validation report.
 *
 * Ordered by severity, not by stage: a reader wants "what is wrong with my
 * model" before "which conformance tier it failed", and the stage is a chip on
 * the row for anyone who does want it. Each finding states the SHARE affected
 * ("11 of 64 walls") rather than a bare count — the two read very differently
 * and only one of them tells you whether to care.
 */
export function IfcModelHealthPanel({
  health,
  compact = false,
  onShowElements,
}: IfcModelHealthPanelProps): JSX.Element {
  const t = useTranslations('bim')
  const order = { error: 0, warning: 1, info: 2 } as const
  const issues = [...health.issues]
    .filter((issue) => !compact || issue.severity !== 'info')
    .sort((a, b) => order[a.severity] - order[b.severity])

  return (
    <section aria-labelledby="bim-health-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="bim-health-heading" className="text-sm font-semibold">
          {t('health.title')}
        </h2>
        <Badge variant={health.totals.error > 0 ? 'destructive' : health.score >= 90 ? 'success' : 'warning'}>
          {t('health.score', { score: health.score })}
        </Badge>
      </div>
      {issues.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
          {t('health.clean')}
        </p>
      ) : (
        <ul className="space-y-1">
          {issues.map((issue) => {
            const Icon = SEVERITY_ICON[issue.severity]
            const affected =
              issue.total === null
                ? t('health.affectedAbsolute', { count: issue.count })
                : t('health.affected', { count: issue.count, total: issue.total })
            return (
              <li
                key={`${issue.rule}-${issue.detail ?? ''}`}
                className="flex items-start gap-2 rounded-md border p-2 text-sm"
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', SEVERITY_CLASS[issue.severity])}
                  aria-label={t(`health.severity.${issue.severity}`)}
                />
                <div className="min-w-0 flex-1">
                  <p>{t(`health.rule.${issue.rule}`)}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`health.stage.${issue.stage}`)}
                    {issue.detail ? ` · ${issue.detail}` : ''} · {affected}
                  </p>
                </div>
                {onShowElements && issue.sampleGlobalIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onShowElements(issue.sampleGlobalIds)}
                    className="shrink-0 rounded-md px-2 py-0.5 text-xs underline-offset-2 hover:underline"
                  >
                    {t('viewer.isolate')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export interface IfcSpatialTreeProps {
  summary: BimModelSummary
  selectedStorey: string | null
  onSelectStorey: (storey: string | null) => void
}

export function IfcSpatialTree({
  summary,
  selectedStorey,
  onSelectStorey,
}: IfcSpatialTreeProps): JSX.Element {
  const t = useTranslations('bim')
  const rows = useMemo(() => flattenSpatialTree(summary.spatial), [summary.spatial])

  const handleTreeKeys = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'Home' ? 0 : event.key === 'End' ? 0 : null
    if (step === null) return
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    ]
    if (buttons.length === 0) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : // From nowhere, Down enters at the top and Up at the bottom.
            current === -1
            ? step > 0
              ? 0
              : buttons.length - 1
            : Math.min(buttons.length - 1, Math.max(0, current + step))
    event.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <section aria-labelledby="bim-tree-heading" className="space-y-2">
      <h2 id="bim-tree-heading" className="text-sm font-semibold">
        {t('tree.title')}
      </h2>
      {/*
        The rows are already flat, so arrow-key movement is a focus walk over
        the buttons rather than a tree-walk: Up/Down step, Home/End jump. A
        tree that can only be Tabbed through makes a reader press Tab once per
        storey to reach the Keller.
      */}
      <ul className="space-y-0.5 text-sm" onKeyDown={handleTreeKeys}>
        <li>
          <button
            type="button"
            onClick={() => onSelectStorey(null)}
            aria-pressed={selectedStorey === null}
            className={cn(
              'w-full rounded-md px-2 py-1 text-left hover:bg-muted',
              selectedStorey === null && 'bg-muted font-medium'
            )}
          >
            {t('tree.allStoreys')}
          </button>
        </li>
        {rows.map((row) => {
          const selectable = row.storeyName !== null
          const active = selectable && row.storeyName === selectedStorey
          return (
            <li key={row.key} style={{ paddingLeft: `${row.depth * 12}px` }}>
              <button
                type="button"
                disabled={!selectable}
                aria-pressed={selectable ? active : undefined}
                onClick={() => selectable && onSelectStorey(row.storeyName)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left',
                  selectable ? 'hover:bg-muted' : 'cursor-default text-muted-foreground',
                  active && 'bg-muted font-medium'
                )}
              >
                <span className="truncate">
                  {row.label}
                  {row.elevation !== null && (
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {formatElevation({ elevation: row.elevation })}
                    </span>
                  )}
                </span>
                {row.elementCount > 0 && (
                  <Badge variant="secondary" className="tabular-nums">
                    {row.elementCount}
                  </Badge>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export interface IfcElementTableProps {
  elements: readonly BimViewerElement[]
  storeyFilter: string | null
  selectedGlobalId: string | null
  onSelect: (element: BimViewerElement) => void
}

export function IfcElementTable({
  elements,
  storeyFilter,
  selectedGlobalId,
  onSelect,
}: IfcElementTableProps): JSX.Element {
  const t = useTranslations('bim')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('')

  const types = useMemo(
    () => [...new Set(elements.map((element) => element.ifcType))].sort(),
    [elements]
  )

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return elements.filter((element) => {
      if (storeyFilter && (element.storeyName ?? '') !== storeyFilter) return false
      if (typeFilter && element.ifcType !== typeFilter) return false
      if (!needle) return true
      return (
        (element.name ?? '').toLowerCase().includes(needle) ||
        (element.tag ?? '').toLowerCase().includes(needle) ||
        element.globalId.toLowerCase() === needle
      )
    })
  }, [elements, search, storeyFilter, typeFilter])

  // Bounded render: a 200 000-element model must not put 200 000 rows in the
  // DOM. The count line always states the full total, so the cap is visible.
  const shown = filtered.slice(0, 300)

  return (
    <section aria-labelledby="bim-elements-heading" className="flex min-h-0 flex-col gap-2">
      <h2 id="bim-elements-heading" className="text-sm font-semibold">
        {t('elements.title')}
      </h2>
      <div className="flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('elements.search')}
          aria-label={t('elements.search')}
          className="h-8 max-w-56"
        />
        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          aria-label={t('elements.columns.type')}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{t('elements.allTypes')}</option>
          {types.map((type) => (
            <option key={type} value={type}>
              {shortIfcType(type)}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {t('elements.count', { shown: shown.length, total: filtered.length })}
      </p>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur">
            <tr className="text-left">
              <th scope="col" className="px-2 py-1 font-medium">
                {t('elements.columns.type')}
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                {t('elements.columns.name')}
              </th>
              <th scope="col" className="px-2 py-1 font-medium">
                {t('elements.columns.storey')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-6 text-center text-muted-foreground">
                  {t('elements.empty')}
                </td>
              </tr>
            )}
            {shown.map((element) => (
              <tr
                key={element.globalId}
                aria-selected={element.globalId === selectedGlobalId}
                className={cn(
                  'cursor-pointer border-t hover:bg-muted/60',
                  element.globalId === selectedGlobalId && 'bg-muted'
                )}
                onClick={() => onSelect(element)}
              >
                <td className="px-2 py-1 text-muted-foreground">{shortIfcType(element.ifcType)}</td>
                <td className="px-2 py-1">
                  {/*
                    A real button, not a click handler on the row. The row's
                    own `onClick` keeps the whole row clickable for a mouse,
                    but a `<tr onClick>` is reachable by nothing else: no Tab
                    stop, no Enter, and nothing announced to a screen reader —
                    the element list was mouse-only, and it is the primary way
                    into every other surface on this page.
                  */}
                  <button
                    type="button"
                    onClick={() => onSelect(element)}
                    className="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {element.name ?? t('elements.unnamed')}
                  </button>
                </td>
                <td className="px-2 py-1 text-muted-foreground">{element.storeyName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export interface IfcPropertyPanelProps {
  element: BimElementDetail | null
  isLoading: boolean
  error: string | null
}

export function IfcPropertyPanel({ element, isLoading, error }: IfcPropertyPanelProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()

  if (error) {
    return <p className="text-sm text-destructive">{t('properties.loadFailed')}</p>
  }
  if (!element) {
    return (
      <p className="text-sm text-muted-foreground">
        {isLoading ? '…' : t('properties.none')}
      </p>
    )
  }

  const identity: Array<[string, string]> = [
    [t('properties.ifcType'), element.ifcType],
    [t('properties.globalId'), element.globalId],
    [t('properties.predefinedType'), element.predefinedType ?? '—'],
    [t('properties.typeName'), element.typeName ?? '—'],
    [t('properties.tag'), element.tag ?? '—'],
    [t('properties.storey'), element.storeyName ?? '—'],
  ]

  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
          {t('properties.identity')}
        </h3>
        <dl className="space-y-0.5">
          {identity.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate text-right font-medium" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {element.materials.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            {t('properties.materials')}
          </h3>
          <ol className="list-inside list-decimal space-y-0.5">
            {element.materials.map((material) => (
              <li key={material}>{material}</li>
            ))}
          </ol>
        </div>
      )}

      {element.classifications.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            {t('properties.classifications')}
          </h3>
          <ul className="space-y-0.5">
            {element.classifications.map((classification) => (
              <li key={`${classification.system}-${classification.identification}`}>
                <span className="font-medium">{classification.identification ?? '—'}</span>{' '}
                {classification.name ?? ''}{' '}
                <span className="text-muted-foreground">{classification.system ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {Object.entries(element.properties).map(([setName, properties]) => (
        <div key={setName}>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{setName}</h3>
          <dl className="space-y-0.5">
            {Object.entries(properties).map(([name, value]) => (
              <div key={name} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="text-right font-medium">{formatPropertyValue(value, locale)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}

      {Object.entries(element.quantities).map(([setName, quantities]) => (
        <div key={setName}>
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{setName}</h3>
          <dl className="space-y-0.5">
            {Object.entries(quantities).map(([name, value]) => (
              <div key={name} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="text-right font-medium tabular-nums">
                  {(Math.round(value * 1000) / 1000).toLocaleString(locale)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  )
}

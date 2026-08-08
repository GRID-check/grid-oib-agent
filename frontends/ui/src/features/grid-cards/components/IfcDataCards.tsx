'use client'

/**
 * The three model-backed cards: room schedule, one element, revision diff.
 *
 * They share one property that is the whole design: **the card carries an
 * identifier and nothing else.** A file name, a GlobalId, a pair of revisions —
 * and the component fetches the numbers from the model. The agent therefore
 * cannot state a floor area, get a fire rating wrong, or invent a delta,
 * because it never supplies one; the worst it can do is point at the wrong
 * table, which is visible immediately.
 *
 * Every row that names an element links into the model page at that element
 * (`buildModelHref`), so a card is a way *into* the building rather than a
 * screenshot of it.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Boxes, Download, GitCompare, Table2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import type { BimComparison } from '@/lib/bim/compare'
import type { BimRoomSchedule } from '@/lib/bim/schedule'
import { buildModelHref } from '@/features/bim/lib/model-link'
import { shortIfcType } from '@/features/bim/lib/model-index'
import {
  pickDefaultModel,
  useProjectBimModels,
  type BimElementDetail,
  type BimModelHeaderView,
} from '@/features/bim/hooks/use-bim-model'

/** Resolve a model by file name, the way the agent addresses one. */
function useResolvedModel(
  projectId: string | null,
  modelFile: string | null
): { model: BimModelHeaderView | null; models: BimModelHeaderView[]; isLoading: boolean } {
  const { data, isLoading } = useProjectBimModels(projectId)
  const models = useMemo(
    () => (data ?? []).filter((candidate) => candidate.status === 'ready'),
    [data]
  )
  const model = useMemo(() => {
    if (models.length === 0) return null
    if (!modelFile) return pickDefaultModel(models)
    const needle = modelFile.toLowerCase()
    return (
      models.find((candidate) => candidate.filename.toLowerCase() === needle) ??
      models.find((candidate) => candidate.filename.toLowerCase().includes(needle)) ??
      null
    )
  }, [models, modelFile])
  return { model, models, isLoading }
}

/** POST one query to a model and keep the typed slice the caller asked for. */
function useModelQuery<T>(
  modelId: string | null,
  body: Record<string, unknown> | null,
  pick: (payload: Record<string, unknown>) => T | undefined
): { data: T | null; isLoading: boolean; error: boolean } {
  const [state, setState] = useState<{ data: T | null; isLoading: boolean; error: boolean }>({
    data: null,
    isLoading: false,
    error: false,
  })
  // The body is an object literal at every call site, so it is a new reference
  // on every render; keying the effect on its serialization is what stops the
  // fetch from looping.
  const key = body ? JSON.stringify(body) : null

  useEffect(() => {
    if (!modelId || !key) {
      setState({ data: null, isLoading: false, error: false })
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: false })
    fetch(`/api/bim/models/${modelId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: key,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return (await response.json()) as Record<string, unknown>
      })
      .then((payload) => {
        if (!cancelled) setState({ data: pick(payload) ?? null, isLoading: false, error: false })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: true })
      })
    return () => {
      cancelled = true
    }
    // `pick` is a stable module-level selector at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, key])

  return state
}

function CardShell({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string
  icon: typeof Boxes
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl border bg-card p-4" aria-label={title}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function NoModel(): JSX.Element {
  const t = useTranslations('bim')
  return (
    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {t('card.noModel')}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Raumbuch
// ---------------------------------------------------------------------------

const pickSchedule = (payload: Record<string, unknown>) =>
  payload.schedule as BimRoomSchedule | undefined

export interface IfcScheduleCardProps {
  title: string
  modelFile: string | null
  storey: string | null
  note: string | null
  projectId: string | null
}

export function IfcScheduleCard({
  title,
  modelFile,
  storey,
  note,
  projectId,
}: IfcScheduleCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  const { model } = useResolvedModel(projectId, modelFile)
  const { data: schedule, isLoading, error } = useModelQuery(
    model?.id ?? null,
    { op: 'schedule' },
    pickSchedule
  )

  const storeys = useMemo(() => {
    if (!schedule) return []
    if (!storey) return schedule.storeys
    const needle = storey.toLowerCase()
    return schedule.storeys.filter((entry) => entry.storeyName.toLowerCase() === needle)
  }, [schedule, storey])

  const number = (value: number | null) =>
    value === null ? '—' : value.toLocaleString(locale, { maximumFractionDigits: 2 })

  const download = () => {
    if (!schedule) return
    // Built in the browser from the data already on screen: the export is
    // exactly the table the user is looking at, with no second round trip that
    // could disagree with it.
    const rows = storeys.flatMap((entry) =>
      entry.rooms.map((room) =>
        [entry.storeyName, room.name, room.netFloorArea ?? '', room.grossFloorArea ?? '', room.netVolume ?? '', room.globalId]
          .map((cell) => (/[";\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : cell))
          .join(';')
      )
    )
    const csv = [
      ['Geschoss', 'Raum', `NGF (${schedule.units.area})`, `BGF (${schedule.units.area})`, `Rauminhalt (${schedule.units.volume})`, 'GlobalId'].join(';'),
      ...rows,
    ].join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `raumbuch-${model?.filename ?? 'modell'}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <CardShell
      title={title}
      icon={Table2}
      action={
        schedule && (
          <Button type="button" size="sm" variant="ghost" onClick={download}>
            <Download className="size-3.5" aria-hidden="true" />
            CSV
          </Button>
        )
      }
    >
      {!model ? (
        <NoModel />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error || !schedule ? (
        <p className="text-sm text-destructive">{t('schedule.failed')}</p>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    {t('schedule.room')}
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    {t('schedule.netArea')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t('schedule.volume')}
                  </th>
                </tr>
              </thead>
              {storeys.map((entry) => (
                <tbody key={entry.storeyName}>
                  <tr className="border-t">
                    <th scope="rowgroup" colSpan={3} className="pt-2 text-left text-xs font-semibold">
                      {entry.storeyName}
                    </th>
                  </tr>
                  {entry.rooms.map((room) => (
                    <tr key={room.globalId} className="border-t/50">
                      <td className="py-1 pr-2">
                        {projectId ? (
                          <Link
                            href={buildModelHref(projectId, {
                              model: model.filename,
                              storey: entry.storeyName,
                              element: room.globalId,
                            })}
                            className="underline-offset-2 hover:underline"
                          >
                            {room.name}
                          </Link>
                        ) : (
                          room.name
                        )}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{number(room.netFloorArea)}</td>
                      <td className="py-1 text-right tabular-nums">{number(room.netVolume)}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-medium">
                    <td className="py-1 pr-2">{t('schedule.storeyTotal')}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{number(entry.netFloorArea)}</td>
                    <td className="py-1 text-right tabular-nums">{number(entry.netVolume)}</td>
                  </tr>
                </tbody>
              ))}
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-1 pr-2">{t('schedule.total')}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {number(schedule.totals.netFloorArea)} {schedule.units.area}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {number(schedule.totals.netVolume)} {schedule.units.volume}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          {schedule.totals.roomsWithoutArea > 0 && (
            // Stated beside the total, not in a tooltip: a Flächenaufstellung
            // that silently omits four rooms is the failure this whole
            // subsystem exists to prevent.
            <p className="text-xs text-warning">
              {t('schedule.missing', { count: schedule.totals.roomsWithoutArea })}
            </p>
          )}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// One element
// ---------------------------------------------------------------------------

const pickElement = (payload: Record<string, unknown>) =>
  payload.element as BimElementDetail | null | undefined

export interface IfcElementCardProps {
  title: string
  globalId: string
  modelFile: string | null
  note: string | null
  projectId: string | null
}

export function IfcElementCard({
  title,
  globalId,
  modelFile,
  note,
  projectId,
}: IfcElementCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { model } = useResolvedModel(projectId, modelFile)
  const { data: element, isLoading, error } = useModelQuery(
    model?.id ?? null,
    { op: 'element', globalId },
    pickElement
  )

  return (
    <CardShell
      title={title}
      icon={Boxes}
      action={
        model && projectId ? (
          <Button asChild size="sm" variant="ghost">
            <Link
              href={buildModelHref(projectId, {
                model: model.filename,
                element: globalId,
                storey: element?.storeyName ?? undefined,
                highlights: [{ status: 'info', globalIds: [globalId] }],
              })}
            >
              {t('card.openModel')}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        ) : null
      }
    >
      {!model ? (
        <NoModel />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error ? (
        <p className="text-sm text-destructive">{t('properties.loadFailed')}</p>
      ) : !element ? (
        <p className="text-sm text-muted-foreground">{t('element.notFound')}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{shortIfcType(element.ifcType)}</Badge>
            {element.storeyName && <Badge variant="outline">{element.storeyName}</Badge>}
            {element.typeName && <span className="text-muted-foreground">{element.typeName}</span>}
          </div>
          {element.materials.length > 0 && (
            <p className="text-muted-foreground">{element.materials.join(' · ')}</p>
          )}
          {Object.entries(element.properties).map(([setName, properties]) => (
            <dl key={setName} className="space-y-0.5">
              <dt className="text-xs font-semibold uppercase text-muted-foreground">{setName}</dt>
              {Object.entries(properties).map(([name, value]) => (
                <div key={name} className="flex justify-between gap-3">
                  <dd className="text-muted-foreground">{name}</dd>
                  <dd className="font-medium">
                    {value === null ? '—' : typeof value === 'boolean' ? (value ? 'Ja' : 'Nein') : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ))}
          {note && <p className="text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------

const pickComparison = (payload: Record<string, unknown>) =>
  payload.comparison as BimComparison | undefined

export interface IfcDiffCardProps {
  title: string
  baseModelFile: string
  modelFile: string | null
  note: string | null
  projectId: string | null
}

export function IfcDiffCard({
  title,
  baseModelFile,
  modelFile,
  note,
  projectId,
}: IfcDiffCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { model, models } = useResolvedModel(projectId, modelFile)
  const baseModel = useMemo(() => {
    const needle = baseModelFile.toLowerCase()
    return (
      models.find((candidate) => candidate.filename.toLowerCase() === needle) ??
      models.find((candidate) => candidate.filename.toLowerCase().includes(needle)) ??
      null
    )
  }, [models, baseModelFile])

  const { data: comparison, isLoading, error } = useModelQuery(
    model && baseModel && model.id !== baseModel.id ? model.id : null,
    baseModel ? { op: 'compare', baseModelId: baseModel.id, limit: 20_000 } : null,
    pickComparison
  )

  return (
    <CardShell title={title} icon={GitCompare}>
      {!model || !baseModel ? (
        <NoModel />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error || !comparison ? (
        <p className="text-sm text-destructive">{t('compare.failed')}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {baseModel.filename} <ArrowRight className="inline size-3" aria-hidden="true" />{' '}
            {model.filename}
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="success">
              {t('compare.added')} {comparison.added.length}
            </Badge>
            <Badge variant="destructive">
              {t('compare.removed')} {comparison.removed.length}
            </Badge>
            <Badge variant="warning">
              {t('compare.changed')} {comparison.changed.length}
            </Badge>
            <Badge variant="secondary">
              {t('compare.unchanged')} {comparison.unchangedCount}
            </Badge>
          </div>
          {comparison.truncated && <p className="text-xs text-warning">{t('compare.truncated')}</p>}
          <ul className="space-y-1">
            {comparison.changed.slice(0, 6).map((entry) => (
              <li key={entry.globalId}>
                <p>
                  {projectId ? (
                    <Link
                      href={buildModelHref(projectId, {
                        model: model.filename,
                        element: entry.globalId,
                        highlights: [{ status: 'warning', globalIds: [entry.globalId] }],
                      })}
                      className="underline-offset-2 hover:underline"
                    >
                      {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                    </Link>
                  ) : (
                    `${shortIfcType(entry.ifcType)} · ${entry.name ?? entry.globalId}`
                  )}
                </p>
                <ul className="ml-3 text-xs text-muted-foreground">
                  {entry.changes.slice(0, 3).map((change) => (
                    <li key={change.field}>
                      {change.field}: {String(change.before ?? '—')} → {String(change.after ?? '—')}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {note && <p className="text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}

'use client'

/**
 * The two tables an architect already keeps by hand, and the facts a model can
 * fill into the project brief.
 *
 * Everything else on the model page answers "what is in this file". These three
 * answer "what do I do with it": a Raumbuch goes into the Einreichung, a
 * Massenermittlung into the Kostenschätzung, and the derived facts into the
 * brief every later compliance answer is computed from.
 *
 * All three follow one rule: **a number that is missing is shown as missing.**
 * The room count next to a floor-area total is not decoration — it is the
 * difference between a total you can submit and one that quietly excludes four
 * rooms whose area the model never published. Every total here states how many
 * rows it could not see.
 */

import { useMemo, useState } from 'react'
import { AlertTriangle, Download, Ruler, Sparkles, Table2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import type { BimProfileSuggestion } from '@/lib/bim/profile'
import {
  BIM_TAKEOFF_QUANTITIES,
  roomScheduleToCsv,
  type BimQuantityRow,
  type BimRoomSchedule,
} from '@/lib/bim/schedule'

/** Rows shown before the panel folds; a 400-room model must not own the page. */
const VISIBLE_ROOMS = 60

/** Take-off groups shown before the table folds. */
const VISIBLE_TAKEOFF_ROWS = 40

function useNumberFormat(): (value: number | null, digits?: number) => string {
  const { locale } = useLocale()
  return useMemo(() => {
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 })
    const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    return (value, digits = 2) => (value === null ? '—' : (digits === 0 ? integer : format).format(value))
  }, [locale])
}

// ---------------------------------------------------------------------------
// Raumbuch
// ---------------------------------------------------------------------------

export interface IfcRoomScheduleProps {
  /**
   * The query read only part of the building.
   *
   * Load-bearing on this surface: the `Gesamt` row is a building total, and
   * over a capped room list it is a partial sum labelled as a complete one —
   * a Flächenaufstellung that can go into an Einreichung. The file's own
   * header says "every total here states how many rows it could not see"; it
   * stated `roomsWithoutArea` and not this.
   */
  truncated?: boolean
  schedule: BimRoomSchedule | null
  isLoading: boolean
  error: string | null
  filename: string
  /** Selecting a row selects the room everywhere else on the page. */
  onSelect?: (globalId: string) => void
  selectedGlobalId?: string | null
}

export function IfcRoomSchedule({
  truncated = false,
  schedule,
  isLoading,
  error,
  filename,
  onSelect,
  selectedGlobalId,
}: IfcRoomScheduleProps): JSX.Element {
  const t = useTranslations('bim')
  const format = useNumberFormat()
  const [expanded, setExpanded] = useState(false)

  const download = (): void => {
    if (!schedule) return
    // Built in the browser from the rows on screen, so the file and the table
    // cannot disagree — and a BOM, because Excel reads a UTF-8 CSV without one
    // as Latin-1 and turns every "Grundfläche" into "GrundflÃ¤che".
    const blob = new Blob([`﻿${roomScheduleToCsv(schedule)}`], {
      type: 'text/csv;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${filename.replace(/\.(ifc|ifczip)$/i, '')}-raumbuch.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const totalRooms = schedule?.totals.rooms ?? 0
  let rendered = 0

  return (
    <section aria-labelledby="bim-schedule-heading" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="bim-schedule-heading" className="flex items-center gap-2 text-sm font-semibold">
          <Table2 className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('schedule.title')}
        </h2>
        {schedule && schedule.totals.rooms > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={download}>
            <Download className="size-3.5" aria-hidden="true" />
            {t('schedule.download')}
          </Button>
        )}
      </div>

      {isLoading && <Spinner className="size-4" />}
      {error && <p className="text-sm text-destructive">{t('schedule.failed')}</p>}

      {schedule && schedule.totals.rooms === 0 && (
        <p className="text-sm text-muted-foreground">{t('schedule.empty')}</p>
      )}

      {schedule && schedule.totals.rooms > 0 && (
        <>
          {/* Above the rows on purpose: it invalidates the `Gesamt` below. */}
          {truncated && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('schedule.truncated')}
            </p>
          )}
          {schedule.totals.roomsWithoutArea > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('schedule.missing', { count: schedule.totals.roomsWithoutArea })}
            </p>
          )}

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('schedule.room')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {t('schedule.netArea')} ({schedule.units.area})
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {t('schedule.volume')} ({schedule.units.volume})
                  </th>
                </tr>
              </thead>
              {schedule.storeys.map((storey) => {
                /**
                 * A storey is never dropped, only its rooms are.
                 *
                 * The budget used to cut the map itself: once 60 rooms had
                 * been rendered every later storey returned `null` — heading,
                 * rooms AND `Summe Geschoß` all gone — while the `Gesamt` row
                 * below still counted them. A reader adding the visible
                 * subtotals got a number that did not reach the total, with
                 * nothing on screen naming the missing floors, and an expand
                 * button that reads as "more rows in the storeys I can see".
                 */
                const visible = expanded
                  ? storey.rooms
                  : storey.rooms.slice(0, Math.max(0, VISIBLE_ROOMS - rendered))
                rendered += visible.length
                const elided = storey.rooms.length - visible.length
                return (
                  <tbody key={storey.storeyName} className="border-t">
                    <tr className="bg-muted/30">
                      {/*
                        `rowgroup`, not `colgroup`. A colgroup header claims to
                        head the rest of a COLUMN, so the rooms beneath were
                        never associated with their storey — reading the
                        Raumbuch cell by cell gave no way to tell which floor a
                        room is on, which is the first thing the table sorts by.
                      */}
                      <th
                        scope="rowgroup"
                        colSpan={3}
                        className="px-2 py-1 text-left text-xs font-semibold"
                      >
                        {storey.storeyName}
                        {storey.roomsWithoutArea > 0 && (
                          <span className="ml-2 font-normal text-warning">
                            {t('schedule.storeyMissing', { count: storey.roomsWithoutArea })}
                          </span>
                        )}
                      </th>
                    </tr>
                    {visible.map((room) => (
                      <tr
                        key={room.globalId}
                        onClick={onSelect ? () => onSelect(room.globalId) : undefined}
                        className={`border-t ${
                          onSelect ? 'cursor-pointer hover:bg-muted/50' : ''
                        } ${room.globalId === selectedGlobalId ? 'bg-muted' : ''}`}
                      >
                        <td className="px-2 py-1">
                          {/*
                            A real button, the way the element table does it.
                            A `<tr onClick>` is reachable by nothing else — no
                            Tab stop, no Enter, nothing announced — so the
                            Raumbuch was the one table on this page a keyboard
                            could not select from.

                            `aria-current` rather than `aria-selected` on the
                            row: a `role="row"` inside a `role="table"` does
                            not support `aria-selected`, so the selected room
                            was conveyed by a background colour and nothing
                            else.
                          */}
                          {onSelect ? (
                            <button
                              type="button"
                              onClick={(event) => {
                                // The row's handler would fire again otherwise
                                // — harmless today, and a re-selection loop the
                                // first time the row handler does more.
                                event.stopPropagation()
                                onSelect(room.globalId)
                              }}
                              aria-current={room.globalId === selectedGlobalId}
                              className="rounded-sm text-left focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                            >
                              {room.name}
                            </button>
                          ) : (
                            room.name
                          )}
                          {room.category && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {room.category}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {format(room.netFloorArea)}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {format(room.netVolume)}
                        </td>
                      </tr>
                    ))}
                    {elided > 0 && (
                      <tr className="border-t">
                        <td colSpan={3} className="text-muted-foreground px-2 py-1 text-xs italic">
                          {elided === 1
                            ? t('schedule.storeyElidedOne')
                            : t('schedule.storeyElided', { count: elided })}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t bg-muted/20 text-xs font-medium">
                      <td className="px-2 py-1">{t('schedule.storeyTotal')}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {format(storey.netFloorArea)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {format(storey.netVolume)}
                      </td>
                    </tr>
                  </tbody>
                )
              })}
              <tfoot className="border-t-2">
                <tr className="text-sm font-semibold">
                  <td className="px-2 py-1.5">{t('schedule.total')}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {format(schedule.totals.netFloorArea)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {format(schedule.totals.netVolume)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {totalRooms > VISIBLE_ROOMS && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded
                ? t('schedule.collapse')
                : totalRooms - VISIBLE_ROOMS === 1
                  ? t('schedule.expandOne')
                  : t('schedule.expand', { count: totalRooms - VISIBLE_ROOMS })}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Massenermittlung
// ---------------------------------------------------------------------------

export interface IfcQuantityTakeoffProps {
  /** The query read only part of the building — see the Raumbuch's note. */
  truncated?: boolean
  rows: BimQuantityRow[] | null
  isLoading: boolean
  error: string | null
  quantity: string
  onQuantityChange: (quantity: string) => void
  byMaterial: boolean
  onByMaterialChange: (byMaterial: boolean) => void
}

export function IfcQuantityTakeoff({
  truncated = false,
  rows,
  isLoading,
  error,
  quantity,
  onQuantityChange,
  byMaterial,
  onByMaterialChange,
}: IfcQuantityTakeoffProps): JSX.Element {
  const t = useTranslations('bim')
  const format = useNumberFormat()
  const incomplete = (rows ?? []).reduce((sum, row) => sum + row.missing, 0)
  const [expandedRows, setExpandedRows] = useState(false)
  /**
   * The only table on this surface that had no cap.
   *
   * Grouped by type it is fifty rows; with "nach Material trennen" the group
   * key is `type · material`, which on real material strings runs to thousands
   * of distinct groups — every one of them rendered, in a 26 rem drawer.
   * Everything else here caps (300, 60, 25, 8) and says what it left out.
   */
  const visibleRows = expandedRows ? (rows ?? []) : (rows ?? []).slice(0, VISIBLE_TAKEOFF_ROWS)

  return (
    <section aria-labelledby="bim-takeoff-heading" className="space-y-2">
      <h2 id="bim-takeoff-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Ruler className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('takeoff.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('takeoff.description')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-muted-foreground" htmlFor="bim-takeoff-quantity">
          {t('takeoff.quantity')}
        </label>
        <select
          id="bim-takeoff-quantity"
          value={quantity}
          onChange={(event) => onQuantityChange(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm"
        >
          {BIM_TAKEOFF_QUANTITIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={byMaterial}
            onChange={(event) => onByMaterialChange(event.target.checked)}
            className="size-3.5"
          />
          {t('takeoff.byMaterial')}
        </label>
      </div>

      {isLoading && <Spinner className="size-4" />}
      {error && <p className="text-sm text-destructive">{t('takeoff.failed')}</p>}

      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('takeoff.empty')}</p>
      )}

      {rows && rows.length > 0 && (
        <>
          {truncated && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('takeoff.truncated')}
            </p>
          )}
          {incomplete > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t('takeoff.missing', { count: incomplete })}
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">
                    {t('takeoff.group')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {t('takeoff.elements')}
                  </th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    {quantity}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={row.group} className="border-t">
                    <td className="px-2 py-1">{row.group}</td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {format(row.elements, 0)}
                      {row.missing > 0 && (
                        <span className="ml-1 text-xs text-warning">
                          {t('takeoff.rowMissing', { count: row.missing })}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{format(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/*
            A toggle, like the Raumbuch's above it. It used to only expand,
            which deleted the button the reader had just pressed: focus fell
            out of the table, nothing announced that a few hundred rows had
            appeared, and there was no way back to the short list.
          */}
          {(rows?.length ?? 0) > VISIBLE_TAKEOFF_ROWS && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpandedRows(!expandedRows)}
              className="w-full"
            >
              {expandedRows
                ? t('takeoff.collapse')
                : (rows?.length ?? 0) - visibleRows.length === 1
                  ? t('takeoff.showAllOne')
                  : t('takeoff.showAll', { count: (rows?.length ?? 0) - visibleRows.length })}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Derived project facts
// ---------------------------------------------------------------------------

export interface IfcProfileSuggestionsProps {
  suggestions: BimProfileSuggestion[] | null
  isLoading: boolean
  error: string | null
  /** Opens the chat with a question that asks the agent to apply these. */
  askHref: string
}

const CONFIDENCE_VARIANT: Record<BimProfileSuggestion['confidence'], 'success' | 'warning' | 'secondary'> =
  {
    high: 'success',
    medium: 'warning',
    low: 'secondary',
  }

export function IfcProfileSuggestions({
  suggestions,
  isLoading,
  error,
  askHref,
}: IfcProfileSuggestionsProps): JSX.Element {
  const t = useTranslations('bim')

  return (
    <section aria-labelledby="bim-profile-heading" className="space-y-2">
      <h2 id="bim-profile-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('profile.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('profile.description')}</p>

      {isLoading && <Spinner className="size-4" />}
      {error && <p className="text-sm text-destructive">{t('profile.failed')}</p>}

      {suggestions && suggestions.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('profile.empty')}</p>
      )}

      {suggestions && suggestions.length > 0 && (
        <>
          <ul className="space-y-1.5">
            {suggestions.map((suggestion) => (
              <li key={suggestion.key} className="rounded-lg border p-2">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{t(`profile.key.${suggestion.key}`)}</span>
                  <span className="tabular-nums">{String(suggestion.value)}</span>
                  <Badge variant={CONFIDENCE_VARIANT[suggestion.confidence]}>
                    {t(`profile.confidence.${suggestion.confidence}`)}
                  </Badge>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{suggestion.evidence}</p>
              </li>
            ))}
          </ul>
          {/*
            No Apply button here on purpose. These are inferences from an export
            that may be a working file, and `geschosse_oberirdisch` picks a
            Gebäudeklasse — so they go through the same confirm-the-patch card
            every other agent-proposed brief change uses (ADR-0030), rather than
            being written by a button that looks like a checkbox.
          */}
          <Button asChild size="sm" variant="secondary">
            <a href={askHref}>{t('profile.ask')}</a>
          </Button>
        </>
      )}
    </section>
  )
}

'use client'

/**
 * The scope bar of Platform → Answer quality: which days, which organizations,
 * which projects. Every view on the page (ratings, citation checks, runtime) is
 * read in this one scope, so "these two offices, last quarter" means the same
 * rows on every tab and in every export.
 *
 * - **Range.** The presets (7 / 30 / 90 days, ending today) are one tap; any
 *   other range is "Benutzerdefiniert", two dates in a popover, checked against
 *   the same bounds the API enforces (`QUALITY_MAX_RANGE_DAYS`).
 * - **Organizations.** Those with any quality activity in the range — a vote, a
 *   citation check or a profiled turn — from `/api/platform/quality/scope-options`.
 *   Not the ratings' list, because the bar is not the ratings tab's.
 * - **Projects.** Of the chosen organizations only; until one is chosen the
 *   picker says so instead of listing every project of every tenant. Removing
 *   an organization drops its projects from the selection, so the scope never
 *   holds a project that no chosen organization owns.
 *
 * Controlled: the workspace owns the URL and hands the scope down. The options
 * request is aborted when the scope changes under it.
 */

import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CalendarRange } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange } from '@/lib/format'
import {
  isIsoDay,
  matchingPreset,
  presetRange,
  QUALITY_MAX_RANGE_DAYS,
  QUALITY_RANGE_PRESETS,
  qualityScopeQuery,
  rangeDays,
  utcDay,
  type QualityScope,
} from '@/lib/quality/scope'
import type { QualityScopeOptions } from '@/lib/quality/scope-options'

export interface QualityScopeBarProps {
  scope: QualityScope
  onScopeChange: (next: QualityScope) => void
  /** The pickers' options, from `useQualityScopeOptions`. */
  options: QualityScopeOptionsState
}

export interface QualityScopeOptionsState {
  options: QualityScopeOptions | null
  loading: boolean
  failed: boolean
}

const OPTIONS_ROUTE = '/api/platform/quality/scope-options'

/** Why a custom range cannot be applied, or null. The API checks the same. */
export function customRangeError(from: string, to: string): 'invalid' | 'inverted' | 'tooLong' | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return 'invalid'
  if (from > to) return 'inverted'
  if (rangeDays(from, to) > QUALITY_MAX_RANGE_DAYS) return 'tooLong'
  return null
}

/** The scope with these organizations, keeping only the projects one of them owns. */
export function withOrganizations(
  scope: QualityScope,
  organizationIds: string[],
  projectOrganization: ReadonlyMap<string, string>
): QualityScope {
  const chosen = new Set(organizationIds)
  const projectIds =
    organizationIds.length === 0
      ? []
      : scope.projectIds.filter((id) => {
          const owner = projectOrganization.get(id)
          // A project whose owner is not known yet stays until the options say otherwise.
          return owner === undefined || chosen.has(owner)
        })
  return { ...scope, organizationIds, projectIds }
}

/**
 * The scope bar's options for a scope: fetched when the range or the chosen
 * organizations and projects change, the superseded request aborted. A hook
 * rather than inside the bar because the ratings tab names the same
 * organizations and projects in its export summary, and one request serves both.
 */
export function useQualityScopeOptions(scope: QualityScope): QualityScopeOptionsState {
  const [state, setState] = useState<QualityScopeOptionsState>({ options: null, loading: true, failed: false })
  const search = qualityScopeQuery(scope)
  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => ({ ...previous, loading: true, failed: false }))
    fetch(`${OPTIONS_ROUTE}?${search}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as QualityScopeOptions
        if (!controller.signal.aborted) setState({ options: body, loading: false, failed: false })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, failed: true }))
      })
    return () => controller.abort()
  }, [search])
  return state
}

export function QualityScopeBar({ scope, onScopeChange, options: state }: QualityScopeBarProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const { options, loading, failed } = state

  const organizationOptions = useMemo<MultiSelectOption[]>(
    () => (options?.organizations ?? []).map((org) => ({ value: org.id, label: org.name ?? org.id })),
    [options]
  )
  const organizationName = useMemo(
    () => new Map(organizationOptions.map((option) => [option.value, option.label])),
    [organizationOptions]
  )
  const projectOrganization = useMemo(
    () => new Map((options?.projects ?? []).map((project) => [project.id, project.organizationId])),
    [options]
  )
  const projectOptions = useMemo<MultiSelectOption[]>(
    () =>
      (options?.projects ?? [])
        .filter((project) => scope.organizationIds.includes(project.organizationId))
        .map((project) => ({
          value: project.id,
          label: project.name,
          // With several organizations chosen, a project name alone is ambiguous.
          hint: scope.organizationIds.length > 1 ? organizationName.get(project.organizationId) : undefined,
        })),
    [options, scope.organizationIds, organizationName]
  )
  const projectName = useMemo(
    () => new Map((options?.projects ?? []).map((project) => [project.id, project.name])),
    [options]
  )

  const preset = matchingPreset(scope)
  const noOrganization = scope.organizationIds.length === 0

  return (
    <div
      className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:gap-4"
      role="group"
      aria-label={t('qualityWorkspace.scope.label')}
      data-testid="quality-scope-bar"
    >
      <Field className="md:w-auto">
        <FieldLabel>{t('qualityWorkspace.scope.range')}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            size="sm"
            segmented
            value={preset ? String(preset) : ''}
            onValueChange={(value) => {
              if (!value) return
              onScopeChange({ ...scope, ...presetRange(Number(value)) })
            }}
            aria-label={t('qualityWorkspace.scope.range')}
            data-testid="quality-range-presets"
          >
            {QUALITY_RANGE_PRESETS.map((days) => (
              <ToggleGroupItem key={days} value={String(days)} className="px-3 tabular-nums">
                {t('qualityWorkspace.scope.presetDays', { count: days })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <CustomRange
            scope={scope}
            active={preset === null}
            label={preset === null ? formatDayRange(scope.from, scope.to, locale) : t('qualityWorkspace.scope.custom')}
            onApply={(range) => onScopeChange({ ...scope, ...range })}
          />
        </div>
      </Field>

      <Field className="md:w-72">
        <FieldLabel htmlFor="quality-scope-orgs">{t('qualityWorkspace.scope.organizations')}</FieldLabel>
        <MultiSelect
          id="quality-scope-orgs"
          data-testid="quality-scope-orgs"
          label={t('qualityWorkspace.scope.organizations')}
          placeholder={t('qualityWorkspace.scope.allOrganizations')}
          searchPlaceholder={t('qualityWorkspace.scope.searchOrganizations')}
          emptyText={t('qualityWorkspace.scope.noOrganizations')}
          options={organizationOptions}
          value={scope.organizationIds}
          loading={loading && !options}
          labelFor={(id) => organizationName.get(id) ?? id}
          removeLabel={(label) => t('answerFeedback.filters.remove', { label })}
          moreLabel={(count) => t('answerFeedback.filters.more', { count })}
          maxChips={2}
          searchable
          onValueChange={(next) => onScopeChange(withOrganizations(scope, next, projectOrganization))}
        />
        {failed ? <FieldError>{t('qualityWorkspace.scope.optionsFailed')}</FieldError> : null}
      </Field>

      <Field className="md:w-72">
        <FieldLabel htmlFor="quality-scope-projects">{t('qualityWorkspace.scope.projects')}</FieldLabel>
        <MultiSelect
          id="quality-scope-projects"
          data-testid="quality-scope-projects"
          label={t('qualityWorkspace.scope.projects')}
          placeholder={
            noOrganization
              ? t('qualityWorkspace.scope.projectsNeedOrganization')
              : t('qualityWorkspace.scope.allProjects')
          }
          searchPlaceholder={t('qualityWorkspace.scope.searchProjects')}
          emptyText={t('qualityWorkspace.scope.noProjects')}
          options={projectOptions}
          value={scope.projectIds}
          disabled={noOrganization}
          loading={loading && !options}
          labelFor={(id) => projectName.get(id) ?? id}
          removeLabel={(label) => t('answerFeedback.filters.remove', { label })}
          moreLabel={(count) => t('answerFeedback.filters.more', { count })}
          maxChips={2}
          searchable
          onValueChange={(next) => onScopeChange({ ...scope, projectIds: next })}
        />
      </Field>
    </div>
  )
}

/** Two dates in a popover, applied together and only when the API would accept them. */
function CustomRange({
  scope,
  active,
  label,
  onApply,
}: {
  scope: QualityScope
  active: boolean
  label: string
  onApply: (range: { from: string; to: string }) => void
}): JSX.Element {
  const t = useTranslations('platform')
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(scope.from)
  const [to, setTo] = useState(scope.to)
  const error = customRangeError(from, to)
  const today = utcDay(new Date())

  const message =
    error === 'inverted'
      ? t('qualityWorkspace.scope.rangeInverted')
      : error === 'tooLong'
        ? t('qualityWorkspace.scope.rangeTooLong', { max: QUALITY_MAX_RANGE_DAYS })
        : error === 'invalid'
          ? t('qualityWorkspace.scope.rangeInvalid')
          : null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Opened on the range on screen, not on whatever was typed last time.
        if (next) {
          setFrom(scope.from)
          setTo(scope.to)
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={active}
          data-testid="quality-range-custom"
          className="tabular-nums"
        >
          <CalendarRange className="size-3.5" aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-72">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (error) return
            onApply({ from, to })
            setOpen(false)
          }}
        >
          <Field>
            <FieldLabel htmlFor="quality-range-from">{t('qualityWorkspace.scope.from')}</FieldLabel>
            <Input
              id="quality-range-from"
              type="date"
              value={from}
              max={today}
              onChange={(event) => setFrom(event.target.value)}
              aria-invalid={error === 'inverted' || undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="quality-range-to">{t('qualityWorkspace.scope.to')}</FieldLabel>
            <Input
              id="quality-range-to"
              type="date"
              value={to}
              max={today}
              onChange={(event) => setTo(event.target.value)}
              aria-invalid={error === 'inverted' || undefined}
            />
          </Field>
          {message ? <FieldError>{message}</FieldError> : null}
          <Button type="submit" size="sm" disabled={error !== null} data-testid="quality-range-apply">
            {t('qualityWorkspace.scope.apply')}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

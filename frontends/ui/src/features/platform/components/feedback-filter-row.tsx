'use client'

/**
 * The ratings tab's own filters, under the page-wide scope: verdict, reason,
 * topic, how the answer was produced, its confidence, whether the voter wrote
 * something, and free text.
 *
 * Every filter here narrows EVERYTHING on the tab — the figures, the digest,
 * the trend, the bars, the organization table, the list and the export — so it
 * sits above all of them rather than inside the list. Each picker shows how
 * many votes in the scope carry each value ("Brandschutz · 42", from the
 * options endpoint), counted over the scope alone so a pick never makes the
 * other values look as if they had vanished.
 *
 * Controlled: the workspace owns the URL. The search is debounced here (300 ms)
 * so typing does not push a history entry per keystroke.
 */

import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { CountPill } from '@/components/ui/count-pill'
import { Field, FieldLabel } from '@/components/ui/field'
import { Label } from '@/components/ui/label'
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select'
import { SearchField } from '@/components/ui/search-field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocale, useTranslations } from '@/i18n'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import {
  FEEDBACK_CONFIDENCE_FILTERS,
  FEEDBACK_MODE_FILTERS,
  FEEDBACK_REASON_FILTERS,
  NO_RATINGS_FILTERS,
  ratingsFiltered,
  type FeedbackConfidenceFilter,
  type FeedbackModeFilter,
  type FeedbackReasonFilter,
  type RatingsFilters,
} from '@/lib/feedback/filters'
import type { FeedbackFilterOptions } from '@/lib/feedback/export-service'
import { formatCount } from './answer-feedback-types'

export interface FeedbackFilterRowProps {
  filters: RatingsFilters
  onFiltersChange: (next: RatingsFilters) => void
  /** Per-value counts over the scope; null while loading or when they failed. */
  options: FeedbackFilterOptions | null
}

const SEARCH_DEBOUNCE_MS = 300

/** Vocabulary → picker options, labelled and counted. */
function counted<Key extends string>(
  keys: readonly Key[],
  label: (key: Key) => string,
  counts: readonly { key: Key; votes: number }[] | undefined
): MultiSelectOption[] {
  const byKey = new Map((counts ?? []).map((entry) => [entry.key, entry.votes]))
  return keys.map((key) => ({ value: key, label: label(key), count: counts ? (byKey.get(key) ?? 0) : undefined }))
}

export function FeedbackFilterRow({ filters, onFiltersChange, options }: FeedbackFilterRowProps): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const commentId = useId()
  const expectedId = useId()
  const count = (value: number): string => formatCount(value, locale)

  // The search box is local until it settles; an outside change (Clear all, a
  // link) replaces it.
  const committed = filters.query ?? ''
  const [query, setQuery] = useState(committed)
  const latest = useRef(filters)
  useEffect(() => {
    latest.current = filters
  }, [filters])
  useEffect(() => setQuery(committed), [committed])
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === committed) return
    const timer = setTimeout(() => onFiltersChange({ ...latest.current, query: trimmed || null }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, committed, onFiltersChange])

  const set = (patch: Partial<RatingsFilters>): void => onFiltersChange({ ...filters, ...patch })
  const remove = (label: string): string => t('answerFeedback.filters.remove', { label })
  const more = (n: number): string => t('answerFeedback.filters.more', { count: n })

  const reasonOptions = counted(FEEDBACK_REASON_FILTERS, (key) => t(`answerFeedback.reasons.${key}`), options?.reasons)
  const topicOptions = counted(CONVERSATION_TAG_KEYS, (key) => t(`answerFeedback.topics.${key}`), options?.topics)
  const modeOptions = counted(FEEDBACK_MODE_FILTERS, (key) => t(`answerFeedback.modes.${key}`), options?.modes)
  const confidenceOptions = counted(
    FEEDBACK_CONFIDENCE_FILTERS,
    (key) => t(`answerFeedback.confidences.${key}`),
    options?.confidences
  )
  const reasonsBlocked = filters.verdict === 'up'

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t('answerFeedback.filters.label')} data-testid="feedback-filter-row">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <Field className="lg:w-auto">
          <FieldLabel>{t('answerFeedback.filters.verdict')}</FieldLabel>
          <ToggleGroup
            type="single"
            size="sm"
            segmented
            value={filters.verdict ?? 'all'}
            onValueChange={(value) => {
              if (!value) return
              const verdict = value === 'up' || value === 'down' ? value : null
              // A reason only exists on a down-vote; carrying it to the helpful
              // votes would empty the tab.
              set({ verdict, reasons: verdict === 'up' ? [] : filters.reasons })
            }}
            aria-label={t('answerFeedback.filters.verdict')}
            data-testid="feedback-verdict"
          >
            <ToggleGroupItem value="all">{t('answerFeedback.filters.verdictAll')}</ToggleGroupItem>
            <ToggleGroupItem value="up">{t('answerFeedback.filters.verdictUp')}</ToggleGroupItem>
            <ToggleGroupItem value="down">{t('answerFeedback.filters.verdictDown')}</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <SearchField
          className="lg:flex-1"
          value={query}
          onChange={setQuery}
          placeholder={t('answerFeedback.searchPlaceholder')}
          label={t('answerFeedback.searchPlaceholder')}
          clearLabel={t('answerFeedback.clearSearch')}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field>
          <FieldLabel htmlFor="feedback-filter-reasons">{t('answerFeedback.filters.reasons')}</FieldLabel>
          <MultiSelect
            id="feedback-filter-reasons"
            data-testid="feedback-filter-reasons"
            label={t('answerFeedback.filters.reasons')}
            placeholder={
              reasonsBlocked ? t('answerFeedback.filters.reasonsNeedDown') : t('answerFeedback.filters.reasonsPlaceholder')
            }
            options={reasonOptions}
            value={filters.reasons}
            disabled={reasonsBlocked}
            formatCount={count}
            removeLabel={remove}
            moreLabel={more}
            emptyText={t('answerFeedback.filters.noOptions')}
            onValueChange={(next) => set({ reasons: next as FeedbackReasonFilter[] })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="feedback-filter-topics">{t('answerFeedback.filters.topics')}</FieldLabel>
          <MultiSelect
            id="feedback-filter-topics"
            data-testid="feedback-filter-topics"
            label={t('answerFeedback.filters.topics')}
            placeholder={t('answerFeedback.filters.topicsPlaceholder')}
            searchPlaceholder={t('answerFeedback.filters.search')}
            options={topicOptions}
            value={filters.topics}
            formatCount={count}
            removeLabel={remove}
            moreLabel={more}
            maxChips={2}
            emptyText={t('answerFeedback.filters.noOptions')}
            onValueChange={(next) => set({ topics: next as RatingsFilters['topics'] })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="feedback-filter-modes">{t('answerFeedback.filters.modes')}</FieldLabel>
          <MultiSelect
            id="feedback-filter-modes"
            data-testid="feedback-filter-modes"
            label={t('answerFeedback.filters.modes')}
            placeholder={t('answerFeedback.filters.modesPlaceholder')}
            options={modeOptions}
            value={filters.modes}
            formatCount={count}
            removeLabel={remove}
            moreLabel={more}
            emptyText={t('answerFeedback.filters.noOptions')}
            onValueChange={(next) => set({ modes: next as FeedbackModeFilter[] })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="feedback-filter-confidences">{t('answerFeedback.filters.confidences')}</FieldLabel>
          <MultiSelect
            id="feedback-filter-confidences"
            data-testid="feedback-filter-confidences"
            label={t('answerFeedback.filters.confidences')}
            placeholder={t('answerFeedback.filters.confidencesPlaceholder')}
            options={confidenceOptions}
            value={filters.confidences}
            formatCount={count}
            removeLabel={remove}
            moreLabel={more}
            emptyText={t('answerFeedback.filters.noOptions')}
            onValueChange={(next) => set({ confidences: next as FeedbackConfidenceFilter[] })}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Field orientation="horizontal" className="w-auto items-center gap-2">
          <Checkbox
            id={commentId}
            checked={filters.hasComment}
            onCheckedChange={(checked) => set({ hasComment: checked === true })}
            data-testid="feedback-filter-has-comment"
          />
          <Label htmlFor={commentId} className="font-normal">
            {t('answerFeedback.filters.hasComment')}
          </Label>
          {options ? <CountPill>{count(options.withComment)}</CountPill> : null}
        </Field>
        <Field orientation="horizontal" className="w-auto items-center gap-2">
          <Checkbox
            id={expectedId}
            checked={filters.hasExpectedAnswer}
            onCheckedChange={(checked) => set({ hasExpectedAnswer: checked === true })}
            data-testid="feedback-filter-has-expected"
          />
          <Label htmlFor={expectedId} className="font-normal">
            {t('answerFeedback.filters.hasExpected')}
          </Label>
          {options ? <CountPill>{count(options.withExpectedAnswer)}</CountPill> : null}
        </Field>
        {ratingsFiltered(filters) ? (
          <Button
            variant="ghost"
            size="sm"
            className="sm:ml-auto"
            onClick={() => {
              setQuery('')
              onFiltersChange({ ...NO_RATINGS_FILTERS })
            }}
            data-testid="clear-filters"
          >
            <X className="size-3.5" aria-hidden />
            {t('answerFeedback.filters.clearAll')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

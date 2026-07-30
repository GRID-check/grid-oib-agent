'use client'

/**
 * Answer feedback (platform owner only): the thumbs users leave on answers,
 * across every organization — and, for the ones that went wrong, a way to reach
 * the question that caused it.
 *
 * **Why this exists.** The feedback table has been written to since WS-7 and read
 * by nobody: `submitAnswerFeedback` / `retractAnswerFeedback` / a
 * per-conversation hydration of your OWN votes was the entire surface area. The
 * product asked users for a signal and then had no way to look at it, which makes
 * the asking dishonest. This is the read.
 *
 * **The form follows the job.** The job is not "how many thumbs" — it is *get me
 * to the answers that failed*. So the primary surface is the defect list, and the
 * numbers above it exist only to orient: a headline rate, a four-bar breakdown of
 * why, and a per-organization rollup that says whether a problem is everyone's or
 * one tenant's. Nothing here is a chart for its own sake; a four-category
 * magnitude comparison is a bar list, which is plain HTML and needs no library.
 *
 * **Colour.** ONE hue for every bar (`--grid-series-1`), because the job is
 * comparing magnitude and the rule for magnitude is sequential — categorical is
 * for when the series are the subject. Four categorical hues were the first
 * attempt and were wrong twice over: they put two greens in a four-row list, and
 * they encoded nothing, since every bar already carries its own label and its own
 * number. Length does the work.
 *
 * Separately, and worth recording because it outlives this file: the shared
 * 8-slot palette FAILS the dataviz normal-vision floor on its last adjacent pair
 * (#eb6834 ↔ #e87ba4, ΔE 12.9 against a floor of 15) despite its docstring
 * claiming validation. Nothing here seats eight series, so it is out of scope —
 * but it is real, and it bites whatever first puts slots 7 and 8 side by side.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquareWarning, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useLocale, useTranslations } from '@/i18n'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Down-vote reasons in FIXED order, which pins each one to a palette slot.
 * A reason keeps its colour when another drops out of the window — colour
 * follows the entity, never its rank. Mirrors `ANSWER_FEEDBACK_REASONS`.
 */
const REASONS = ['inaccurate', 'wrong_source', 'too_slow', 'other'] as const
type Reason = (typeof REASONS)[number]

/** Below this many votes a percentage is noise, not a rate — see `MIN_RATE_VOTES`. */
const MIN_RATE_VOTES = 5

interface FeedbackHealthResponse {
  windowDays: number
  answers: number
  totals: { up: number; down: number; voters: number; downVoters: number }
  reasons: { reason: Reason | null; count: number }[]
  daily: { day: string; up: number; down: number }[]
  organizations: { organizationId: string; up: number; down: number; voters: number }[]
  defects: {
    id: string
    organizationId: string
    projectId: string | null
    conversationId: string | null
    messageId: string
    reason: Reason | null
    createdAt: string
    answer: string | null
    question: string | null
    conversationTitle: string | null
  }[]
}

/**
 * Numbers wear the reader's locale, not JavaScript's.
 *
 * German writes 1.284 and 12,9 % where `toFixed`/template interpolation produce
 * 1284 and 12.9 — and this surface is read in German first. A figure whose
 * separators are wrong reads as a foreign export, which is the last impression a
 * page arguing for statistical care should give.
 */
const num = (value: number, locale: string, decimals = 0): string =>
  value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

/** Trim a persisted turn to something a scannable row can hold. */
function excerpt(value: string | null, max = 180): string | null {
  if (!value) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function AnswerFeedbackHealth(): JSX.Element {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const [data, setData] = useState<FeedbackHealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const res = await fetch('/api/platform/answer-feedback')
      if (!res.ok) throw new Error(String(res.status))
      setData((await res.json()) as FeedbackHealthResponse)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const total = (data?.totals.up ?? 0) + (data?.totals.down ?? 0)
  const downRate = total > 0 ? (data!.totals.down / total) * 100 : 0
  // What share of answers anybody rated at all. The rate above describes the
  // people who voted; this says how few of them there were.
  const coverage = data && data.answers > 0 ? (total / data.answers) * 100 : 0

  // Reason counts in the fixed order, zero-filled: a reason nobody picked is
  // information ("nobody says it is slow"), and dropping it would also let the
  // remaining bars change colour between loads.
  const reasonBars = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of data?.reasons ?? []) counts.set(entry.reason ?? 'other', entry.count)
    const max = Math.max(1, ...REASONS.map((r) => counts.get(r) ?? 0))
    return REASONS.map((reason) => ({
      reason,
      count: counts.get(reason) ?? 0,
      /** Share of the widest bar — the bar's job is comparison, not absolute scale. */
      pct: ((counts.get(reason) ?? 0) / max) * 100,
    }))
  }, [data])

  return (
    <Card className="grid-usage-viz" data-testid="answer-feedback-health">
      <SeriesPaletteStyle />
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareWarning className="size-4 text-muted-foreground" aria-hidden />
          {t('answerFeedback.title')}
        </CardTitle>
        <CardDescription>
          {t('answerFeedback.subtitle', { days: data?.windowDays ?? 30 })}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
            {t('answerFeedback.refresh')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading && !data ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : failed ? (
          <EmptyState
            variant="bare"
            icon={MessageSquareWarning}
            title={t('answerFeedback.errorTitle')}
            description={t('answerFeedback.errorBody')}
          />
        ) : total === 0 ? (
          <EmptyState
            variant="bare"
            icon={ThumbsUp}
            title={t('answerFeedback.emptyTitle')}
            description={t('answerFeedback.emptyBody')}
          />
        ) : (
          <>
            {/* ---- Orientation: the headline, then the two counts it is made of.
                 A hero figure rather than a one-bar chart (choosing-a-form). ---- */}
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="text-3xl font-semibold tabular-nums tracking-tight text-foreground">
                  {t('answerFeedback.percent', { value: num(downRate, locale, 1) })}
                </p>
                <p className="text-xs text-muted-foreground">{t('answerFeedback.downRate')}</p>
                {/* The denominator, deliberately adjacent to the headline rather
                    than tucked away. A negative rate over votes alone describes
                    the people who chose to vote — raters self-select and skew
                    negative — so without the coverage beside it the big number
                    gets quoted as a quality figure it is not. */}
                <p className="mt-0.5 text-xs text-muted-foreground/80">
                  {t('answerFeedback.coverage', {
                    votes: num(total, locale),
                    answers: num(data!.answers, locale),
                    pct: num(coverage, locale, 1),
                  })}
                </p>
              </div>
              <div className="flex items-center gap-5">
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ThumbsUp className="size-3.5" aria-hidden />
                  <span className="tabular-nums text-foreground">{num(data!.totals.up, locale)}</span>
                  {t('answerFeedback.up')}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ThumbsDown className="size-3.5" aria-hidden />
                  <span className="tabular-nums text-foreground">{num(data!.totals.down, locale)}</span>
                  {/* From how many PEOPLE. Nineteen down-votes from three users and
                      nineteen from nineteen produce the same rate and mean opposite
                      things; only this number tells them apart. */}
                  {t('answerFeedback.downFromVoters', { voters: data!.totals.downVoters })}
                </p>
              </div>
            </div>

            {/* ---- Why. Four categories, so direct labels are mandatory and the
                 value never lives in the colour alone. ---- */}
            {data!.totals.down > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('answerFeedback.reasonsHeading')}
                </h4>
                <ul className="space-y-1.5" data-testid="feedback-reason-bars">
                  {reasonBars.map(({ reason, count, pct }) => (
                    <li key={reason} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">
                        {t(`answerFeedback.reasons.${reason}`)}
                      </span>
                      {/* The track is the surface; the fill is the mark. 4px
                          rounded data-end, anchored to a zero baseline. */}
                      {/* ONE hue for all four. The job here is comparing
                          magnitude, and the skill's rule for that is sequential —
                          categorical is for when the series are the subject. Four
                          categorical hues put two greens in one four-row list and
                          encoded nothing: every bar already carries its own label
                          and its own number, so the colour was decoration, and
                          decoration that made two rows harder to tell apart. */}
                      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${pct}%`, backgroundColor: 'var(--grid-series-1)' }}
                        />
                      </span>
                      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-foreground">
                        {count}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* ---- Per organization. The second bias guard: one noisy tenant can
                 carry the whole platform rate, and a single number cannot say so.
                 Sorted by down-votes, so whoever is having the worst time is the
                 first row rather than something to hunt for. ---- */}
            {data!.organizations.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('answerFeedback.orgsHeading')}
                </h4>
                <ul className="divide-y rounded-lg border" data-testid="feedback-orgs">
                  {data!.organizations.map((org) => {
                    const orgTotal = org.up + org.down
                    const orgRate = orgTotal > 0 ? (org.down / orgTotal) * 100 : 0
                    return (
                      <li
                        key={org.organizationId}
                        data-testid="feedback-org"
                        className="flex items-center gap-3 px-3 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                          {org.organizationId}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {t('answerFeedback.orgVotes', { votes: num(orgTotal, locale) })}
                        </span>
                        {/* The rate is the comparable figure across tenants of
                            very different sizes; the raw counts sit beside it so
                            a 100% built on one vote cannot masquerade as a trend. */}
                        {/* One down-vote in an org with one vote is 100%, and it
                            would sort to the top of this list looking like a
                            crisis. Below the floor the row keeps its counts and
                            withholds the percentage rather than printing a number
                            that cannot mean anything. */}
                        {orgTotal >= MIN_RATE_VOTES ? (
                          <span className="w-14 shrink-0 text-right font-medium tabular-nums text-foreground">
                            {t('answerFeedback.percent', { value: num(orgRate, locale) })}
                          </span>
                        ) : (
                          <span
                            className="w-14 shrink-0 text-right text-muted-foreground/70"
                            title={t('answerFeedback.tooFewVotes', { min: MIN_RATE_VOTES })}
                          >
                            {t('answerFeedback.tooFewShort')}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* ---- The access point. Everything above is orientation; this is
                 what the surface is for. ---- */}
            <div className="space-y-2">
              <h4 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {t('answerFeedback.defectsHeading')}
              </h4>
              {data!.defects.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('answerFeedback.noDefects')}</p>
              ) : (
                <ul className="divide-y rounded-lg border" data-testid="feedback-defects">
                  {data!.defects.map((defect) => {
                    const question = excerpt(defect.question)
                    const answer = excerpt(defect.answer, 220)
                    return (
                      <li key={defect.id} className="space-y-1.5 px-3 py-2.5" data-testid="feedback-defect">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span
                            className="inline-flex items-center gap-1 rounded-md bg-warning-subtle px-1.5 py-px font-medium text-warning"
                          >
                            <ThumbsDown className="size-3" aria-hidden />
                            {t(`answerFeedback.reasons.${defect.reason ?? 'other'}`)}
                          </span>
                          <span className="truncate font-mono text-[11px]">{defect.organizationId}</span>
                          <time dateTime={defect.createdAt}>
                            {formatRelativeTime(defect.createdAt, locale)}
                          </time>
                        </div>

                        {/* The question is the point of the row — what was asked
                            that produced a bad answer. */}
                        {question ? (
                          <p className="text-sm leading-snug text-foreground">{question}</p>
                        ) : (
                          /* NOT an error, and said plainly rather than left blank:
                             `message_id` is the chat-store id and carries no FK to
                             `messages`, so a turn that was never persisted has
                             nothing to join. Hiding these rows would hide exactly
                             the feedback nobody has been able to look at. */
                          <p className="text-sm italic leading-snug text-muted-foreground">
                            {t('answerFeedback.turnUnavailable')}
                          </p>
                        )}
                        {answer && (
                          <p className="border-l border-border pl-2.5 text-xs leading-relaxed text-muted-foreground">
                            {answer}
                          </p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

'use client'

/**
 * The answer-feedback window, in sentences.
 *
 * **Why it sits right under the figures.** Everything around it is correct and
 * none of it is a story: a rate, four bars, a line, a table, a list of failed
 * turns. A reader who has thirty seconds reads the biggest number and leaves with
 * whatever that number implied. This says what the window actually means, and
 * says the good part and the bad part in that order.
 *
 * **Two columns, not one list.** What is working and what needs attention are
 * rendered as peers, side by side, at the same weight. Stacking them would make
 * the second one the conclusion — and the whole reason this exists is that the
 * surface used to have only the second one.
 *
 * **It says it is generated, and when.** A paragraph in a product looks
 * authored. This one is written by a model over a moving window, so it carries
 * its age and a way to re-ask; a stale narrative with no visible timestamp is how
 * a page loses a reader's trust permanently rather than temporarily.
 *
 * The empty states are not errors. A window with nine votes has no digest
 * because nine votes cannot support one, and that sentence is more useful than a
 * confident paragraph about nine votes.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface FeedbackDigestPayload {
  headline: string
  strengths: string[]
  concerns: string[]
  recommendation: string | null
  generatedAt: string
  windowDays: number
  votes: number
  /** Sampled unhelpful votes by decided cause; absent on a digest cached before causes existed. */
  causes?: { cause: string; count: number }[]
}

interface DigestResponse {
  digest: FeedbackDigestPayload | null
  error: string | null
}

export interface FeedbackDigestProps {
  /**
   * The query string of the window this digest describes: `days`, and the
   * `org` / `topic` filters that narrow the aggregates. The drill-in's own
   * filters (direction, reason, free text) do not change the sentences, and
   * passing them made every Missed/Landed switch re-ask the model.
   */
  search: string
  className?: string
}

/** Codes that describe a young window rather than a failure. */
const BENIGN = new Set(['no_feedback', 'too_few_votes'])

/**
 * The digest card. Fetches on its own so a slow model never delays the figures,
 * and renders one of four states: the sentences, a young window, a thin window,
 * or a failure that says the figures below are still good.
 */
export function FeedbackDigest({ search, className }: FeedbackDigestProps): JSX.Element | null {
  const t = useTranslations('platform')
  const { locale } = useLocale()
  const [data, setData] = useState<DigestResponse | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * The request this card is still waiting on. Filters change faster than a
   * model answers — switch direction, then topic — and without this the slower
   * of two in-flight digests wins by finishing last, leaving sentences that
   * describe a window nobody is looking at any more.
   */
  const latestRequest = useRef(0)

  const load = useCallback(
    async (refresh = false) => {
      const requestId = ++latestRequest.current
      setLoading(true)
      try {
        const params = new URLSearchParams(search)
        params.set('locale', locale)
        if (refresh) params.set('refresh', '1')
        const res = await fetch(`/api/platform/answer-feedback/digest?${params.toString()}`)
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as DigestResponse
        if (requestId === latestRequest.current) setData(body)
      } catch {
        if (requestId === latestRequest.current)
          setData({ digest: null, error: 'digest_unavailable' })
      } finally {
        if (requestId === latestRequest.current) setLoading(false)
      }
    },
    [search, locale]
  )

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) {
    return (
      <Card className={className} aria-busy data-testid="feedback-digest-loading">
        <CardHeader>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-28" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <div className="grid gap-4 pt-1 sm:grid-cols-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const digest = data?.digest ?? null
  const error = data?.error ?? null

  const title = (
    <CardTitle className="flex items-center gap-2">
      <Sparkles className="text-muted-foreground size-4" aria-hidden />
      {t('answerFeedback.digest.title')}
    </CardTitle>
  )

  // A young window and a broken model both mean "no sentences", and the reader
  // needs to know which: one is a reason to come back tomorrow, the other is a
  // reason to look at the logs. Said in one quiet line under the card title,
  // not as a big empty panel competing with the figures below.
  if (!digest) {
    return (
      <Card className={className} data-testid="feedback-digest-empty">
        <CardHeader>
          {title}
          <CardDescription>
            {t(
              error && BENIGN.has(error)
                ? `answerFeedback.digest.${error === 'no_feedback' ? 'emptyNoFeedback' : 'emptyTooFew'}`
                : 'answerFeedback.digest.unavailable'
            )}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card
      className={cn(
        'duration-base transition-opacity ease-out motion-reduce:transition-none',
        loading && 'opacity-60',
        className
      )}
      data-testid="feedback-digest"
      aria-label={t('answerFeedback.digest.title')}
      aria-busy={loading || undefined}
    >
      <CardHeader>
        {title}
        {/* Provenance and age together: "written by a model, 20 minutes ago"
            is one fact for the reader, not two. */}
        <CardDescription data-testid="feedback-digest-age">
          {t('answerFeedback.digest.generated', {
            ago: formatRelativeTime(digest.generatedAt, locale),
          })}
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(true)}
            disabled={loading}
            aria-label={t('answerFeedback.digest.regenerate')}
            title={t('answerFeedback.digest.regenerate')}
          >
            <RefreshCw
              className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')}
              aria-hidden
            />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {digest.headline && (
          <p className="text-foreground max-w-3xl text-sm leading-relaxed">{digest.headline}</p>
        )}

        {(digest.strengths.length > 0 || digest.concerns.length > 0) && (
          <div className="grid gap-5 sm:grid-cols-2">
            {/* Working first, and never conditional on there being concerns:
                a layout that collapses to one column when the good list is
                empty quietly re-privileges the bad one. */}
            <DigestColumn
              testId="feedback-digest-strengths"
              icon={<ThumbsUp className="text-success size-3.5" aria-hidden />}
              heading={t('answerFeedback.digest.working')}
              items={digest.strengths}
              emptyLabel={t('answerFeedback.digest.workingNone')}
            />
            <DigestColumn
              testId="feedback-digest-concerns"
              icon={<ThumbsDown className="text-warning size-3.5" aria-hidden />}
              heading={t('answerFeedback.digest.attention')}
              items={digest.concerns}
              emptyLabel={t('answerFeedback.digest.attentionNone')}
            />
          </div>
        )}

        {digest.recommendation && (
          <p
            className="bg-muted text-muted-foreground flex gap-2 rounded-md px-3 py-2.5 text-sm leading-relaxed"
            data-testid="feedback-digest-recommendation"
          >
            <ArrowRight className="text-foreground mt-1 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="text-foreground font-medium">
                {t('answerFeedback.digest.nextStep')}
              </span>{' '}
              {digest.recommendation}
            </span>
          </p>
        )}

        {digest.causes && digest.causes.length > 0 && (
          <p
            className="text-muted-foreground text-xs leading-relaxed"
            data-testid="feedback-digest-causes"
          >
            <span className="text-foreground font-medium">{t('answerFeedback.digest.causes')}</span>{' '}
            {digest.causes
              .map(({ cause, count }) => `${t(`answerFeedback.digest.cause.${cause}`)} ${count}`)
              .join(' · ')}
          </p>
        )}

        {/* The caveat travels with the text: these sentences are the most
            quotable thing on the page. */}
        <p className="text-muted-foreground text-xs">
          {t('answerFeedback.digest.caveat', { votes: digest.votes, days: digest.windowDays })}
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * One half of the digest. Always rendered, even with nothing in it — a column
 * that disappears when empty is how the good half quietly loses its billing.
 */
function DigestColumn({
  testId,
  icon,
  heading,
  items,
  emptyLabel,
}: {
  testId: string
  icon: JSX.Element
  heading: string
  items: string[]
  emptyLabel: string
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <p className="text-foreground flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {heading}
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{emptyLabel}</p>
      ) : (
        <ul className="marker:text-muted-foreground/60 flex list-disc flex-col gap-1.5 pl-5">
          {items.map((item) => (
            <li key={item} className="text-muted-foreground text-sm leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

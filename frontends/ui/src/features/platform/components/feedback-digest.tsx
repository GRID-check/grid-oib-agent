'use client'

/**
 * The answer-feedback window, in sentences.
 *
 * **Why it is the first thing on the card.** Everything below it is correct and
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import { formatRelativeTime } from '@/lib/format'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'

export interface FeedbackDigestPayload {
  headline: string
  strengths: string[]
  concerns: string[]
  recommendation: string | null
  generatedAt: string
  windowDays: number
  votes: number
}

interface DigestResponse {
  digest: FeedbackDigestPayload | null
  error: string | null
}

export interface FeedbackDigestProps {
  /**
   * The query string of the view this digest describes. Only the window and the
   * org/topic filters actually change the sentences — the server keys its cache
   * on those — but passing the whole thing keeps one source of truth for "what
   * is on screen" rather than a second, subtly different one here.
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
        if (requestId === latestRequest.current) setData({ digest: null, error: 'digest_unavailable' })
      } finally {
        if (requestId === latestRequest.current) setLoading(false)
      }
    },
    [search, locale],
  )

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) {
    return (
      <div className={cn('min-h-[8.5rem] space-y-2 rounded-lg border bg-muted p-4', className)}>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }

  const digest = data?.digest ?? null
  const error = data?.error ?? null

  // A young window and a broken model both mean "no sentences", and the reader
  // needs to know which: one is a reason to come back tomorrow, the other is a
  // reason to look at the logs.
  if (!digest) {
    return (
      <EmptyState
        variant="bare"
        className={cn('min-h-[8.5rem]', className)}
        data-testid="feedback-digest-empty"
        title={t(
          error && BENIGN.has(error)
            ? `answerFeedback.digest.${error === 'no_feedback' ? 'emptyNoFeedback' : 'emptyTooFew'}`
            : 'answerFeedback.digest.unavailable',
        )}
      />
    )
  }

  return (
    <section
      className={cn(
        'animate-in fade-in-0 min-h-[8.5rem] space-y-3 rounded-lg border bg-muted p-4 duration-base ease-out motion-reduce:animate-none',
        className,
      )}
      data-testid="feedback-digest"
      aria-label={t('answerFeedback.digest.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="h3" className="flex items-center gap-1.5">
          <Sparkles className="size-3.5" aria-hidden />
          {t('answerFeedback.digest.title')}
        </SectionLabel>
        <div className="flex items-center gap-1.5">
          {/* Provenance and age, together. "Written by a model, 20 minutes ago"
              is one fact for the reader, not two. */}
          <span className="text-xs text-muted-foreground/80" data-testid="feedback-digest-age">
            {t('answerFeedback.digest.generated', {
              ago: formatRelativeTime(digest.generatedAt, locale),
            })}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')} aria-hidden />
            <span className="sr-only">{t('answerFeedback.digest.regenerate')}</span>
          </Button>
        </div>
      </div>

      {digest.headline && (
        <p className="text-sm leading-relaxed text-foreground">{digest.headline}</p>
      )}

      {(digest.strengths.length > 0 || digest.concerns.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Working first, and never conditional on there being concerns:
              a layout that collapses to one column when the good list is empty
              is a layout that quietly re-privileges the bad one. */}
          <DigestColumn
            testId="feedback-digest-strengths"
            icon={<ThumbsUp className="size-3.5 text-success" aria-hidden />}
            heading={t('answerFeedback.digest.working')}
            items={digest.strengths}
            emptyLabel={t('answerFeedback.digest.workingNone')}
          />
          <DigestColumn
            testId="feedback-digest-concerns"
            icon={<ThumbsDown className="size-3.5 text-warning" aria-hidden />}
            heading={t('answerFeedback.digest.attention')}
            items={digest.concerns}
            emptyLabel={t('answerFeedback.digest.attentionNone')}
          />
        </div>
      )}

      {digest.recommendation && (
        <p
          className="border-l-2 border-border pl-2.5 text-xs leading-relaxed text-muted-foreground"
          data-testid="feedback-digest-recommendation"
        >
          <span className="font-medium text-foreground">
            {t('answerFeedback.digest.nextStep')}
          </span>{' '}
          {digest.recommendation}
        </p>
      )}

      {/* The caveat travels with the text. These sentences are a model's reading
          of self-selected votes, and they are the most quotable thing on the
          page — the disclaimer belongs where the quote is taken from. */}
      <p className="text-xs text-muted-foreground/70">
        {t('answerFeedback.digest.caveat', { votes: digest.votes, days: digest.windowDays })}
      </p>
    </section>
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
    <div className="space-y-1.5" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        {icon}
        {heading}
      </p>
      {items.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item} className="text-xs leading-relaxed text-muted-foreground">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

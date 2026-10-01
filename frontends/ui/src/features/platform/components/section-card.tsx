'use client'

/**
 * One section of the platform dashboard.
 *
 * Every admin surface previously hand-rolled its own chrome: its own skeleton,
 * its own "could not load" card, its own retry button, its own empty state —
 * all subtly different, and each one a place to forget the retry entirely.
 * This is that shape, once.
 *
 * The contract is deliberately narrow: give it a title, a description, an
 * optional action, and the state of your fetch. It decides what to render.
 * Nothing here knows anything about a specific domain.
 *
 * Two materials, one contract. `plain` is the admin card the platform and
 * organization consoles use. `raised` is the product card
 * (`components/ui/raised-card.tsx`) that project Settings is built from: the
 * same header, body states and retry, on the tray-and-sheet material, as a
 * named region with an `h2`, because its sections are the page's outline.
 */

import type { JSX } from 'react'
import { type ReactNode, useId } from 'react'
import { AlertTriangle, RefreshCw, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface SectionCardProps {
  /**
   * `plain` (the default): the admin console card. `raised`: the product card
   * a project Settings section sits on, a region named by its `h2` title.
   */
  variant?: 'plain' | 'raised'
  title: string
  description?: string
  /** Header-right controls (filters, a primary action). Hidden while loading. */
  action?: ReactNode
  /** Renders the error state with a retry button when true. */
  error?: boolean
  errorMessage?: string
  onRetry?: () => void
  /** Renders skeletons instead of children. */
  loading?: boolean
  /** How many skeleton rows to show while loading. */
  skeletonRows?: number
  /** When true (and not loading/error), renders the empty state instead of children. */
  empty?: boolean
  emptyIcon?: LucideIcon
  emptyTitle?: string
  emptyDescription?: string
  /**
   * Controls under the body: a help link, a secondary action. Hidden with the
   * header action while loading or failed, for the same reason.
   */
  footer?: ReactNode
  /** Forwarded to the Card so tests and the screenshot harness can target it. */
  testId?: string
  children?: ReactNode
}

export function SectionCard({
  variant = 'plain',
  title,
  description,
  action,
  error = false,
  errorMessage,
  onRetry,
  loading = false,
  skeletonRows = 3,
  empty = false,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  footer,
  testId,
  children,
}: SectionCardProps): JSX.Element {
  const t = useTranslations('platform')
  const titleId = useId()

  const body = (): ReactNode => {
    // Error wins over loading: a retry leaves `loading` true for a moment, and
    // flipping back to a skeleton would hide the thing the user just clicked.
    if (error) {
      return (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <AlertTriangle className="size-8 text-muted-foreground" aria-hidden />
          <p role="alert" className="text-sm font-medium">
            {errorMessage ?? t('loadError')}
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry} disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
              {t('retry')}
            </Button>
          ) : null}
        </div>
      )
    }
    if (loading) {
      return (
        <div className="flex flex-col gap-2" data-testid="section-loading">
          {Array.from({ length: skeletonRows }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      )
    }
    if (empty) {
      return (
        <EmptyState
          variant="bare"
          icon={emptyIcon}
          title={emptyTitle ?? t('empty.title')}
          description={emptyDescription}
        />
      )
    }
    return (
      <div
        className={cn(
          'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
          // A settings section stacks blocks (a field, a list), on one rhythm.
          variant === 'raised' && 'space-y-5'
        )}
      >
        {children}
      </div>
    )
  }

  const header = (
    <CardHeader>
      {variant === 'raised' ? (
        <h2 id={titleId} data-slot="card-title" className="text-foreground text-sm font-semibold">
          {title}
        </h2>
      ) : (
        <CardTitle>{title}</CardTitle>
      )}
      {description ? (
        <CardDescription className={variant === 'raised' ? 'max-w-2xl leading-relaxed' : undefined}>
          {description}
        </CardDescription>
      ) : null}
      {/* CardAction is pinned to the header's second column, which squeezes
          the title to a sliver on narrow viewports — drop it onto its own
          full-width row under `sm`. */}
      {action && !loading && !error ? (
        <CardAction className="col-start-1 row-span-1 row-start-3 justify-self-start pt-1 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-self-end sm:pt-0">
          {action}
        </CardAction>
      ) : null}
    </CardHeader>
  )

  const footerRow =
    footer && !loading && !error ? (
      <CardFooter className="flex-wrap justify-between gap-3">{footer}</CardFooter>
    ) : null

  if (variant === 'raised') {
    // The body's own padding is dropped so CardHeader and CardContent keep the
    // plain card's `px-6` gutter: one header geometry in both materials.
    return (
      <RaisedCard role="region" aria-labelledby={titleId} data-testid={testId}>
        <RaisedCardBody className="flex flex-col gap-5 px-0 pt-6 pb-6">
          {header}
          <CardContent>{body()}</CardContent>
          {footerRow}
        </RaisedCardBody>
      </RaisedCard>
    )
  }

  return (
    <Card data-testid={testId}>
      {header}
      <CardContent>{body()}</CardContent>
      {footerRow}
    </Card>
  )
}

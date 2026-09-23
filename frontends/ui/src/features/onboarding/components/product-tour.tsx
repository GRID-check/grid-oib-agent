'use client'

/**
 * The product tours: short, skippable walks for someone new — the org scope
 * right after they create their organization (`welcome`), and the inside of a
 * project right after they set up their first one (`project`). Which stops each
 * has, and why, is in `../lib/product-tour.ts`.
 *
 * Positioning, the spotlight and the overlay are bought, not built: NextStep
 * (`nextstepjs`, the maintained fork of Onborda) animates with the `motion`
 * package this app already ships and takes a custom card, so the tour is drawn
 * with our own {@link TourCard} instead of a restyled library default. What
 * this file owns is the product half: copy, when a tour starts, and what it
 * reports.
 *
 * WHEN IT RUNS. Only when asked: onboarding lands on `?tour=welcome`, the
 * intake wizard's first save on `?tour=project`, and the account menu starts
 * whichever tour belongs to the page it is opened on
 * ({@link useStartProductTour}). There is no "seen it" flag to go stale — a
 * tour nobody asked for is the one people learn to dismiss unread.
 *
 * LAYOUT. NextStep wraps its children in two block `div`s. The shell is
 * `h-dvh` with its own scroll container, so wrapping it whole is harmless; the
 * one thing that must not happen is mounting NextStep as a flex SIBLING of the
 * chrome, where its `width: 100%` wrapper would take a share of the row.
 */

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { NextStep, NextStepProvider, useNextStep, type CardComponentProps } from 'nextstepjs'
import { useReducedMotion } from 'motion/react'

import { motionDeliberate, motionInstant } from '@/components/motion'
import { TourCard } from '@/components/ui/tour-card'
import { ShortcutKeys } from '@/components/shell/shortcut-keys'
import { MOD } from '@/components/shell/shortcuts'
import { useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import {
  ARRIVAL_ANCHOR,
  TOURS,
  TOUR_START_URL,
  placeStops,
  requestedTour,
  tourAnchorSelector,
  tourForPath,
  type AnchorBox,
  type PlacedTourStop,
  type TourFlags,
  type TourId,
} from '../lib/product-tour'

/** How long arrival waits for the page to render the tour's first anchor. */
const ARRIVAL_TIMEOUT_MS = 5000
const ARRIVAL_POLL_MS = 100
/** A beat for the page to settle before a tour that waits for nothing. */
const ARRIVAL_SETTLE_MS = 400

const StartTourContext = React.createContext<(() => void) | null>(null)

export interface ProductTourProps extends TourFlags {
  children: React.ReactNode
  /**
   * Which tour belongs on a pathname. The product derives it from the route
   * (`tourForPath`); the `/dev/product-tour` preview pins one so the real tour
   * can run against fixtures on a `/dev` path.
   */
  tourAt?: (pathname: string) => TourId | null
}

export function ProductTour({ children, ...options }: ProductTourProps): JSX.Element {
  return (
    <NextStepProvider>
      <ProductTourRunner {...options}>{children}</ProductTourRunner>
    </NextStepProvider>
  )
}

/**
 * Starts the tour that belongs to the current page, in place; from a page with
 * no tour, goes to the projects home and starts the welcome tour there. A
 * no-op outside {@link ProductTour}, so a menu rendered in a dev preview
 * without the shell does not crash.
 */
export function useStartProductTour(): () => void {
  return React.useContext(StartTourContext) ?? noop
}

function noop(): void {}

function ProductTourRunner({
  children,
  canAccessArchiv,
  canAccessInbox,
  tourAt = tourForPath,
}: ProductTourProps): JSX.Element {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const reduceMotion = useReducedMotion()
  const { startNextStep } = useNextStep()
  const t = useTranslations('onboarding.tour')
  const [active, setActive] = React.useState<{ tour: TourId; stops: PlacedTourStop[] } | null>(null)
  const here = tourAt(pathname)

  // Both state updates land in one render, so NextStep sees the new steps on
  // the same pass that opens the tour.
  const startHere = React.useCallback(
    (tour: TourId) => {
      const stops = placeStops(TOURS[tour], { canAccessArchiv, canAccessInbox }, locateAnchor, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
      setActive({ tour, stops })
      startNextStep(tour)
    },
    [canAccessArchiv, canAccessInbox, startNextStep],
  )

  const start = React.useCallback(() => {
    if (here) startHere(here)
    else router.push(TOUR_START_URL)
  }, [here, router, startHere])

  // Arrival via `?tour=`: drop the parameter so a reload does not replay the
  // tour, then wait for the page to render what the tour points at first.
  React.useEffect(() => {
    const tour = requestedTour(window.location.search)
    if (!tour || tour !== here) return
    router.replace(pathname, { scroll: false })
    const anchor = ARRIVAL_ANCHOR[tour]
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt
      const ready = anchor
        ? locateAnchor(tourAnchorSelector(anchor)) !== null
        : elapsed >= ARRIVAL_SETTLE_MS
      if (!ready && elapsed < ARRIVAL_TIMEOUT_MS) return
      window.clearInterval(timer)
      startHere(tour)
    }, ARRIVAL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [here, pathname, router, startHere])

  const tours = React.useMemo(
    () =>
      active
        ? [
            {
              tour: active.tour,
              steps: active.stops.map((stop) => ({
                title: t(`stops.${stop.id}.title`),
                content: <StopBody stop={stop} />,
                selector: stop.side && stop.anchor ? tourAnchorSelector(stop.anchor) : undefined,
                side: stop.side,
                pointerPadding: 12,
                pointerRadius: 12,
              })),
            },
          ]
        : [],
    [active, t],
  )

  const stopCount = active?.stops.length ?? 0

  return (
    <StartTourContext.Provider value={start}>
      <NextStep
        steps={tours}
        cardComponent={ProductTourCard}
        displayArrow={false}
        shadowRgb="0, 0, 0"
        shadowOpacity="0.32"
        cardTransition={reduceMotion ? motionInstant : motionDeliberate}
        // The document never scrolls — the shell's `<main>` does — so the
        // library's end-of-tour `window.scrollTo` would be a no-op at best.
        scrollToTop={false}
        disableConsoleLogs
        onComplete={(tour) => capturePosthog('product_tour_completed', { tour, stops: stopCount })}
        onSkip={(step, tour) =>
          capturePosthog('product_tour_skipped', {
            tour,
            step,
            stop: active?.stops[step]?.id,
            stops: stopCount,
          })
        }
      >
        {children}
      </NextStep>
    </StartTourContext.Provider>
  )
}

/** An anchor's box, or null when it is absent or not laid out (a closed drawer). */
function locateAnchor(selector: string): AnchorBox | null {
  const element = document.querySelector(selector)
  if (!element) return null
  const { left, right, top, bottom } = element.getBoundingClientRect()
  return right > left && bottom > top ? { left, right, top, bottom } : null
}

function ProductTourCard({
  step,
  currentStep,
  totalSteps,
  nextStep,
  prevStep,
  skipTour,
}: CardComponentProps): JSX.Element {
  const t = useTranslations('onboarding.tour')
  return (
    <TourCard
      title={step.title}
      step={currentStep}
      total={totalSteps}
      labels={{
        next: t('next'),
        back: t('back'),
        done: t('done'),
        close: t('close'),
        progress: t('progress', { current: currentStep + 1, total: totalSteps }),
      }}
      onNext={nextStep}
      onBack={prevStep}
      onClose={() => skipTour?.()}
    >
      {step.content}
    </TourCard>
  )
}

/**
 * A stop's body. Most are one paragraph; the shortcuts stop shows real keycaps,
 * and the Files-or-Archiv stop sets the two side by side, because "which one
 * does this document go in" is the question it exists to answer.
 */
function StopBody({ stop }: { stop: PlacedTourStop }): JSX.Element {
  const t = useTranslations('onboarding.tour')
  if (stop.id === 'shortcuts') {
    return (
      <div className="space-y-3">
        <p>{t('stops.shortcuts.body')}</p>
        <dl className="space-y-2">
          <TourDetailRow term={t('stops.shortcuts.palette')}>
            <ShortcutKeys segments={[{ kind: 'chord', caps: [MOD, 'K'] }]} />
          </TourDetailRow>
          <TourDetailRow term={t('stops.shortcuts.cheatsheet')}>
            <ShortcutKeys segments={[{ kind: 'chord', caps: ['?'] }]} />
          </TourDetailRow>
        </dl>
      </div>
    )
  }
  if (stop.id === 'filesOrArchiv') {
    return (
      <div className="space-y-3">
        <p>{t('stops.filesOrArchiv.body')}</p>
        <dl className="space-y-2.5">
          <TourDetailRow term={t('stops.filesOrArchiv.filesTerm')} stacked>
            {t('stops.filesOrArchiv.filesDetail')}
          </TourDetailRow>
          <TourDetailRow term={t('stops.filesOrArchiv.archivTerm')} stacked>
            {t('stops.filesOrArchiv.archivDetail')}
          </TourDetailRow>
        </dl>
      </div>
    )
  }
  return <p>{t(`stops.${stop.id}.body`)}</p>
}

/** One term and its detail inside a stop: side by side, or stacked for prose. */
function TourDetailRow({
  term,
  stacked = false,
  children,
}: {
  term: string
  stacked?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={stacked ? 'space-y-0.5' : 'flex items-center justify-between gap-3'}>
      <dt className="text-foreground font-medium">{term}</dt>
      <dd>{children}</dd>
    </div>
  )
}

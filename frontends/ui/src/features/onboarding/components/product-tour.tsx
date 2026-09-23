'use client'

/**
 * The product tour: a short, skippable walk through the org scope for someone
 * who has just created their organization.
 *
 * Positioning, the spotlight and the overlay are bought, not built: NextStep
 * (`nextstepjs`, the maintained fork of Onborda) animates with the `motion`
 * package this app already ships and takes a custom card, so the tour is drawn
 * with our own {@link TourCard} instead of a restyled library default. What
 * this file owns is the product half: which stops exist, their copy, when the
 * tour starts, and what it reports.
 *
 * WHEN IT RUNS. Only on the projects home, and only when asked: onboarding
 * lands on `TOUR_START_URL` once the organization exists, and the account
 * menu offers it again ({@link useStartProductTour}). There is no "seen it"
 * flag to go stale — a tour nobody asked for is the one people learn to
 * dismiss unread.
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
  PRODUCT_TOUR,
  TOUR_ANCHORS,
  TOUR_HOME,
  TOUR_STOPS,
  placeStops,
  requestsTour,
  tourAnchorSelector,
  tourStartUrl,
  type PlacedTourStop,
  type TourStop,
} from '../lib/product-tour'

/** How long arrival waits for the projects page to render its first anchor. */
const ARRIVAL_TIMEOUT_MS = 5000
const ARRIVAL_POLL_MS = 100

const StartTourContext = React.createContext<(() => void) | null>(null)

export interface ProductTourProps {
  children: React.ReactNode
  /**
   * The page the tour runs on. The product only ever uses the projects home;
   * the `/dev/product-tour` preview passes its own path so the real tour can
   * run against fixtures.
   */
  home?: string
}

export function ProductTour({ children, home = TOUR_HOME }: ProductTourProps): JSX.Element {
  return (
    <NextStepProvider>
      <ProductTourRunner home={home}>{children}</ProductTourRunner>
    </NextStepProvider>
  )
}

/**
 * Starts the tour: in place on the projects home, otherwise by navigating
 * there. Returns a no-op outside {@link ProductTour}, so a menu rendered in a
 * dev preview without the shell does not crash.
 */
export function useStartProductTour(): () => void {
  return React.useContext(StartTourContext) ?? noop
}

function noop(): void {}

function ProductTourRunner({ children, home }: Required<ProductTourProps>): JSX.Element {
  const pathname = usePathname() ?? ''
  const router = useRouter()
  const reduceMotion = useReducedMotion()
  const { startNextStep } = useNextStep()
  const t = useTranslations('onboarding.tour')
  const [stops, setStops] = React.useState<PlacedTourStop[]>([])

  // Both state updates land in one render, so NextStep sees the new steps on
  // the same pass that opens the tour.
  const startHere = React.useCallback(() => {
    setStops(placeStops(TOUR_STOPS, locateAnchor, window.innerWidth))
    startNextStep(PRODUCT_TOUR)
  }, [startNextStep])

  const start = React.useCallback(() => {
    if (pathname === home) startHere()
    else router.push(tourStartUrl(home))
  }, [home, pathname, router, startHere])

  // Arrival via `?tour=welcome`: drop the parameter so a reload does not
  // replay the tour, then wait for the page to render the first anchor. The
  // projects home streams in behind a loading state, so "mounted" is not yet
  // "on screen".
  React.useEffect(() => {
    if (pathname !== home || !requestsTour(window.location.search)) return
    router.replace(home, { scroll: false })
    const firstAnchor = tourAnchorSelector(TOUR_ANCHORS.createProject)
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const ready = document.querySelector(firstAnchor) !== null
      if (!ready && Date.now() - startedAt < ARRIVAL_TIMEOUT_MS) return
      window.clearInterval(timer)
      startHere()
    }, ARRIVAL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [home, pathname, router, startHere])

  const tours = React.useMemo(
    () => [
      {
        tour: PRODUCT_TOUR,
        steps: stops.map((stop) => ({
          title: t(`stops.${stop.id}.title`),
          content: <StopBody stop={stop} />,
          selector: stop.anchor ? tourAnchorSelector(stop.anchor) : undefined,
          side: stop.side,
          pointerPadding: 12,
          pointerRadius: 12,
        })),
      },
    ],
    [stops, t],
  )

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
        onComplete={() => capturePosthog('product_tour_completed', { stops: stops.length })}
        onSkip={(step) =>
          capturePosthog('product_tour_skipped', { step, stop: stops[step]?.id, stops: stops.length })
        }
      >
        {children}
      </NextStep>
    </StartTourContext.Provider>
  )
}

function locateAnchor(selector: string): { left: number; right: number } | null {
  const element = document.querySelector(selector)
  if (!element) return null
  const { left, right } = element.getBoundingClientRect()
  return { left, right }
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

/** A stop's body. The shortcuts stop shows real keycaps, not a spelled-out "Cmd". */
function StopBody({ stop }: { stop: TourStop }): JSX.Element {
  const t = useTranslations('onboarding.tour')
  if (stop.id !== 'shortcuts') return <p>{t(`stops.${stop.id}.body`)}</p>

  return (
    <div className="space-y-3">
      <p>{t('stops.shortcuts.body')}</p>
      <dl className="space-y-2">
        <ShortcutRow label={t('stops.shortcuts.palette')} segments={[{ kind: 'chord', caps: [MOD, 'K'] }]} />
        <ShortcutRow label={t('stops.shortcuts.cheatsheet')} segments={[{ kind: 'chord', caps: ['?'] }]} />
      </dl>
    </div>
  )
}

function ShortcutRow({
  label,
  segments,
}: {
  label: string
  segments: React.ComponentProps<typeof ShortcutKeys>['segments']
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-foreground">{label}</dt>
      <dd>
        <ShortcutKeys segments={segments} />
      </dd>
    </div>
  )
}

/**
 * SourceBasisTrigger — the composer's Datenbasis control.
 *
 * Replaces a hand-rolled button that carried five arbitrary values
 * (`gap-[7px]`, `px-[11px]`, `text-xs`, `size-3.5`, `size-3`) and an
 * `active:scale-95` with no `motion-reduce` escape — all of it a direct
 * design-language violation introduced purely by not reaching for
 * `<Button variant="outline" size="sm">`, which is what it is now.
 *
 * ## Never a naked integer
 *
 * The old trigger rendered a count. The count was wrong (the knowledge layer is
 * stripped from the list yet appended to every turn) and, on the Büroarchiv
 * preset, it read **0** — the user names the office archive and the composer
 * reports zero sources. Worse, a bare number says nothing about *what* is in
 * scope. So the trigger renders one of two shapes instead, resolved by
 * `summariseCategories`:
 *
 * | shape | reads |
 * |---|---|
 * | `all` | "Alle Quellen" — in ink, no chroma: "everything" is not a provenance claim |
 * | `subset` | icon + category name, max two, then a `+N` `CountPill` |
 *
 * Every coloured unit is icon + word + colour together — never a colour-only
 * dot (design language §2).
 *
 * ## Motion
 *
 * Strata enter and leave through `AnimatePresence mode="popLayout"` on a 4px
 * x-offset, so a stratum dropping out of scope is legible as a departure rather
 * than a reflow. A preset click landing while the picker is *closed* gets a
 * one-shot `y:-2 → 0` receipt — the only feedback that the click did anything,
 * since the popover is not on screen to show it. The overflow number never
 * animates: springing digits read as a game, and this is a legal tool.
 * `MotionConfig reducedMotion="user"` (providers.tsx) flattens all of it.
 */

'use client'

import { forwardRef, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { ChevronDown, Layers } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { AnimatePresence, motion, springSnappy } from '@/components/motion'
import { cn } from '@/lib/utils'
import { useAuth } from '@/adapters/auth'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../../store'
import type { SourceSignal } from '../../lib/source-presets'
import { iconForTint } from '../SourceSignalChip'
import { useSourceCategoryLabels } from './SourceBasisPicker'
import {
  buildSourceCategories,
  summariseCategories,
  CATEGORY_SIGNAL,
  type BasisSummary,
} from './source-basis-model'

/**
 * Static class map rather than an interpolated `text-source-${signal}-text`:
 * Tailwind scans source text, so a computed class name is a class that does not
 * exist in the bundle.
 */
const SIGNAL_TEXT: Record<SourceSignal, string> = {
  law: 'text-source-law-text',
  office: 'text-source-office-text',
  project: 'text-source-project-text',
  model: 'text-source-model-text',
  auto: 'text-source-auto-text',
}

/** One stratum, spelled out: icon + word + colour, never colour alone. */
const StratumUnit = ({ signal, label }: { signal: SourceSignal; label: string }) => {
  const Icon = iconForTint(signal)
  return (
    <motion.span
      layout="position"
      initial={{ opacity: 0, x: 4 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -4 }}
      transition={springSnappy}
      className={cn('inline-flex items-center gap-1', SIGNAL_TEXT[signal])}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </motion.span>
  )
}

export interface SourceBasisTriggerProps extends ComponentProps<typeof Button> {
  /** Whether the picker is currently open — suppresses the closed-state receipt. */
  pickerOpen?: boolean
}

export const SourceBasisTrigger = forwardRef<HTMLButtonElement, SourceBasisTriggerProps>(
  function SourceBasisTrigger({ className, pickerOpen = false, ...props }, ref) {
    const t = useTranslations('research')
    const { idToken } = useAuth()

    const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
    const availableDataSources = useLayoutStore((s) => s.availableDataSources)
    const knowledgeLayerAvailable = useLayoutStore((s) => s.knowledgeLayerAvailable)
    const activeSourcePreset = useLayoutStore((s) => s.activeSourcePreset)

    const labels = useSourceCategoryLabels()

    const summary: BasisSummary = useMemo(
      () =>
        summariseCategories(
          buildSourceCategories({
            sources: availableDataSources,
            enabledIds: enabledDataSourceIds,
            activePreset: activeSourcePreset,
            knowledgeLayerAvailable,
            hasValidToken: !!idToken,
            labels,
          })
        ),
      [
        availableDataSources,
        enabledDataSourceIds,
        activeSourcePreset,
        knowledgeLayerAvailable,
        idToken,
        labels,
      ]
    )

    // One-shot receipt: the mix changed while the picker was closed, so this
    // button is the only place the change can be seen.
    const signature = `${summary.kind}:${summary.categories.join(',')}:${summary.overflow}`
    const previousSignature = useRef(signature)
    const [receipt, setReceipt] = useState(0)
    useEffect(() => {
      if (previousSignature.current === signature) return
      previousSignature.current = signature
      if (!pickerOpen) setReceipt((n) => n + 1)
    }, [signature, pickerOpen])

    const label =
      summary.kind === 'all'
        ? t('sourceBasis.allSources')
        : summary.categories.map((id) => t(`sourceBasis.categories.${id}.name`)).join(', ')

    return (
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="sm"
        className={cn('max-w-[min(15rem,60vw)] shrink-0 gap-2 text-muted-foreground', className)}
        aria-label={t('sourceBasis.triggerAria', { summary: label })}
        {...props}
      >
        <motion.span
          // Remounting on `receipt` re-runs initial → animate; the key is stable
          // while nothing changes, so idle renders animate nothing.
          key={`receipt-${receipt}`}
          initial={{ y: -2 }}
          animate={{ y: 0 }}
          transition={springSnappy}
          className="inline-flex items-center gap-2"
        >
          {summary.kind === 'all' ? (
            // "Everything" is not a provenance claim, so it gets no chroma.
            <span className="inline-flex items-center gap-1.5">
              <Layers className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('sourceBasis.allSources')}</span>
            </span>
          ) : (
            <AnimatePresence mode="popLayout" initial={false}>
              {summary.categories.map((id) => (
                <StratumUnit
                  key={id}
                  signal={CATEGORY_SIGNAL[id]}
                  label={t(`sourceBasis.categories.${id}.name`)}
                />
              ))}
            </AnimatePresence>
          )}
          {summary.overflow > 0 && (
            <CountPill aria-label={t('sourceBasis.overflowAria', { count: summary.overflow })}>
              +{summary.overflow}
            </CountPill>
          )}
        </motion.span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      </Button>
    )
  }
)

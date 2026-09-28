'use client'

/**
 * The composer's Aufwand dial: how long Piloti thinks before it answers, per chat.
 *
 * A chip beside the send button names the current level; it opens a popover
 * with one five-stop slider, "Schneller" on the left and "Intelligenter" on the
 * right. The level is this chat's (`stores/effort-store.ts`), starts at the
 * organization's default and goes out with every question.
 *
 * The slider is a native `<input type="range">`, as in `viewer-slider.tsx`:
 * keyboard- and screen-reader-operable for free, drawn as a wide track whose
 * dot fill thickens toward the thumb. The dial writes on every step
 * because the write is a synchronous store update, never a round trip.
 */

import { type CSSProperties, type FC, useEffect, useId } from 'react'
import { ChevronDown, HelpCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { CHAT_EFFORTS, chatEffortFromSettings } from '@/lib/reasoning-settings/catalog'
import { cn } from '@/lib/utils'

import { effectiveEffort, useEffortStore } from '../../stores/effort-store'

let orgDefaultRequest: Promise<void> | null = null

/** Read the organization's default once per page load; a failure keeps the product default. */
function loadOrgDefault(): Promise<void> {
  orgDefaultRequest ??= fetch('/api/organization/settings')
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { settings?: { settings?: Record<string, unknown> } } | null) => {
      if (body?.settings) {
        useEffortStore.getState().setOrgDefault(chatEffortFromSettings(body.settings.settings))
      }
    })
    .catch(() => undefined)
  return orgDefaultRequest
}

/** Test hook: forget the cached default request. */
export function resetEffortDialDefaultRequest(): void {
  orgDefaultRequest = null
}

interface EffortDialProps {
  conversationId: string | null | undefined
  disabled?: boolean
  className?: string
}

export const EffortDial: FC<EffortDialProps> = ({ conversationId, disabled = false, className }) => {
  const t = useTranslations('chat')
  const effort = useEffortStore((state) => effectiveEffort(state, conversationId))
  const choose = useEffortStore((state) => state.choose)

  useEffect(() => {
    void loadOrgDefault()
  }, [])

  const index = CHAT_EFFORTS.indexOf(effort)
  const label = t(`effortDial.levels.${effort}`)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="effort-dial-trigger"
          className={cn('text-muted-foreground h-8 gap-1 rounded-lg px-2.5 text-xs font-semibold', className)}
          disabled={disabled}
          aria-label={t('effortDial.trigger', { level: label })}
          title={t('effortDial.trigger', { level: label })}
        >
          {label}
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-4" data-testid="effort-dial">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">
            <span className="text-muted-foreground">{t('effortDial.title')}</span>{' '}
            <span className="font-semibold" data-testid="effort-dial-level">
              {label}
            </span>
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded-full"
                aria-label={t('effortDial.help')}
              >
                <HelpCircle className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{t('effortDial.help')}</TooltipContent>
          </Tooltip>
        </div>

        <div className="text-muted-foreground mt-4 flex justify-between text-xs" aria-hidden="true">
          <span>{t('effortDial.faster')}</span>
          <span>{t('effortDial.smarter')}</span>
        </div>
        <EffortSlider
          label={t('effortDial.title')}
          index={index}
          valueText={label}
          onChoose={(next) => choose(conversationId, next)}
        />
      </PopoverContent>
    </Popover>
  )
}

interface EffortSliderProps {
  label: string
  index: number
  valueText: string
  onChoose: (level: (typeof CHAT_EFFORTS)[number]) => void
}

/** Thumb width and its inset from the track edge, in px; the fill is measured with them. */
const THUMB = 28
const INSET = 4

/**
 * The track is drawn behind a transparent range input that covers it, so the
 * browser still owns dragging, clicking and the arrow keys. Only the thumb is
 * restyled, and it carries the focus ring: the input's own outline is
 * suppressed with `!` because the global `:focus-visible` rule in
 * `globals.css` is unlayered and outranks every utility.
 *
 * The dot fill runs from the left edge to the thumb's centre, which the browser
 * places at `THUMB / 2` plus the value's share of the travel left after the
 * thumb, and fades in from the left so it is densest at the thumb.
 */
const EffortSlider: FC<EffortSliderProps> = ({ label, index, valueText, onChoose }) => {
  const sliderId = useId()
  const share = index / (CHAT_EFFORTS.length - 1)
  const fill = {
    '--effort-share': share,
    width: `calc(${INSET + THUMB / 2}px + (100% - ${2 * INSET + THUMB}px) * var(--effort-share))`,
    backgroundImage: 'radial-gradient(circle, currentColor 1.1px, transparent 1.6px)',
    backgroundSize: '6px 6px',
    backgroundPosition: 'left center',
    maskImage: 'linear-gradient(to right, transparent, black 85%)',
  } as CSSProperties

  return (
    <div className="bg-muted relative mt-2 h-10 rounded-xl pointer-coarse:h-11">
      <div
        className="text-foreground/70 absolute inset-y-1 left-0 rounded-l-xl"
        style={fill}
        aria-hidden="true"
        data-testid="effort-dial-fill"
      />
      <label htmlFor={sliderId} className="sr-only">
        {label}
      </label>
      <input
        id={sliderId}
        type="range"
        data-testid="effort-dial-slider"
        className={cn(
          'absolute inset-1 h-[calc(100%-8px)] w-[calc(100%-8px)] cursor-pointer appearance-none bg-transparent focus-visible:outline-none!',
          '[&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:h-8 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-lg [&::-webkit-slider-thumb]:shadow-sm',
          '[&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:h-8 [&::-moz-range-thumb]:w-7 [&::-moz-range-thumb]:rounded-lg [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow-sm',
          'focus-visible:[&::-webkit-slider-thumb]:ring-ring/60 focus-visible:[&::-webkit-slider-thumb]:ring-offset-muted focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-offset-2',
          'focus-visible:[&::-moz-range-thumb]:ring-ring/60 focus-visible:[&::-moz-range-thumb]:ring-offset-muted focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-offset-2'
        )}
        min={0}
        max={CHAT_EFFORTS.length - 1}
        step={1}
        value={index}
        aria-valuetext={valueText}
        onChange={(event) => {
          const next = CHAT_EFFORTS[Number(event.target.value)]
          if (next) onChoose(next)
        }}
      />
    </div>
  )
}

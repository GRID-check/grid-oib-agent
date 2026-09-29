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

import { motion, springGlide } from '@/components/motion'
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

export const EffortDial: FC<EffortDialProps> = ({
  conversationId,
  disabled = false,
  className,
}) => {
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
          className={cn(
            'text-muted-foreground h-8 gap-1 rounded-lg px-2.5 text-xs font-semibold',
            className
          )}
          disabled={disabled}
          aria-label={t('effortDial.trigger', { level: label })}
          title={t('effortDial.trigger', { level: label })}
        >
          {label}
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72 p-4"
        data-testid="effort-dial"
      >
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

/** Thumb width and its inset from the track edge, in px; every position is measured with them. */
const THUMB = 28
const INSET = 4

/** The rail the thumb's centre travels: from its centre at the left stop to its centre at the right. */
const RAIL: CSSProperties = { left: INSET + THUMB / 2, right: INSET + THUMB / 2 }

/** A box as wide as the thumb's travel, starting at the thumb's left edge in the left stop. */
const TRAVEL: CSSProperties = { left: INSET, width: `calc(100% - ${2 * INSET + THUMB}px)` }

/** The fade that thickens the trail toward the thumb. It ends at the thumb's centre, one track long; the track clips the rest. */
const TRAIL_WINDOW: CSSProperties = {
  right: `calc(100% - ${THUMB / 2}px)`,
  width: `calc(100% + ${2 * INSET + THUMB}px)`,
  maskImage: 'linear-gradient(to right, transparent, black 85%)',
}

/**
 * Inside the window, a box as wide as the travel whose left edge sits at the
 * track's left edge when the thumb is in the left stop. It glides back by the
 * same share the window glides forward, so what it carries stands still.
 */
const TRAIL_ANCHOR: CSSProperties = {
  left: `calc(100% - ${INSET + THUMB / 2}px)`,
  width: `calc(100% - ${2 * INSET + THUMB}px)`,
}

/** The dots, one track wide and fixed to the track. */
const TRAIL_DOTS: CSSProperties = {
  left: 0,
  width: `calc(100% + ${2 * INSET + THUMB}px)`,
  backgroundImage: 'radial-gradient(circle, currentColor 1.1px, transparent 1.6px)',
  backgroundSize: '6px 6px',
  backgroundPosition: 'left center',
}

/**
 * The track is drawn under an invisible range input that covers it, so the
 * browser still owns dragging, clicking and the arrow keys. The input's own
 * thumb keeps the drawn thumb's width, which is what makes the browser's stop
 * positions and the drawn ones the same.
 *
 * Light stops mark the five levels. The thumb glides between them on
 * `springGlide`: the travel is anything from one stop to all four, and the
 * glide is the reader's own input carried through. The dot trail does not
 * travel with it: the dots are fixed to the track and the thumb reveals them,
 * through a window that glides with the thumb while the dots inside glide
 * back by the same share. Everything moves by `transform`, a share of a box
 * exactly as wide as the travel, so the global
 * `<MotionConfig reducedMotion="user">` drops the glide for readers who asked
 * for less motion. A stop the trail has reached fades out, since a grey dot
 * inside the trail reads as a blemish rather than a stop, and the stops sit
 * under both.
 */
const EffortSlider: FC<EffortSliderProps> = ({ label, index, valueText, onChoose }) => {
  const sliderId = useId()
  const share = index / (CHAT_EFFORTS.length - 1)
  const glide = {
    initial: false,
    animate: { x: `${share * 100}%` },
    transition: springGlide,
  } as const
  const holdStill = {
    initial: false,
    animate: { x: `${-share * 100}%` },
    transition: springGlide,
  } as const

  return (
    <div className="bg-muted pointer-coarse:h-11 group relative mt-2 h-10 overflow-hidden rounded-xl">
      <div className="pointer-events-none absolute inset-y-0" style={RAIL} aria-hidden="true">
        {CHAT_EFFORTS.map((level, position) => (
          <span
            key={level}
            data-testid="effort-dial-stop"
            data-passed={position <= index}
            className={cn(
              'bg-muted-foreground/35 duration-quick absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-opacity ease-out',
              position <= index && 'opacity-0'
            )}
            style={{ left: `${(position / (CHAT_EFFORTS.length - 1)) * 100}%` }}
          />
        ))}
      </div>
      <motion.div
        className="pointer-events-none absolute inset-y-1"
        style={TRAVEL}
        aria-hidden="true"
        {...glide}
      >
        <span className="absolute inset-y-0 overflow-hidden" style={TRAIL_WINDOW}>
          <motion.span
            className="absolute inset-y-0"
            style={TRAIL_ANCHOR}
            data-testid="effort-dial-trail"
            data-share={-share}
            {...holdStill}
          >
            <span className="text-foreground/70 absolute inset-y-0" style={TRAIL_DOTS} />
          </motion.span>
        </span>
      </motion.div>
      <motion.div
        className="pointer-events-none absolute inset-y-1"
        style={TRAVEL}
        aria-hidden="true"
        data-testid="effort-dial-thumb"
        data-share={share}
        {...glide}
      >
        <span className="bg-foreground group-has-[input:focus-visible]:ring-ring/60 group-has-[input:focus-visible]:ring-offset-muted absolute inset-y-0 left-0 w-7 rounded-lg shadow-sm group-has-[input:focus-visible]:ring-2 group-has-[input:focus-visible]:ring-offset-2" />
      </motion.div>
      <label htmlFor={sliderId} className="sr-only">
        {label}
      </label>
      <input
        id={sliderId}
        type="range"
        data-testid="effort-dial-slider"
        className={cn(
          'absolute inset-1 z-10 h-[calc(100%-8px)] w-[calc(100%-8px)] cursor-pointer appearance-none opacity-0',
          '[&::-webkit-slider-thumb]:h-8 [&::-webkit-slider-thumb]:w-7 [&::-webkit-slider-thumb]:appearance-none',
          '[&::-moz-range-thumb]:h-8 [&::-moz-range-thumb]:w-7 [&::-moz-range-thumb]:border-0'
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

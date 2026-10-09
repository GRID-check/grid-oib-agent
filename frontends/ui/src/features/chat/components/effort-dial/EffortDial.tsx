'use client'

/**
 * The composer's Aufwand dial: how long Piloti thinks before it answers, per chat.
 *
 * A chip beside the send button names the current level; it opens a popover
 * with one five-stop slider, "Schneller" on the left and "Intelligenter" on the
 * right. The level is this chat's (`stores/effort-store.ts`), starts at the
 * organization's default and goes out with every question.
 *
 * The top stop warns. Maximum thinks far longer and spends far more tokens, and
 * on an ordinary question it overthinks rather than answers better, so the
 * popover says so while it is chosen and the chip carries the warning colour.
 *
 * The warning appears while the reader may still be dragging, so it must not
 * move the slider. The popover is pinned at the edge that faces the chip and
 * grows away from it, so the warning sits on that far side of the slider:
 * above it when the popover opens upwards (`data-side="top"`, the composer's
 * case), below it when a short viewport flips it. Nor may the warning flip the
 * popover: its side is chosen leaving room for it (`WARNING_ROOM`) and then
 * kept (`useStickySide`). It folds open by height on the tween scale, and
 * appears without motion for a reader who asked for less.
 *
 * The slider is a native `<input type="range">`, as in `viewer-slider.tsx`:
 * keyboard- and screen-reader-operable for free, drawn as a wide track with a
 * flat fill up to the thumb. The dial writes on every step because the write
 * is a synchronous store update, never a round trip.
 */

import {
  type CSSProperties,
  type FC,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { AlertTriangle, ChevronDown, HelpCircle } from 'lucide-react'
import { animate, useMotionValue, useReducedMotionConfig, useTransform } from 'motion/react'

import {
  AnimatePresence,
  motion,
  motionBase,
  motionInstant,
  motionQuick,
  springGlide,
} from '@/components/motion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { CHAT_EFFORTS, chatEffortFromSettings } from '@/lib/reasoning-settings/catalog'
import { cn } from '@/lib/utils'

import { effectiveEffort, useEffortStore } from '../../stores/effort-store'

/** The top stop, the one the dial warns about. */
const MAXIMUM = CHAT_EFFORTS[CHAT_EFFORTS.length - 1]

/**
 * Room, in px, the popover keeps free above and below while the warning is
 * hidden: at least the warning's height, which is three lines and its margin,
 * 82px in either language. Radix flips a popover that no longer fits, and a
 * warning arriving mid-drag must not be the thing that flips it, so the side
 * is chosen as if the warning were already there. Longer copy needs more room.
 */
const WARNING_ROOM = 96

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

type PopoverSide = 'top' | 'bottom'

/**
 * Keep the popover on the side it opened on.
 *
 * Radix re-runs its flip on every resize and always tries the preferred side
 * first, so a popover that opened below for lack of room jumps back above the
 * moment its content shrinks, or its collision padding does. Preferring
 * whatever side it is on makes the choice sticky: it moves only when that side
 * stops fitting. Each opening starts from the composer's own side, the top.
 */
function useStickySide(): {
  side: PopoverSide
  observeSide: (node: HTMLDivElement | null) => void
  resetSide: () => void
} {
  const [side, setSide] = useState<PopoverSide>('top')
  const observer = useRef<MutationObserver | null>(null)

  const observeSide = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) return
    observer.current = new MutationObserver(() => {
      const placed = node.dataset.side
      if (placed === 'top' || placed === 'bottom') setSide(placed)
    })
    observer.current.observe(node, { attributes: true, attributeFilter: ['data-side'] })
  }, [])

  return { side, observeSide, resetSide: useCallback(() => setSide('top'), []) }
}

/** Test hook: forget the cached default request. */
export function resetEffortDialDefaultRequest(): void {
  orgDefaultRequest = null
}

interface EffortDialProps {
  conversationId: string | null | undefined
  disabled?: boolean
  /**
   * Out of sight but still in the row: invisible, unfocusable and silent, at
   * its full width. For the composer's response mode, where a HITL answer is
   * not a question and the dial has nothing to say. Unmounting it there made
   * every control beside it jump sideways twice per prompt.
   */
  hidden?: boolean
  /**
   * Where the keyboard goes if the dial hides while it holds the focus (the
   * chip, or the slider in its open popover). The composer passes its field:
   * the dial hides because a question arrived, and the field is where it is
   * answered. Without it the focus is let go to <body> rather than left on a
   * control nobody can see.
   */
  focusOnHide?: RefObject<HTMLElement | null>
  className?: string
}

export const EffortDial: FC<EffortDialProps> = ({
  conversationId,
  disabled = false,
  hidden = false,
  focusOnHide,
  className,
}) => {
  const t = useTranslations('chat')
  const effort = useEffortStore((state) => effectiveEffort(state, conversationId))
  const choose = useEffortStore((state) => state.choose)

  useEffect(() => {
    void loadOrgDefault()
  }, [])

  const reducedMotion = useReducedMotionConfig()
  const { side, observeSide, resetSide } = useStickySide()
  const index = CHAT_EFFORTS.indexOf(effort)
  const label = t(`effortDial.levels.${effort}`)
  const isMaximum = effort === MAXIMUM
  // Controlled only so a dial that hides while open closes too, rather than
  // leaving its popover standing over an invisible chip.
  const [open, setOpen] = useState(false)

  // Hiding while focused hands the focus on, before paint, so no frame has the
  // keyboard on an invisible, aria-hidden control (and a screen reader is not
  // left announcing one).
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!hidden) return
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) return
    const holdsFocus =
      (triggerRef.current?.contains(focused) ?? false) ||
      (contentRef.current?.contains(focused) ?? false)
    if (!holdsFocus) return
    if (focusOnHide?.current) focusOnHide.current.focus()
    else focused.blur()
  }, [hidden, focusOnHide])

  // One node, two readers: the focus hand-off above and the side tracking.
  const setContent = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      observeSide(node)
    },
    [observeSide]
  )

  return (
    <Popover
      open={open && !hidden}
      onOpenChange={(next) => {
        // Each opening starts from the composer's side. Reset on open rather
        // than on close: a dial that hides closes without this callback.
        if (next) resetSide()
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="sm"
          data-testid="effort-dial-trigger"
          className={cn(
            'text-muted-foreground h-8 gap-1 rounded-lg px-2.5 text-xs font-semibold',
            isMaximum && 'text-warning hover:text-warning',
            hidden && 'invisible',
            className
          )}
          disabled={disabled}
          aria-hidden={hidden || undefined}
          tabIndex={hidden ? -1 : undefined}
          aria-label={t('effortDial.trigger', { level: label })}
          title={t('effortDial.trigger', { level: label })}
        >
          {/* Every level's name stacked in one cell, only the current one
              visible: the chip is as wide as the longest name at every level,
              so turning the dial never moves the controls beside it. */}
          <span className="grid" data-testid="effort-dial-label">
            {CHAT_EFFORTS.map((level) => (
              <span
                key={level}
                className={cn('col-start-1 row-start-1', level !== effort && 'invisible')}
                aria-hidden={level !== effort || undefined}
              >
                {t(`effortDial.levels.${level}`)}
              </span>
            ))}
          </span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={setContent}
        side={side}
        align="end"
        sideOffset={8}
        collisionPadding={isMaximum ? 0 : { top: WARNING_ROOM, bottom: WARNING_ROOM }}
        className="group/effort flex w-72 flex-col p-4"
        data-testid="effort-dial"
        // Closed by hiding: the focus has already moved on (above), and
        // Radix's return to the trigger would put it back on the hidden chip.
        onCloseAutoFocus={(event) => {
          if (hidden) event.preventDefault()
        }}
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

        <AnimatePresence initial={false}>
          {isMaximum && (
            <motion.div
              key="maximum-warning"
              className="overflow-hidden group-data-[side=bottom]/effort:order-last"
              initial={{ height: 0, opacity: 0 }}
              animate={{
                height: 'auto',
                opacity: 1,
                transition: reducedMotion ? motionInstant : motionBase,
              }}
              exit={{
                height: 0,
                opacity: 0,
                transition: reducedMotion ? motionInstant : motionQuick,
              }}
            >
              <Alert
                variant="warning"
                data-testid="effort-dial-maximum-warning"
                className="mt-3 px-3 py-2.5 text-xs"
              >
                <AlertTriangle aria-hidden="true" />
                <AlertDescription className="text-xs">
                  {t('effortDial.maximumWarning')}
                </AlertDescription>
              </Alert>
            </motion.div>
          )}
        </AnimatePresence>

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

/** Inside the fill's clip, the same travel: the clip is already inset. */
const FILL_TRAVEL: CSSProperties = { left: 0, width: `calc(100% - ${THUMB}px)` }

/** The fill ends under the thumb's centre and is long enough to reach the left edge from the right stop. */
const FILL: CSSProperties = {
  right: `calc(100% - ${THUMB / 2}px)`,
  width: `calc(100% + ${THUMB}px)`,
}

/**
 * The track is drawn under an invisible range input that covers it, so the
 * browser still owns dragging, clicking and the arrow keys. The input's own
 * thumb keeps the drawn thumb's width, which is what makes the browser's stop
 * positions and the drawn ones the same.
 *
 * Light stops mark the five levels, and a flat, translucent fill runs from the
 * left edge to the thumb, so a stop reads the same on either side of it. The
 * fill rides with the thumb inside a clip and is one flat colour, so nothing in
 * it can be seen to move but its end, which the thumb covers. (It used to be a
 * dotted trail under a fade, and the fade travelling with the thumb read as the
 * background sliding.)
 *
 * Fill and thumb follow ONE spring: a single motion value, animated on
 * `springGlide` and read by both, so they cannot drift apart however a drag
 * retargets it. Each step of a drag retargets the spring from where it is,
 * velocity and all. The value starts at the chosen stop, so opening the dial
 * does not glide. `animate()` on a bare motion value does not consult
 * `<MotionConfig>`, so a reader who asked for less motion gets a jump, read
 * from `useReducedMotionConfig`, which honours both that config and the OS.
 */
const EffortSlider: FC<EffortSliderProps> = ({ label, index, valueText, onChoose }) => {
  const sliderId = useId()
  const reducedMotion = useReducedMotionConfig()
  const share = index / (CHAT_EFFORTS.length - 1)
  const position = useMotionValue(share)
  const x = useTransform(position, (value) => `${value * 100}%`)

  useEffect(() => {
    if (reducedMotion) {
      position.jump(share)
      return
    }
    const glide = animate(position, share, springGlide)
    return () => glide.stop()
  }, [position, share, reducedMotion])

  return (
    <div className="bg-muted pointer-coarse:h-11 group relative mt-2 h-10 overflow-hidden rounded-xl">
      <div className="pointer-events-none absolute inset-y-0" style={RAIL} aria-hidden="true">
        {CHAT_EFFORTS.map((level, stop) => (
          <span
            key={level}
            data-testid="effort-dial-stop"
            className="bg-muted-foreground/40 absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ left: `${(stop / (CHAT_EFFORTS.length - 1)) * 100}%` }}
          />
        ))}
      </div>
      <div
        className="pointer-events-none absolute inset-1 overflow-hidden rounded-lg"
        aria-hidden="true"
      >
        <motion.div
          className="absolute inset-y-0"
          style={{ ...FILL_TRAVEL, x }}
          data-testid="effort-dial-fill"
          data-share={share}
        >
          <span className="bg-foreground/10 absolute inset-y-0" style={FILL} />
        </motion.div>
      </div>
      <motion.div
        className="pointer-events-none absolute inset-y-1"
        style={{ ...TRAVEL, x }}
        aria-hidden="true"
        data-testid="effort-dial-thumb"
        data-share={share}
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

'use client'

/**
 * The composer's Aufwand dial: how long Piloti thinks before it answers, per chat.
 *
 * A chip beside the send button names the current level; it opens a popover
 * with one five-stop slider, "Schneller" on the left and "Intelligenter" on the
 * right. The level is this chat's (`stores/effort-store.ts`), starts at the
 * organization's default and goes out with every question.
 *
 * A native `<input type="range">`, as in `viewer-slider.tsx`: keyboard- and
 * screen-reader-operable for free. The dial writes on every step because the
 * write is a synchronous store update, never a round trip.
 */

import { type FC, useEffect, useId } from 'react'
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
  const sliderId = useId()
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
        <label htmlFor={sliderId} className="sr-only">
          {t('effortDial.title')}
        </label>
        <input
          id={sliderId}
          type="range"
          data-testid="effort-dial-slider"
          className="accent-foreground mt-2 h-2 w-full cursor-pointer pointer-coarse:h-11"
          min={0}
          max={CHAT_EFFORTS.length - 1}
          step={1}
          value={index}
          aria-valuetext={label}
          onChange={(event) => {
            const next = CHAT_EFFORTS[Number(event.target.value)]
            if (next) choose(conversationId, next)
          }}
        />
        <div className="mt-1 flex justify-between px-1" aria-hidden="true">
          {CHAT_EFFORTS.map((level, position) => (
            <span
              key={level}
              className={cn('size-1 rounded-full', position <= index ? 'bg-foreground' : 'bg-muted-foreground/40')}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * BranchOptions — the shared "Folgewege" branch-picker grid.
 *
 * ONE visual source of truth for a multiple-choice clarifier ("Folgefrage"),
 * used by BOTH the live clarifier bubble (`AgentPrompt`) and the trace's
 * `BranchesNode`, so the clarifier looks the same wherever it appears. Each
 * option is a selectable card with a letter badge (→ check when chosen),
 * matching the v6 prototype's Folgewege node; selected/answered/dimmed states
 * are handled here so callers only supply data + a select handler.
 */

'use client'

import { type FC, useEffect } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface BranchOptionsProps {
  options: string[]
  /** The chosen option text, if the prompt was answered. */
  selected?: string
  /** True once answered — cards lock and non-selected ones dim. */
  isResponded?: boolean
  /** Fires the chosen option; omit for a read-only render. */
  onSelect?: (option: string) => void
  /**
   * Enable 1–9 digit keyboard shortcuts (the live clarifier). Off for the
   * in-trace echo so two live listeners never fight over digits.
   */
  digitShortcuts?: boolean
}

export const BranchOptions: FC<BranchOptionsProps> = ({
  options,
  selected,
  isResponded = false,
  onSelect,
  digitShortcuts = false,
}) => {
  // Digit shortcuts (1–9) mirror the visible badges. Scoped so it never hijacks
  // digits meant for the composer or another control (skips editable focus +
  // modifier chords), and only while the prompt is live and interactive.
  useEffect(() => {
    if (!digitShortcuts || !onSelect || isResponded) return
    const handleDigit = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return
      }
      if (!/^[1-9]$/.test(e.key)) return
      const index = Number(e.key) - 1
      if (index >= options.length) return
      e.preventDefault()
      onSelect(options[index])
    }
    document.addEventListener('keydown', handleDigit)
    return () => document.removeEventListener('keydown', handleDigit)
  }, [digitShortcuts, onSelect, isResponded, options])

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {options.map((option, i) => {
        const isSelected = selected === option
        const dimmed = isResponded && !isSelected
        const interactive = Boolean(onSelect) && !isResponded
        return (
          <button
            key={`${option}-${i}`}
            type="button"
            onClick={() => interactive && onSelect?.(option)}
            disabled={!interactive}
            aria-pressed={isSelected}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-left',
              'transition-[border-color,box-shadow,opacity] duration-200 ease-out motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              isSelected ? 'border-primary shadow-sm' : 'shadow-xs',
              interactive ? 'cursor-pointer hover:border-input hover:shadow-sm' : 'cursor-default',
              dimmed && 'opacity-60'
            )}
          >
            <span
              className={cn(
                'mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : 'border-[1.5px] border-input bg-card text-[10px] font-semibold text-muted-foreground'
              )}
              aria-hidden="true"
            >
              {isSelected ? <Check className="size-2.5" /> : String.fromCharCode(65 + i)}
            </span>
            <span
              className={cn(
                'text-[13.5px] leading-snug text-foreground',
                isSelected ? 'font-semibold' : 'font-medium'
              )}
            >
              {option}
            </span>
          </button>
        )
      })}
    </div>
  )
}

'use client'

/**
 * The composer's scope chip — WHERE THE READER IS STANDING, in a glyph, a label
 * and a count (`workspace-chat-ui.md` §4).
 *
 * Three carriers answer "where am I": the chrome, the breadcrumb and this chip.
 * Two of them can be absent at once — the rail is gone in the Büro and the
 * breadcrumb is hidden on an empty thread — so this one has to survive alone,
 * and below `sm` it survives with the glyph only. `Lock` and `Building2` must
 * therefore be distinguishable at 14px; they are, which is why the dashed
 * `--status-active` ring this replaces had to go: it was ornament sitting in
 * the leading slot, and with two scopes that slot is where the signal belongs
 * (§10.2 — the user guide promised a lock in 2026-07 and the code owed it).
 *
 * It takes NO provenance colour. The chip states where you are standing, not
 * where an answer came from, and painting it gold because "Büro" shares a word
 * with "Büroarchiv" would make the composer claim a provenance before a single
 * source had been read (§6).
 */

import { forwardRef } from 'react'
import { Building2, ChevronDown, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ChipCount } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'

export interface ScopeChipProps {
  /** `project` locks to one project; `workspace` mounts several. */
  variant: 'project' | 'workspace'
  /** "Büro", or the project's name. */
  label: string
  /** Projects in view. Rendered as a trailing count from 1 up. */
  mountedCount?: number
  /** Read-only participant — the unchanged composer rule. */
  disabled?: boolean
}

/**
 * `size="sm"` sits below 44px, so the chip GROWS on a coarse pointer rather
 * than taking `touch-target`: the Datenbasis trigger and the Deep-Research pill
 * are its immediate neighbours, and two overlapping 44px catchments hand the
 * tap to whichever comes later in the DOM (§8).
 */
export const ScopeChip = forwardRef<HTMLButtonElement, ScopeChipProps>(function ScopeChip(
  { variant, label, mountedCount = 0, disabled, ...triggerProps },
  ref
) {
  const t = useTranslations('chat')
  const Glyph = variant === 'workspace' ? Building2 : Lock
  // The whole state, spoken: a reader who never opens the tree still hears the
  // scope AND how far it has been widened.
  const ariaLabel =
    variant === 'workspace'
      ? t('workspace.chipAria', { count: mountedCount })
      : t('workspace.chipAriaProject', { project: label })

  return (
    <Button
      ref={ref}
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      data-testid="scope-chip"
      data-scope-variant={variant}
      className="pointer-coarse:min-h-11 min-w-0"
      {...triggerProps}
    >
      <Glyph className="text-foreground/70 size-3.5 shrink-0" aria-hidden="true" />
      <span className={cn('text-foreground/85 hidden max-w-44 truncate sm:inline')}>{label}</span>
      {/* The count rides the CHIP and not only the "Im Blick" row, because the
          row is the first thing a narrow viewport gives up and the chip is the
          last. Hidden at zero: "Büro · 0" would be a number about nothing. */}
      {mountedCount > 0 && <ChipCount>{mountedCount}</ChipCount>}
      <ChevronDown className="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
    </Button>
  )
})

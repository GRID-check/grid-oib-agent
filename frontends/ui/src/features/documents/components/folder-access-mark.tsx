'use client'

/**
 * The lock on a restricted folder (ADR-0078), with the roles it is restricted
 * to in a tooltip.
 *
 * It sits INSIDE the tile's open button, so it is not a control of its own:
 * the tooltip is the pointer's way in, and the button's accessible name says
 * the same thing for a screen reader (`folders.access.openRestricted`). On
 * touch, the folder's ⋯ → „Zugriff…" shows the roles in full. Ink, not
 * chroma: a restriction is not a provenance, so it takes no signal colour.
 */

import type { JSX } from 'react'
import { Lock } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export function FolderAccessMark({
  roleNames,
  label: labelOverride,
  className,
  testId,
}: {
  /** The names of the roles the folder is restricted to. */
  roleNames: readonly string[]
  /**
   * The tooltip, when the mark names something other than a folder's roles —
   * a memory note restricted to folders (ADR-0078) uses the same lock.
   */
  label?: string
  className?: string
  testId?: string
}): JSX.Element {
  const t = useTranslations('files')
  const label = labelOverride ?? t('folders.access.restrictedTo', { roles: roleNames.join(', ') })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('text-muted-foreground inline-flex shrink-0 items-center', className)}
          data-testid={testId}
          data-roles={roleNames.join(', ')}
        >
          <Lock className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  )
}

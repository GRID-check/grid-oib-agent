'use client'

/**
 * The lock on a folder with its own access list (ADR-0088, ADR-0096), with
 * what the list means in a tooltip: only the people on it, or every project
 * member reading and only the people on it editing. WHO is on it is not in the
 * listing; the folder's ⋯ → „Zugriff…" shows it to whoever may change it.
 *
 * It sits INSIDE the tile's open button, so it is not a control of its own:
 * the tooltip is the pointer's way in, and the button's accessible name says
 * the same thing for a screen reader (`folders.access.openRestricted`). Ink,
 * not chroma: a restriction is not a provenance, so it takes no signal colour.
 */

import type { JSX } from 'react'
import { Eye, Lock } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/** What a folder's own list means, as the lock and the open button say it. */
export function useFolderOwnAccessLabel(): (ownAccess: { everyoneReads: boolean }) => string {
  const t = useTranslations('files')
  return (ownAccess) => t(ownAccess.everyoneReads ? 'folders.access.ownListEveryoneReads' : 'folders.access.ownList')
}

export function FolderAccessMark({
  label,
  names,
  className,
  testId,
}: {
  /** The tooltip: what the restriction is. */
  label: string
  /**
   * What the lock stands for, as a data attribute for tests — a memory note
   * restricted to folders (ADR-0087) names those folders.
   */
  names?: readonly string[]
  className?: string
  testId?: string
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('text-muted-foreground inline-flex shrink-0 items-center', className)}
          data-testid={testId}
          data-names={names?.join(', ')}
        >
          <Lock className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * „Nur lesen" on a folder the reader may open but not change (ADR-0088), with
 * the reason in a tooltip. Beside the name rather than instead of a control:
 * the write affordances are gone from the menu and the drop target is off, and
 * this is what says why. The server refuses a write anyway; this only reflects
 * it.
 */
export function FolderReadOnlyBadge({ testId }: { testId?: string }): JSX.Element {
  const t = useTranslations('files')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="text-muted-foreground shrink-0 gap-1 font-normal" data-testid={testId}>
          <Eye className="size-3" aria-hidden />
          {t('folders.access.readOnlyBadge')}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{t('folders.access.readOnlyHint')}</TooltipContent>
    </Tooltip>
  )
}

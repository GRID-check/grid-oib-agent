'use client'

/**
 * Full-width Archiv entry card on the projects home — the door into the
 * org-wide office knowledge store (ADR-0024). The server page renders it only
 * when the `organization-archiv` feature flag is on (the same gate the
 * /app/archiv page and the topbar entry check).
 *
 * Gold is the Büroarchiv provenance signal (spec §4, `--source-office`),
 * always paired with the archive icon + label so color is never the only
 * carrier (a11y). The `--source-*` tokens land with the parallel token retune
 * (WS-1); until then the tint falls back to the warning feedback tokens —
 * semantic vars only, no hex, theme-aware either way.
 */

import Link from 'next/link'
import { Archive, ChevronRight } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { StatCardIcon } from '@/components/ui/stat-card'
import { cn } from '@/lib/utils'

export function ArchivEntryCard(): JSX.Element {
  const t = useTranslations('projects')

  return (
    <Link
      href="/app/archiv"
      aria-label={t('archivCard.aria')}
      // Scale values only (`px-4`, `size-9`, `size-4`) — the 2px/1px drift from
      // the old arbitraries is a one-time static alignment to the scale, not an
      // animated shift. `shadow-sm` at rest with NO hover lift (audit §5.6):
      // the chevron's nudge is already the hover signal, so a lift would
      // promise a second one. The well is the shared `StatCardIcon` in the
      // office tint, and the control ring is the documented one instead of
      // the hand-rolled third recipe.
      className={cn(
        'group flex w-full items-center gap-3.5 rounded-lg border border-border bg-card px-4 py-3.5 shadow-sm transition-colors duration-quick ease-out focus-visible:outline-none motion-reduce:transition-none',
        FOCUS_RING,
      )}
    >
      <StatCardIcon icon={Archive} tone="office" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold tracking-tight">{t('archivCard.title')}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t('archivCard.subtitle')}</span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform duration-quick ease-out group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        aria-hidden
      />
    </Link>
  )
}

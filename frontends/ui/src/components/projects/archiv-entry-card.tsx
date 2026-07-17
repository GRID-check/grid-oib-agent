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

import type { CSSProperties } from 'react'
import Link from 'next/link'
import { Archive, ChevronRight } from 'lucide-react'
import { useTranslations } from '@/i18n'

const OFFICE_TINT: CSSProperties = {
  backgroundColor: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
  color: 'var(--source-office-text, var(--source-office, var(--text-color-feedback-warning)))',
}

export function ArchivEntryCard(): JSX.Element {
  const t = useTranslations('projects')

  return (
    <Link
      href="/app/archiv"
      aria-label={t('archivCard.aria')}
      className="group flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs transition-shadow duration-200 ease-out hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={OFFICE_TINT} aria-hidden>
        <Archive className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold tracking-tight">{t('archivCard.title')}</span>
        <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">{t('archivCard.subtitle')}</span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
        aria-hidden
      />
    </Link>
  )
}

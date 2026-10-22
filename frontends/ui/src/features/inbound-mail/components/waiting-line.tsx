'use client'

/**
 * The quiet line above the Dateien shelf: „2 E-Mails warten auf Ablage ·
 * Ansehen“. The material of Piloti's suggestions (card surface, one hairline,
 * no shadow), so above the grid it reads as part of the page, not as a
 * dialog that wants an answer first. Only while something waits.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { SuggestionPanel } from '@/components/ui/suggestion-panel'
import { useTranslations } from '@/i18n'

export function InboundMailWaitingLine({ href, count, more }: { href: string; count: number; more: boolean }): JSX.Element | null {
  const t = useTranslations('files')
  if (count <= 0) return null
  return (
    <SuggestionPanel className="animate-in fade-in-0 duration-base motion-reduce:animate-none" data-testid="inbound-mail-waiting-line">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs">
        <Mail className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="text-foreground font-medium">
          {more ? t('inboundMail.waitingLineMore', { count }) : t('inboundMail.waitingLine', { count })}
        </span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <Link href={href} className="text-foreground underline-offset-2 hover:underline touch-target">
          {t('inboundMail.view')}
        </Link>
      </p>
    </SuggestionPanel>
  )
}

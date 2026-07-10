/**
 * LegalBasisCard — the product's proof-of-work.
 *
 * Reads like an authoritative legal citation, not a chat bubble: a quiet card
 * with a thin left accent, the law/Richtlinie + article/§ references in the
 * header (identifiers in mono), the cited regulation excerpt as a real
 * blockquote at a readable measure, a plain-language summary, and — when the
 * source can be resolved — a link out to the primary source (OIB / RIS).
 */

'use client'

import { type FC } from 'react'
import { Scale, ExternalLink } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import type { LegalBasisCardData } from '../types'

/**
 * Resolve a verifiable primary-source URL for a legal basis.
 *
 * OIB Richtlinien are published by the Österreichisches Institut für Bautechnik;
 * everything else (Gesetze, Verordnungen) is searchable in the federal legal
 * information system (RIS). Returns null when nothing sensible can be built.
 */
const resolveSourceUrl = (law: string, section?: string | null): string | null => {
  const trimmed = law.trim()
  if (!trimmed) return null

  if (/oib|richtlinie/i.test(trimmed)) {
    return 'https://www.oib.or.at/de/oib-richtlinien'
  }

  const query = [trimmed, section ? `§ ${section}` : ''].filter(Boolean).join(' ')
  return `https://www.ris.bka.gv.at/Ergebnis.wxe?Abfrage=Gesamtabfrage&SucheNachText=${encodeURIComponent(
    query
  )}`
}

export const LegalBasisCard: FC<LegalBasisCardData> = ({
  law,
  article,
  section,
  summary,
  original_text,
}) => {
  const t = useTranslations('chat')
  const sourceUrl = resolveSourceUrl(law, section)

  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-3 border-l-2 border-l-primary/40 p-5 shadow-xs">
      {/* Eyebrow — marks this as a citation, not a message */}
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Scale className="size-3.5" aria-hidden="true" />
        <span>Legal basis</span>
      </div>

      {/* Header: law/Richtlinie + § / article references */}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-foreground">{law}</p>
        {article && (
          <Badge variant="outline" className="font-mono text-xs font-normal">
            Art. {article}
          </Badge>
        )}
        {section && (
          <Badge variant="outline" className="font-mono text-xs font-normal">
            § {section}
          </Badge>
        )}
      </div>

      {/* Cited excerpt — a real blockquote at a readable measure */}
      {original_text && (
        <blockquote className="max-w-prose border-l-2 border-border pl-4 text-sm italic leading-relaxed text-muted-foreground">
          {original_text}
        </blockquote>
      )}

      {/* Plain-language summary */}
      {summary && <p className="max-w-prose text-sm leading-relaxed text-foreground">{summary}</p>}

      {/* Verifiable primary source */}
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          {/oib|richtlinie/i.test(law) ? 'View OIB Richtlinie' : 'Verify in RIS'}
        </a>
      )}

      {/* AI-transparency label (EU AI Act Art. 50): the excerpt above is
          model-generated, not a verbatim copy of the regulation. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('cards.aiGenerated')}
      </p>
    </Card>
  )
}

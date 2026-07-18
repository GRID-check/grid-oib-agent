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

import { type FC, useState } from 'react'
import { Scale, ExternalLink, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { resolveCorpusFileName } from '@/features/knowledge/lib/resolve-corpus-file'
import { useCorpusFiles } from '@/features/knowledge/lib/use-corpus-files'
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
  const tViewer = useTranslations('knowledge')
  const sourceUrl = resolveSourceUrl(law, section)

  // When the cited Richtlinie's source PDF exists in the knowledge base, the
  // citation opens the actual document in-app instead of just linking out.
  const corpusFiles = useCorpusFiles()
  const corpusFileName = resolveCorpusFileName(law, corpusFiles)
  const [viewerOpen, setViewerOpen] = useState(false)

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-3 border-l-2 border-l-primary/30 pl-4">
      {/* Eyebrow — marks this as a citation, not a message */}
      <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <Scale className="size-3.5" aria-hidden="true" />
        <span>{t('cards.legalBasis')}</span>
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

      {/* Verifiable primary source: in-app PDF when we have it, link otherwise */}
      <div className="flex flex-wrap items-center gap-4">
        {corpusFileName && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            {tViewer('viewer.view')}
          </button>
        )}
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {/oib|richtlinie/i.test(law) ? t('cards.viewOib') : t('cards.verifyRis')}
          </a>
        )}
      </div>

      {corpusFileName && viewerOpen && (
        <PdfViewerDialog open onOpenChange={setViewerOpen} fileName={corpusFileName} title={law} />
      )}

      {/* AI-transparency label (EU AI Act Art. 50): the excerpt above is
          model-generated, not a verbatim copy of the regulation. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('cards.aiGenerated')}
      </p>
    </div>
  )
}

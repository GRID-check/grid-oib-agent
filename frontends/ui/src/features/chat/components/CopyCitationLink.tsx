/**
 * Copying a link that lands on this exact citation.
 *
 * Distinct from `CopySourceCitationButton`, which copies the citation as TEXT
 * for a Befund or a bibliography. This copies an address: paste it to a
 * colleague and their browser opens the answer with this document showing, at
 * this page. The evidence stops being something you describe and becomes
 * something you can hand over.
 */

'use client'

import { type FC, type ReactNode, useState } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { citationShareUrl, type CitationRef } from '../lib/citations'

export const CopyCitationLinkButton: FC<{ citation: CitationRef; icon?: ReactNode }> = ({
  citation,
  icon,
}) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    // Read the location here rather than in `citationShareUrl`, which stays
    // pure so the link format is testable without a DOM.
    const url = citationShareUrl(citation, {
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
    })
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('answerSources.copyFailed'))
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={t('citationPeek.copyLinkAria', { label: citation.document.title })}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
        'text-muted-foreground transition-[color,transform] duration-quick ease-out active:scale-95 hover:text-foreground',
        'motion-reduce:transition-none motion-reduce:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      {copied ? <Check aria-hidden="true" className="size-3" /> : icon}
      {copied ? t('answerSources.copied') : t('citationPeek.copyLink')}
    </button>
  )
}

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

import { type FC, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useTranslations } from '@/i18n'
import { useTransientFlag } from '@/hooks/use-transient-flag'
import { citationShareUrl, type CitationRef } from '../lib/citations'
import { COPY_ACTION_CLASSES, CopiedAnnouncement, CopyActionFace } from './CopyCitation'

export const CopyCitationLinkButton: FC<{ citation: CitationRef; icon?: ReactNode }> = ({
  citation,
  icon,
}) => {
  const t = useTranslations('chat')
  const [copied, flashCopied] = useTransientFlag()

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
      flashCopied()
    } catch {
      toast.error(t('answerSources.copyFailed'))
    }
  }

  // The same face as the citation copy beside it: the icon swaps to a check
  // and the label cross-fades in a cell as wide as either, so the receipt no
  // longer reflows the row it sits in.
  return (
    <>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={t('citationPeek.copyLinkAria', { label: citation.document.title })}
        className={COPY_ACTION_CLASSES}
      >
        <CopyActionFace
          copied={copied}
          icon={icon}
          label={t('citationPeek.copyLink')}
          copiedLabel={t('answerSources.copied')}
        />
      </button>
      <CopiedAnnouncement copied={copied} />
    </>
  )
}

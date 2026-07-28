/**
 * Copying a source as a citation somebody can actually use.
 *
 * A link the user has to retype into their Befund is not provenance they can
 * work with. These two affordances hand over a real citation instead:
 *
 *  - `CopySourceCitationButton` — inside a source's preview popover / document
 *    dialog: copies the German Fachtext citation of that one source (the form
 *    an Austrian Einreichung / Gutachten uses).
 *  - `CopyCitationsMenu` — on the block: copies ALL of the answer's sources in
 *    the chosen format — Fachtext, APA, BibTeX, EndNote/Zotero (.ris) or
 *    CSL-JSON, i.e. the formats reference managers and Word actually ingest.
 *
 * The heavy citation renderer (citation-js) is loaded lazily by
 * `renderCitations`, so a chat that never copies never pays for it.
 */

'use client'

import { type FC, useState } from 'react'
import { Check, Copy, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CITATION_FORMATS, renderCitations, type CitationFormat } from '../lib/citation-export'
import { toFachtext } from '../lib/source-citation'
import type { AnswerSourceItem } from '../lib/answer-source-list'

/** Write to the clipboard, reporting failure instead of swallowing it. */
const copyText = async (text: string, onDone: () => void, failedMessage: string): Promise<void> => {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    onDone()
  } catch {
    // Clipboard unavailable or blocked (insecure context, denied permission).
    toast.error(failedMessage)
  }
}

/** Per-row copy: the Fachtext citation of one source. */
export const CopySourceCitationButton: FC<{ item: AnswerSourceItem }> = ({ item }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    await copyText(
      toFachtext(item, new Date()),
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      t('answerSources.copyFailed')
    )
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={t('answerSources.copyCitationAria', { label: item.ref.label })}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[12.5px] font-medium',
        'text-muted-foreground transition-colors hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3" />
      ) : (
        <Copy aria-hidden="true" className="size-3" />
      )}
      {copied ? t('answerSources.copied') : t('answerSources.copyCitation')}
    </button>
  )
}

/** Block-level copy: every source of the answer, in a chosen citation format. */
export const CopyCitationsMenu: FC<{ items: AnswerSourceItem[] }> = ({ items }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (format: CitationFormat): Promise<void> => {
    const text = await renderCitations(items, format, new Date())
    await copyText(
      text,
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      t('answerSources.copyFailed')
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3" />
          ) : (
            <Quote aria-hidden="true" className="size-3" />
          )}
          {t('answerSources.citeAll')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {t('answerSources.citeAsLabel')}
        </DropdownMenuLabel>
        {CITATION_FORMATS.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void handleCopy(format)}>
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px]">{t(`answerSources.formats.${format}.label`)}</span>
              <span className="text-[11px] text-muted-foreground">
                {t(`answerSources.formats.${format}.hint`)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

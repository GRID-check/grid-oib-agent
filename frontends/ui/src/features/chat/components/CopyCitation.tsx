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
import { AnimatePresence, motion, springSnap } from '@/components/motion'
import { cn } from '@/lib/utils'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CITATION_FORMATS, renderCitations, type CitationFormat } from '../lib/citation-export'
import { toFachtext, toQuoteList } from '../lib/source-citation'
import type { CitationRef } from '../lib/citations'

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
export const CopySourceCitationButton: FC<{ citation: CitationRef }> = ({ citation }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (): Promise<void> => {
    await copyText(
      citation.locus?.snippet
        ? toQuoteList([citation], new Date())
        : toFachtext(citation, new Date()),
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
      aria-label={t('answerSources.copyCitationAria', { label: citation.document.title })}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
        'text-muted-foreground transition-[color,transform] duration-quick ease-out active:scale-95 hover:text-foreground',
        'motion-reduce:transition-none motion-reduce:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? 'check' : 'copy'}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={springSnap}
          className="inline-flex"
          aria-hidden="true"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3" />
          ) : (
            <Copy aria-hidden="true" className="size-3" />
          )}
        </motion.span>
      </AnimatePresence>
      {copied ? t('answerSources.copied') : t('answerSources.copyCitation')}
    </button>
  )
}

/** Block-level copy: every source of the answer, in a chosen citation format. */
export const CopyCitationsMenu: FC<{ citations: CitationRef[] }> = ({ citations }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = async (format: CitationFormat): Promise<void> => {
    // Inside the same failure path as the clipboard write: `renderCitations`
    // lazily imports citation-js, and a chunk that fails to load (offline, a
    // deploy in between) used to reject UNHANDLED — the menu just closed and
    // nothing said why nothing was on the clipboard.
    let text: string
    try {
      text = await renderCitations(citations, format, new Date())
    } catch {
      toast.error(t('answerSources.copyFailed'))
      return
    }
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
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-[color,transform] duration-quick ease-out active:scale-95 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch-target motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={copied ? 'check' : 'quote'}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={springSnap}
              className="inline-flex"
              aria-hidden="true"
            >
              {copied ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <Quote aria-hidden="true" className="size-3" />
              )}
            </motion.span>
          </AnimatePresence>
          {t('answerSources.citeAll')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <SectionLabel>{t('answerSources.citeAsLabel')}</SectionLabel>
        </DropdownMenuLabel>
        {CITATION_FORMATS.map((format) => (
          <DropdownMenuItem key={format} onSelect={() => void handleCopy(format)}>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm">{t(`answerSources.formats.${format}.label`)}</span>
              <span className="text-xs text-muted-foreground">
                {t(`answerSources.formats.${format}.hint`)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

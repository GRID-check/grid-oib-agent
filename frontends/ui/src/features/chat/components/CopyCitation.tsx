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

import { type FC, type ReactNode } from 'react'
import { Check, Copy, Quote } from 'lucide-react'
import { toast } from 'sonner'
import { AnimatePresence, motion, useIconSwapTransition } from '@/components/motion'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { SectionLabel } from '@/components/ui/section-label'
import { useTransientFlag } from '@/hooks/use-transient-flag'
import { useTranslations } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemText,
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

/**
 * The quiet text action a copy control is: muted ink that darkens on hover,
 * the shared press, the one focus ring. Under a finger it takes the 44px
 * floor as its own height (`pointer-coarse:min-h-11`) rather than through an
 * invisible `touch-target` overhang, because these sit two or three to a row
 * and overhangs that overlap hand a tap to whichever sibling paints last.
 */
export const COPY_ACTION_CLASSES = cn(
  'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium outline-none',
  'text-muted-foreground hover:text-foreground pointer-coarse:min-h-11',
  PRESSABLE,
  FOCUS_RING
)

/**
 * The inside of a copy control: an icon that swaps to a check, and a label
 * that swaps to „Kopiert" WITHOUT changing the control's width.
 *
 * Both labels sit in one grid cell, so the box is as wide as the longer of the
 * two at rest and in receipt alike: a label that reflowed to its new width
 * nudged every control to its right, twice, for a confirmation the reader only
 * glances at. The labels cross-fade; the icons swap on `iconSwapTransition`
 * (scale on `springSnap`, a small element landing inside that spring's 24px
 * travel budget; opacity on a tween, because opacity never springs).
 */
export const CopyActionFace: FC<{
  copied: boolean
  icon: ReactNode
  label: string
  copiedLabel: string
}> = ({ copied, icon, label, copiedLabel }) => {
  const swap = useIconSwapTransition()
  return (
    <>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? 'check' : 'idle'}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
          exit={{ opacity: 0, scale: 0.6, transition: swap.exit }}
          className="inline-flex"
          aria-hidden="true"
        >
          {copied ? <Check aria-hidden="true" className="size-3" /> : icon}
        </motion.span>
      </AnimatePresence>
      <span className="grid">
        <span
          aria-hidden={copied || undefined}
          className={cn(
            'duration-quick col-start-1 row-start-1 transition-opacity ease-out motion-reduce:transition-none',
            copied && 'opacity-0'
          )}
        >
          {label}
        </span>
        <span
          aria-hidden={!copied || undefined}
          className={cn(
            'duration-quick col-start-1 row-start-1 transition-opacity ease-out motion-reduce:transition-none',
            !copied && 'opacity-0'
          )}
        >
          {copiedLabel}
        </span>
      </span>
    </>
  )
}

/**
 * The receipt a screen reader hears. The visible „Kopiert" lives inside a
 * button whose name is its `aria-label`, so it is never read; this polite
 * status beside the control is. Always mounted, so the region exists before
 * its text changes — a live region that appears with its message is not
 * reliably announced.
 */
export const CopiedAnnouncement: FC<{ copied: boolean }> = ({ copied }) => {
  const t = useTranslations('chat')
  return (
    <span role="status" className="sr-only">
      {copied ? t('answerSources.copied') : ''}
    </span>
  )
}

/** Per-row copy: the Fachtext citation of one source. */
export const CopySourceCitationButton: FC<{ citation: CitationRef }> = ({ citation }) => {
  const t = useTranslations('chat')
  const [copied, flashCopied] = useTransientFlag()

  const handleCopy = async (): Promise<void> => {
    await copyText(
      citation.locus?.snippet
        ? toQuoteList([citation], new Date())
        : toFachtext(citation, new Date()),
      flashCopied,
      t('answerSources.copyFailed')
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleCopy()}
        aria-label={t('answerSources.copyCitationAria', { label: citation.document.title })}
        className={COPY_ACTION_CLASSES}
      >
        <CopyActionFace
          copied={copied}
          icon={<Copy aria-hidden="true" className="size-3" />}
          label={t('answerSources.copyCitation')}
          copiedLabel={t('answerSources.copied')}
        />
      </button>
      <CopiedAnnouncement copied={copied} />
    </>
  )
}

/** Block-level copy: every source of the answer, in a chosen citation format. */
export const CopyCitationsMenu: FC<{ citations: CitationRef[] }> = ({ citations }) => {
  const t = useTranslations('chat')
  const swap = useIconSwapTransition()
  const [copied, flashCopied] = useTransientFlag()

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
    await copyText(text, flashCopied, t('answerSources.copyFailed'))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* The label stays „Alle zitieren": the receipt is the icon's check
            and the announcement, because the copy happened in a menu that has
            already closed and the trigger is what the eye returns to. */}
        <button type="button" className={COPY_ACTION_CLASSES}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={copied ? 'check' : 'quote'}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: swap.enter }}
              exit={{ opacity: 0, scale: 0.6, transition: swap.exit }}
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
            <DropdownMenuItemText
              title={t(`answerSources.formats.${format}.label`)}
              hint={t(`answerSources.formats.${format}.hint`)}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
      <CopiedAnnouncement copied={copied} />
    </DropdownMenu>
  )
}

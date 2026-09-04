'use client'

/**
 * The in-app reader for an Austrian RIS document.
 *
 * A RIS citation was the one source Piloti grounded on and could not SHOW.
 * The chip carried a `ris.bka.gv.at` URL, so it opened a browser tab — and the
 * whole apparatus a reader checks a citation with (the cited passage marked in
 * the text, the copy-as-Zitat action, the answer still on screen behind the
 * dialog) stayed one surface back (#622).
 *
 * It is a TEXT reader rather than an embedded page on purpose. RIS publishes
 * HTML written for its own site; rendering that inside the product would mean
 * either an iframe of a third-party document (which RIS is under no obligation
 * to allow, and which brings its navigation into ours) or sanitising foreign
 * markup on every open. The text is what the answer was grounded on — it is
 * what `ris_fetch_document` read and what the retrieval indexed — so it is also
 * the thing a reader is checking, and it is the one form of the document this
 * product can be sure it is showing faithfully.
 *
 * The authoritative URL is never taken away: RIS is the publication of record,
 * this is a reading copy, and a legal citation must always be able to reach
 * the original.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { locatePassageInText } from '../lib/passage-highlight'

export interface RisDocumentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The RIS URL the citation carries — what is fetched and what is linked to. */
  url: string
  /** Display title from the citation; the fetched document's own title wins. */
  title: string
  /** The cited passage, marked in the text when it can be found. */
  highlight?: string | null
  /** CSS colour for that mark — the tint of the chip that opened the dialog. */
  highlightColor?: string
  /** Provenance chip, rendered before the title (same shape as the PDF viewer). */
  headerChip?: ReactNode
  /** Copy actions, which wrap to their own line on a narrow header. */
  headerActions?: ReactNode
}

interface LoadedDocument {
  url: string
  title: string
  text: string
  truncated: boolean
}

type LoadState =
  { status: 'loading' } | { status: 'ready'; document: LoadedDocument } | { status: 'failed' }

export function RisDocumentDialog({
  open,
  onOpenChange,
  url,
  title,
  highlight,
  highlightColor,
  headerChip,
  headerActions,
}: RisDocumentDialogProps) {
  const t = useTranslations('knowledge')
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const markRef = useRef<HTMLElement | null>(null)

  // Fetched on OPEN, not on mount: a chip that is never clicked costs nothing,
  // which is the same promise the document preview index makes.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ status: 'loading' })
    fetch(`/api/ris/document?reference=${encodeURIComponent(url)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as LoadedDocument
      })
      .then((document) => {
        if (!cancelled) setState({ status: 'ready', document })
      })
      .catch(() => {
        // The outbound link is still in the header, so a failure here costs the
        // reader the reading copy and nothing else. Saying so beats a spinner.
        if (!cancelled) setState({ status: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [open, url])

  const text = state.status === 'ready' ? state.document.text : ''
  // Matched through the SAME normalisation the PDF viewer uses, so a passage
  // that marks in one reader marks in the other.
  const passage = useMemo(
    () => (text && highlight ? locatePassageInText(text, highlight) : null),
    [text, highlight]
  )

  // The reader arrives at the Fundstelle, not at the top of a Gesamtfassung.
  useEffect(() => {
    if (!passage) return
    const frame = requestAnimationFrame(() => markRef.current?.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [passage])

  const heading = (state.status === 'ready' && state.document.title) || title

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90dvh] w-[95vw] max-w-[95vw] flex-col gap-3 p-4 sm:max-w-[95vw] sm:p-5">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {headerChip}
            <span className="min-w-0 flex-1 truncate">{heading}</span>
            {headerActions}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-3 text-xs">
            {t('risViewer.description')}
            <a
              href={state.status === 'ready' ? state.document.url : url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary duration-quick inline-flex items-center gap-1 font-medium transition-opacity ease-out hover:opacity-80"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t('risViewer.openAtRis')}
            </a>
          </DialogDescription>
        </DialogHeader>

        <div className="border-border bg-surface-sunken min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border p-4">
          {state.status === 'loading' && (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
              <Spinner className="size-4" />
              {t('risViewer.loading')}
            </div>
          )}
          {state.status === 'failed' && (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
              <AlertTriangle className="size-5" aria-hidden />
              <p>{t('risViewer.failed')}</p>
            </div>
          )}
          {state.status === 'ready' && (
            <article className="text-foreground mx-auto max-w-[70ch] whitespace-pre-wrap text-sm leading-relaxed">
              {passage ? (
                <>
                  {text.slice(0, passage.start)}
                  <mark
                    ref={markRef}
                    className="rounded-sm px-0.5"
                    style={{
                      backgroundColor: `color-mix(in oklch, ${highlightColor ?? 'var(--foreground)'} 28%, transparent)`,
                      color: 'inherit',
                    }}
                  >
                    {text.slice(passage.start, passage.end)}
                  </mark>
                  {text.slice(passage.end)}
                </>
              ) : (
                text
              )}
              {state.document.truncated && (
                <p className="text-muted-foreground mt-4 border-t pt-3 text-xs">
                  {t('risViewer.truncated')}
                </p>
              )}
            </article>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

'use client'

/**
 * AnswerActions — getting the answer out of Piloti.
 *
 * Two ways out, and only two — the clipboard and the file:
 *
 *   ❞  Antwort mit Quellenangaben       → the prose with its sources written
 *                                        out (clipboard, rich + markdown)
 *   ⧉  Antwort kopieren                 → the prose alone, when the turn
 *                                        resolved no sources to write out
 *   ⤓  Als Word-Dokument               → the export route's .docx, cards and all
 *
 * The copy puts the answer on the clipboard in two flavors at once
 * (`clipboard-rich`): rendered HTML, so Word, Outlook and Notion paste real
 * tables and emphasis, and the markdown source as the plain-text fallback. The
 * internal `[[card:N]]` placement markers are stripped — they mean nothing
 * outside the app. The download hands over the server-built document, which
 * carries what no clipboard copy can: the question, the resolved citations,
 * the cards as tables and the confidence note.
 *
 * EXACTLY ONE of the two copies is rendered, and one of them always is: an
 * answer that finished can always be put on the clipboard. Which one is a fact
 * about the turn's SOURCES and nothing else — with resolved citations the copy
 * writes them out, without them it hands over the prose, because a button that
 * would copy an empty "Quellen" heading is a dead button and this row is not the
 * place to promise provenance an answer does not have.
 *
 * The download is a THIRD thing and never stands in for either. It was once
 * treated as one — the plain copy was withheld from any turn that had an export
 * — which left every uncited answer in a real conversation with a .docx
 * download as its only way out, because a persisted turn always has an export.
 * A Rückfrage, a conversational reply, an answer whose citations were all
 * dropped: none of them could be copied. Downloading a Word document is not
 * copying a sentence into an e-mail.
 *
 * ── Weight ───────────────────────────────────────────────────────────────────
 * This sits in the answer's meta row, beside the feedback thumbs, so it
 * borrows their language exactly: 24px ghost icon buttons, muted ink at rest,
 * full contrast on hover/focus, no band and no divider of its own. Confirmation
 * is the Check-swap `CopyCitation` already uses — no toast on success, and the
 * error path is that component's `toast.error`, not a new mechanism.
 *
 * Each glyph carries a tooltip with the same words as its `aria-label`. Two
 * unlabelled 14px icons in a row read as one control with two states, so the
 * quote mark on the first is the difference made visible: the sources come
 * along.
 */

import { useCallback, useState, type FC } from 'react'
import { BookMarked, Check, Copy, FileDown } from 'lucide-react'
import { toast } from 'sonner'
import { AnimatePresence, motion, springSnap } from '@/components/motion'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { copyMarkdownToClipboard } from '@/shared/utils/clipboard-rich'
import { startBrowserDownload } from '@/lib/browser-download'
import {
  answerMarkdown,
  answerMarkdownWithSources,
  hasCopyableSources,
} from '../lib/answer-markdown'
import type { CitedDocument } from '../lib/citations'

export interface AnswerActionsProps {
  /**
   * The answer markdown exactly as the agent wrote it — its own written sources
   * section included. This is what "Antwort kopieren" hands over.
   */
  content: string
  /**
   * The same answer with its written sources section already lifted out
   * (`splitAnswerBody`). The resolved-citations copy appends its own list, so
   * pasting it must not state the sources twice.
   */
  body: string
  /**
   * The turn's citation model, derived ONCE by the answer and passed in. The
   * resolved sources list is a projection of it — never a second parse of the
   * markdown.
   */
  documents: CitedDocument[]
  /**
   * Where the .docx export lives:
   * `/api/conversations/{conversationId}/messages/{messageId}/export`. Both
   * halves are required — a local-only turn that has neither gets no download
   * button rather than a dead one (the diagram-filing rule).
   */
  conversationId?: string | null
  messageId?: string
  className?: string
}

/** Which button is currently showing its Check. */
type Copied = 'plain' | 'withSources' | null

/**
 * The buttons. Same 24px glyph, muted ink and `touch-target` as the feedback
 * thumbs next to them — a footnote affordance that does not compete with the
 * answer above it.
 */
const actionButton = cn(
  'inline-flex size-6 items-center justify-center rounded-md',
  'text-muted-foreground/70 transition-[color,transform] duration-snap ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
  'hover:bg-accent hover:text-foreground',
  'touch-target',
  FOCUS_RING
)

export const AnswerActions: FC<AnswerActionsProps> = ({
  content,
  body,
  documents,
  conversationId,
  messageId,
  className,
}) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState<Copied>(null)
  const [exporting, setExporting] = useState(false)

  const copy = useCallback(
    async (text: string, which: Exclude<Copied, null>): Promise<void> => {
      if (!text.trim()) return
      try {
        // Both flavors: rendered HTML for Word/Outlook/Notion, the markdown
        // source as the plain-text fallback — see `clipboard-rich`.
        await copyMarkdownToClipboard(text)
        setCopied(which)
        window.setTimeout(() => setCopied(null), 1500)
      } catch {
        // Clipboard unavailable or blocked (insecure context, denied permission).
        toast.error(t('answerActions.copyFailed'))
      }
    },
    [t]
  )

  /**
   * The .docx the export route builds for this answer — question, citations,
   * cards and confidence included, which no clipboard copy carries. Fetched
   * rather than navigated to, so a failure (a turn the server never persisted,
   * access lost meanwhile) is a toast instead of a JSON error filling a tab.
   */
  const handleDownloadDocx = useCallback(async (): Promise<void> => {
    if (!conversationId || !messageId || exporting) return
    setExporting(true)
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/export`
      )
      if (!response.ok) throw new Error(`export failed: ${response.status}`)
      const blob = await response.blob()
      const filename =
        /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
        'piloti.docx'
      const url = URL.createObjectURL(blob)
      try {
        startBrowserDownload(url, filename)
      } finally {
        // The download has the blob by reference; the URL itself can go on the
        // next tick without cutting it off.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch {
      toast.error(t('answerActions.downloadFailed'))
    } finally {
      setExporting(false)
    }
  }, [conversationId, messageId, exporting, t])

  const handleCopyAnswer = useCallback((): void => {
    void copy(answerMarkdown(content), 'plain')
  }, [copy, content])

  const handleCopyWithSources = useCallback((): void => {
    void copy(
      answerMarkdownWithSources(body, documents, {
        heading: t('answerActions.sourcesHeading'),
        page: (page) => t('answerSources.page', { page }),
        pages: (pages) => t('answerSources.pages', { pages: pages.join(', ') }),
        untitled: t('answerActions.untitledSource'),
      }),
      'withSources'
    )
  }, [copy, body, documents, t])

  const withSources = hasCopyableSources(documents)
  const canExport = Boolean(conversationId && messageId)
  // The two copies are exclusive and exhaustive: sources decide WHICH, never
  // whether. The export is orthogonal and cannot stand in for either.
  const showPlainCopy = !withSources
  const copyLabel = copied === 'plain' ? t('answerActions.copied') : t('answerActions.copy')
  const copyWithSourcesLabel =
    copied === 'withSources' ? t('answerActions.copied') : t('answerActions.copyWithSources')
  const downloadLabel = t('answerActions.downloadDocx')

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {showPlainCopy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopyAnswer}
              aria-label={copyLabel}
              className={actionButton}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={copied === 'plain' ? 'check' : 'copy'}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={springSnap}
                  className="inline-flex"
                  aria-hidden="true"
                >
                  {copied === 'plain' ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5" aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
          </TooltipTrigger>
          <TooltipContent>{copyLabel}</TooltipContent>
        </Tooltip>
      )}
      {withSources && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleCopyWithSources}
              aria-label={copyWithSourcesLabel}
              className={actionButton}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={copied === 'withSources' ? 'check' : 'copy'}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={springSnap}
                  className="inline-flex"
                  aria-hidden="true"
                >
                  {copied === 'withSources' ? (
                    <Check className="size-3.5" aria-hidden="true" />
                  ) : (
                    <BookMarked className="size-3.5" aria-hidden="true" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
          </TooltipTrigger>
          <TooltipContent>{copyWithSourcesLabel}</TooltipContent>
        </Tooltip>
      )}
      {canExport && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => void handleDownloadDocx()}
              disabled={exporting}
              aria-busy={exporting || undefined}
              aria-label={downloadLabel}
              className={cn(actionButton, exporting && 'cursor-progress opacity-50')}
            >
              <FileDown className="size-3.5" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{downloadLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

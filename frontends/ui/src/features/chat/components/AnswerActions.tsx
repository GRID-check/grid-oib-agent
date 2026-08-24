'use client'

/**
 * AnswerActions — getting the answer out of Piloti.
 *
 * The user's own question has had a copy button since the beginning; the ANSWER
 * — the thing that goes into a Prüfvermerk, a mail, an Einreichung — had none,
 * so the only way out was a mouse drag that lost the `[N]` numbering and the
 * structure on the way. These two buttons are that way out.
 *
 *   ⧉  Antwort kopieren                 → the markdown the answer was written in
 *   ☰  Antwort mit Quellenangaben       → the same prose, sources written out
 *
 * Both put MARKDOWN on the clipboard, not the rendered DOM text: the markdown
 * keeps the numbering, the tables and the emphasis, and Word, Notion and every
 * mail client paste it cleanly. The internal `[[card:N]]` placement markers are
 * stripped — they mean nothing outside the app.
 *
 * The second button is only rendered when the turn actually resolved sources. A
 * button that would copy an empty "Quellen" heading is a dead button, and this
 * row is not the place to promise provenance an answer does not have.
 *
 * ── Weight ───────────────────────────────────────────────────────────────────
 * This sits in the answer's merged meta row, beside the feedback thumbs, so it
 * borrows their language exactly: 24px ghost icon buttons, muted ink at rest,
 * full contrast on hover/focus, no band and no divider of its own. Confirmation
 * is the Check-swap `CopyCitation` already uses — no toast on success, and the
 * error path is that component's `toast.error`, not a new mechanism.
 */

import { useCallback, useState, type FC } from 'react'
import { Check, ClipboardList, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
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
  className?: string
}

/** Which button is currently showing its Check. */
type Copied = 'answer' | 'withSources' | null

/**
 * The buttons. Same 24px glyph, muted ink and `touch-target` as the feedback
 * thumbs next to them — a footnote affordance that does not compete with the
 * answer above it.
 */
const actionButton = cn(
  'inline-flex size-6 items-center justify-center rounded-md',
  'text-muted-foreground/70 transition-colors duration-quick ease-out motion-reduce:transition-none',
  'hover:bg-accent hover:text-foreground',
  'touch-target',
  FOCUS_RING
)

export const AnswerActions: FC<AnswerActionsProps> = ({ content, body, documents, className }) => {
  const t = useTranslations('chat')
  const [copied, setCopied] = useState<Copied>(null)

  const copy = useCallback(
    async (text: string, which: Exclude<Copied, null>): Promise<void> => {
      if (!text.trim()) return
      try {
        await navigator.clipboard.writeText(text)
        setCopied(which)
        window.setTimeout(() => setCopied(null), 1500)
      } catch {
        // Clipboard unavailable or blocked (insecure context, denied permission).
        toast.error(t('answerActions.copyFailed'))
      }
    },
    [t]
  )

  const handleCopyAnswer = useCallback((): void => {
    void copy(answerMarkdown(content), 'answer')
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

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <button
        type="button"
        onClick={handleCopyAnswer}
        aria-label={copied === 'answer' ? t('answerActions.copied') : t('answerActions.copy')}
        className={actionButton}
      >
        {copied === 'answer' ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
      {withSources && (
        <button
          type="button"
          onClick={handleCopyWithSources}
          aria-label={
            copied === 'withSources'
              ? t('answerActions.copied')
              : t('answerActions.copyWithSources')
          }
          className={actionButton}
        >
          {copied === 'withSources' ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <ClipboardList className="size-3.5" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  )
}

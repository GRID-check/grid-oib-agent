'use client'

/**
 * „Mit Piloti besprechen" — the ONE control that opens a conversation with
 * Piloti about a document. It was „Besprechen" for a while, which named the
 * gesture and not the colleague it is with; beside „Kollegin fragen" a reader
 * could not tell which of the two buttons talks to Piloti.
 *
 * ## Why it is one component and one label
 *
 * The gesture existed already, three times over and under two names: the
 * document pane's rail drew „Piloti dazu fragen" (and greyed it out for exactly
 * the documents this feature is for), the report card drew nothing, and the
 * inbox row drew nothing. Three call sites of one intention is how a label and
 * a behaviour drift apart on the first retune, so the intention has one
 * component and one dictionary key (`files.assignment.discuss`) and every
 * surface composes it.
 *
 * ## It creates nothing
 *
 * There is no second conversation-creation path here. Both branches below land
 * on the file-native ask the product already has — a chat URL carrying
 * `?new=1&doc=<id>&file=<name>`, which the project chat client reads into a
 * composer subject with `resourceType: 'document'` and which the BFF persists
 * as `conversations.subjectResourceType/subjectResourceId` on the first send.
 *
 * The branch is about the FILE VIEWER, not about the conversation:
 *
 *   - Given the whole `FileItem` (the pane, which is already showing the
 *     document), it goes through `askAboutFile`, which hands the open preview
 *     across the navigation so the file does not blink out at the click.
 *   - Given only ids (the report card, the inbox row), there is no preview to
 *     hand over and it navigates. The chat client resolves the document from
 *     `?doc=` and opens the peek itself.
 *
 * ## Never disabled
 *
 * The old rail gated Ask on `isCitable`, which is false for every document
 * Piloti wrote and for every version a person has not published — the documents
 * a reader most wants to talk about. That gate was true when a turn could only
 * reach a document through the retrieval index; it stopped being true when the
 * turn learned to read an unpublished version's bytes into the conversation's
 * working directory (ADR-0054, and `turn/subject_document.py`). What survives
 * of it is `hint`: a document that is not in the knowledge base can still be
 * discussed, and the reader is told which of the two they are getting.
 */

import type { JSX } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { FileItem } from './project-file-workspace'
import { askAboutFile } from '../lib/ask-about-file'
import { documentQuestionHref } from '../lib/document-question'

export interface DiscussDocumentButtonProps {
  projectId: string
  documentId: string
  /** The stored file name, when the caller knows it — retrieval identity. */
  filename?: string | null
  /**
   * The pane's own row. Present, the open preview is handed across the
   * navigation instead of closing at the click.
   */
  file?: FileItem
  /** Hover/AT text saying something true about this document, when there is any. */
  hint?: string
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'sm' | 'default'
  /** Icon-led, for a dense row (the inbox) where the label alone reads as chrome. */
  withIcon?: boolean
  /**
   * The icon alone below `sm`, the label kept for assistive technology: a
   * phone row with three labelled buttons wraps them onto three lines.
   */
  iconOnlyOnPhone?: boolean
  /** Told just before the navigation, for a caller that counts it as opening something (the inbox row marks itself read). */
  onNavigate?: () => void
  className?: string
}

export function DiscussDocumentButton({
  projectId,
  documentId,
  filename,
  file,
  hint,
  variant = 'default',
  size = 'sm',
  withIcon = false,
  iconOnlyOnPhone = false,
  onNavigate,
  className,
}: DiscussDocumentButtonProps): JSX.Element {
  const t = useTranslations('files')
  const router = useRouter()

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn('h-8', className)}
      title={hint}
      aria-label={iconOnlyOnPhone ? t('assignment.discuss') : undefined}
      data-testid="discuss-document"
      onClick={() => {
        onNavigate?.()
        const navigate = (href: string): void => router.push(href)
        if (file) {
          askAboutFile({ projectId, file, navigate })
          return
        }
        navigate(
          documentQuestionHref(projectId, documentId, filename ? { filename } : {}),
        )
      }}
    >
      {/* Sparkles is Piloti's glyph across the rail („Von Piloti gelesen“), so
          the button that talks to Piloti carries it too. */}
      {(withIcon || iconOnlyOnPhone) && <Sparkles className="size-3.5" aria-hidden />}
      {iconOnlyOnPhone ? <span className="max-sm:hidden">{t('assignment.discuss')}</span> : t('assignment.discuss')}
    </Button>
  )
}

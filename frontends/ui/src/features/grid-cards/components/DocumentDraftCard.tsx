'use client'

/**
 * DocumentDraftCard — a document Piloti wrote, reported where it was written.
 *
 * System-emitted: the working directory's `write_file` / `edit_file` pushes the
 * card (`aiq_agent/tools/documents/cards.py`), the same way `remember` pushes a
 * `memory_proposal`. The model cannot fabricate one, so the card names a file
 * that exists — which is what lets it be this plain. There is nothing to
 * resolve, nothing to fetch and nothing that can turn out to be missing.
 *
 * ## What it must NOT say
 *
 * A draft is not a project document. It is not filed, not indexed, not citable,
 * and it is not on the Files page — it lives in this conversation's working
 * directory and nowhere else. So the card borrows the FILE idiom (a name, a
 * path, a size, the „Von Piloti erstellt" byline the Files grid puts under an
 * agent-authored document) without borrowing the file CARD: a `FileCard` here
 * would read as a row of the Files pane, which is the one claim that would be
 * wrong. The byline is deliberately the same component and the same words as
 * the Files feature (`documents/components/authorship-line.tsx`) — a file
 * should say who wrote it the same way everywhere in the product.
 *
 * ## The action is inert, and that is this slice
 *
 * „Ins Projekt übernehmen" is the one thing a reader will want, and the filing
 * path it will call is the document lifecycle API, which is not wired yet. It
 * is drawn disabled rather than hidden: the card's whole point is that a draft
 * is one step away from being a document, and a card that says so while
 * offering nothing at all reads as a dead end rather than as a next step. When
 * the filing slice lands, this control gets its `onClick` — and the card's line
 * in `CARD_INTERACTIVITY` moves to `'interactive'`, because filing IS a write.
 *
 * Quiet ink, not a `Button`, and the style is `diagram-filing-controls`': a
 * filled control here would outweigh the draft's own name two lines above it,
 * and this is the same kind of secondary action in the same kind of meta row.
 */

import { type FC } from 'react'
import { FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { AuthorshipLine } from '@/features/documents/components/authorship-line'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CARD_SHELL } from './card-chrome'

interface DocumentDraftCardProps {
  /** The document's first heading, or its file name when it has none. */
  title: string
  /** Path in the working directory, e.g. `/entwuerfe/aktenvermerk.md`. */
  path: string
  /** Size of the draft as stored, in UTF-8 bytes. */
  bytes: number
  /** How often this path has been written or edited in this conversation. */
  version: number
}

/**
 * The inert action's look — `diagram-filing-controls.tsx`'s `CONTROL` plus the
 * disabled treatment that file's own button carries while it cannot file.
 *
 * `min-h-11` is kept although nothing can be pressed yet: it is the design
 * language's Fitts floor for a control that behaves like a link, and keeping it
 * now means the row does not change height on the day the control goes live.
 */
const INERT_ACTION =
  'inline-flex min-h-11 cursor-not-allowed items-center rounded-sm font-medium text-primary opacity-60'

export const DocumentDraftCard: FC<DocumentDraftCardProps> = ({ title, path, bytes, version }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()

  return (
    <Card data-testid="document-draft-card" className={cn(CARD_SHELL, 'gap-2 p-5')}>
      <SectionLabel icon={FileText}>{t('cards.documentDraft.eyebrow')}</SectionLabel>

      <div className="flex min-w-0 flex-col">
        {/* `title` on both lines: the working directory's paths are the model's
            own words and are regularly longer than the thread column, so the
            clip has to leave the whole string reachable. */}
        <p className="card-title truncate text-foreground" title={title}>
          {title}
        </p>
        <p className="card-caption truncate font-mono text-muted-foreground" title={path}>
          {path}
        </p>
        {/* Provenance, in the Files feature's own component and words. Passed a
            literal here rather than a column: every card of this type is a
            document the agent wrote — that is what emits it. */}
        <AuthorshipLine authoredBy="agent" className="mt-0.5" />
      </div>

      {/* The facts and the action on one line, in that order — the diagram
          card's meta row, for the same reason: what the card KNOWS outranks
          what it offers, and a control on a line of its own reads as a hole in
          a card this small.
          A real `disabled` button, not a span dressed as one: the assistive
          reading („dimmed", „unavailable") is the honest one, and the control
          the next slice wires is then the element that is already here. */}
      <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
        <span className="flex items-center gap-x-2">
          <span className="tabular-nums">{t('cards.documentDraft.version', { version })}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span className="tabular-nums">{formatBytes(bytes, locale)}</span>
        </span>
        <button type="button" disabled className={INERT_ACTION}>
          {t('cards.documentDraft.file')}
        </button>
      </p>
    </Card>
  )
}

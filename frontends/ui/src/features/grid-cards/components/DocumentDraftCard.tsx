'use client'

/**
 * DocumentDraftCard — a document Piloti wrote, and what can be done with it.
 *
 * System-emitted: the working directory's `write_file` / `edit_file` pushes the
 * card (`aiq_agent/tools/documents/cards.py`), the same way `remember` pushes a
 * `memory_proposal`, and `file_draft` pushes it again once the draft has become
 * a project document. The model cannot fabricate one, so the card names a file
 * that exists — which is what lets it be this plain.
 *
 * ## Two states, and one honest control each
 *
 * **Unfiled** the draft lives in this conversation and nowhere else: not filed,
 * not indexed, not citable, not on the Files page. So the card borrows the FILE
 * idiom (a name, a path, a size, the „Von Piloti erstellt" byline the Files grid
 * puts under an agent-authored document) without borrowing the file CARD — a
 * `FileCard` here would read as a row of the Files pane, the one claim that
 * would be wrong.
 *
 * **Filed** it names a `documents` row and an open version, and the two things a
 * reader wants become real: opening it, and sending it for approval.
 *
 * ## Why „Ins Projekt übernehmen" asks Piloti instead of filing here
 *
 * The obvious build is the wrong one: have this button create the document
 * through the lifecycle client, the way `FileOperationProposalCard`'s Accept
 * runs its moves. Three things stop it, and they compound.
 *
 * 1. **The bytes are not here.** The draft lives in the agent's working
 *    directory (a LangGraph store on the Python service's own database), and no
 *    route exposes it to the browser. The markdown would have to RIDE on the
 *    card — and a card is persisted on the message, in `metadata.cards` and in
 *    localStorage, so every stored turn would carry a copy of a document that
 *    may be 50 KB. The card is a report of a file, not a second copy of it.
 * 2. **There is no route to create it.** The lifecycle API's public surface
 *    starts at a document that already exists (`forkDraft(documentId)`);
 *    creating the ITEM is `fileAgentDocumentDraft`, reached by the agent's one
 *    internal route. Adding a second door to it for the browser is exactly what
 *    ADR-0055 forbids — one primitive, one HTTP surface, no service function on
 *    two paths.
 * 3. **The path that exists is better.** `file_draft` files in the requesting
 *    person's PINNED session, under their permissions and their audit actor
 *    (ADR-0054 §4). Asking Piloti is therefore not a workaround for a missing
 *    button; it is the same gate, reached the way the product already works.
 *
 * So the unfiled control prefills the composer with the sentence that files it,
 * exactly as a follow-up chip does, and the person presses send. It writes
 * nothing, which is why it is not the reason this card is `'interactive'`.
 *
 * ## What IS interactive
 *
 * „Zur Freigabe einreichen", on a filed card. That is a real write through
 * `documentLifecycleClient.submit` — the same route the Files pane's own control
 * calls — and it is not idempotent: it moves the version to `in_review` and
 * opens an inbox item on a reviewer. The outcome is recorded through
 * `useCardDecision` so a reload does not ask a colleague a second time.
 *
 * Quiet ink, not a `Button`, and the style is `diagram-filing-controls`': a
 * filled control here would outweigh the draft's own name two lines above it,
 * and this is the same kind of secondary action in the same kind of meta row.
 */

import { useState, type FC } from 'react'
import { FileText } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { AuthorshipLine } from '@/features/documents/components/authorship-line'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { openFiledDocument } from '@/features/documents/lib/open-filed-document'
import { useChatStore } from '@/features/chat/store'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLocale, useTranslations } from '@/i18n'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useCardDecision } from '../hooks/use-card-decision'
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
  /** The project document this draft was filed as; absent while it is unfiled. */
  documentId?: string | null
  /** The open version of that document — what „einreichen" acts on. */
  versionId?: string | null
  /** That version's editorial state, as the lifecycle API last reported it. */
  versionState?: DocumentVersionState | null
  messageId?: string
  cardKey: string
  decisionsMustPersist?: boolean
}

/**
 * The action row's ink — `diagram-filing-controls.tsx`'s `CONTROL`. `min-h-11`
 * is the design language's Fitts floor for a control that behaves like a link.
 */
const ACTION = cn(
  'inline-flex min-h-11 items-center rounded-sm font-medium text-primary',
  'transition-colors duration-quick ease-out motion-reduce:transition-none',
  'hover:text-primary/80 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-2',
  'disabled:cursor-not-allowed disabled:opacity-60',
)

/**
 * The states in which the reader may still send the draft for approval — the
 * `submit` rows of the lifecycle's transition table. Everything else is a state
 * a PERSON has already set, and the card reports it instead of offering a
 * control that would be refused.
 */
const SUBMITTABLE: ReadonlySet<DocumentVersionState> = new Set(['draft', 'changes_requested'])

/** The one-word state line for a version nobody may act on from here. */
const STATE_LABEL: Partial<Record<DocumentVersionState, string>> = {
  in_review: 'inReview',
  changes_requested: 'changesRequested',
  approved: 'approved',
  published: 'published',
  superseded: 'published',
  rejected: 'changesRequested',
}

export const DocumentDraftCard: FC<DocumentDraftCardProps> = ({
  title,
  path,
  bytes,
  version,
  documentId,
  versionId,
  versionState,
  messageId,
  cardKey,
  decisionsMustPersist,
}) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const projectId = useChatStore((s) => s.projectId)
  const isMobile = useIsMobile()
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A filed card needs the project to link into the Files pane; a chat with no
  // project could not have filed in the first place, so this is belt-and-braces
  // rather than a state the product reaches.
  const filed = Boolean(documentId && versionId && versionState)
  const href = documentId && projectId ? documentFilesHref(projectId, documentId) : null
  // The decision outlives the card's own payload: a reload replays the stored
  // `submitted` against a card that still says `draft`, because the card is the
  // frame the turn emitted and is never rewritten.
  const submitted = decision === 'submitted' || (versionState ? !SUBMITTABLE.has(versionState) : false)

  const submit = async () => {
    if (!documentId || !versionId) return
    setError(null)
    setIsSubmitting(true)
    try {
      await documentLifecycleClient.submit(documentId, versionId)
      decide('submitted')
    } catch {
      setError(t('cards.documentDraft.error'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const stateKey = versionState ? STATE_LABEL[versionState] : undefined

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

      {/* The facts and the actions on one line, in that order — the diagram
          card's meta row, for the same reason: what the card KNOWS outranks what
          it offers, and a control on a line of its own reads as a hole in a card
          this small. */}
      <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
        <span className="flex items-center gap-x-2">
          <span className="tabular-nums">{t('cards.documentDraft.version', { version })}</span>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span className="tabular-nums">{formatBytes(bytes, locale)}</span>
          {filed && (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span data-testid="document-draft-state">
                {submitted && stateKey
                  ? t(`cards.documentDraft.${stateKey}` as 'cards.documentDraft.inReview')
                  : t('cards.documentDraft.filed')}
              </span>
            </>
          )}
        </span>

        {!filed && (
          // Writes nothing: it puts the request in the composer and the person
          // sends it. See the header for why filing cannot happen here.
          <button
            type="button"
            className={ACTION}
            onClick={() => setComposerPrefill(t('cards.documentDraft.fileRequest'))}
          >
            {t('cards.documentDraft.file')}
          </button>
        )}

        {filed && href && documentId && (
          // A real link, intercepted — the same control the diagram fence uses
          // (`diagram-filing-controls.tsx`), through the same
          // `openFiledDocument`. Middle click, „copy link address" and a phone
          // still get the Files route; a desktop click gets the document in the
          // pane BESIDE the conversation, because a reader who just had Piloti
          // write something should not have to leave the thread to look at it.
          <a
            href={href}
            className={ACTION}
            data-testid="document-draft-open"
            onClick={(event) => {
              if (isMobile || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              void openFiledDocument({ documentId, projectId: projectId as string }).then((opened) => {
                if (!opened) window.location.assign(href)
              })
            }}
          >
            {t('cards.documentDraft.open')}
          </a>
        )}

        {filed && !submitted && canDecide && (
          <button type="button" className={ACTION} disabled={isSubmitting} onClick={submit}>
            {isSubmitting ? t('cards.documentDraft.submitting') : t('cards.documentDraft.submit')}
          </button>
        )}
      </p>

      {error && (
        <p className="card-caption text-destructive" data-testid="document-draft-error">
          {error}
        </p>
      )}
    </Card>
  )
}

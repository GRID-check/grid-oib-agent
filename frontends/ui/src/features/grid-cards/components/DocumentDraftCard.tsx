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
  * idiom (a name, a path, a stand, the „Von Piloti erstellt" byline the Files grid
  * puts under an agent-authored document) without borrowing the file CARD — a
 * `FileCard` here would read as a row of the Files pane, the one claim that
 * would be wrong.
 *
 * **Filed** it names a `documents` row and an open version, and the two things a
 * reader wants become real: opening it, and sending it for approval.
 *
 * ## Why „Ins Projekt ablegen" files here instead of asking Piloti
 *
 * The bytes live in the agent's working directory, and the BFF's read doors
 * put them in the browser's reach: `GET /api/conversations/[id]/draft?path=…`
 * proxies exactly that one conversation's drafts for a reader who may see it
 * (which is also what the preview below reads through). The old "no route
 * exposes bytes" objection is gone with that door, so the button files
 * DIRECTLY — `POST /api/conversations/[id]/draft/file` reads the draft with
 * the internal token and creates the project document through
 * `fileAgentDocumentDraft`, the EXISTING internal op, in the reader's own
 * session, under their permissions and their audit actor (ADR-0054 §4). No
 * new primitive, no second door (ADR-0055): the browser and the agent's
 * `file_draft` converge on one document through the shared
 * `{conversationId}-{slug}` reference, whichever of the two files first.
 *
 * A same-name document the reference does not own is a 409, and the card
 * answers it with an explicit „Trotzdem ablegen" confirmation (`force`) —
 * never by versioning onto an unrelated document.
 *
 * Reading, like filing, happens here: the unfiled card offers „Entwurf
 * ansehen" beside the file action — a markdown reading surface
 * (`DocumentDraftPreviewDialog`, via `FileTextPage` directly, never through
 * `FilePreviewPane`, which needs a `documents` row that does not exist). It
 * writes nothing, which is why it is not the reason this card is
 * `'interactive'`.
 *
 * ## What IS interactive
 *
 * Filing („Ins Projekt ablegen", on an unfiled card) and „Zur Freigabe
 * einreichen" (on a filed one). Filing is a real write through the BFF's
 * draft-file door and idempotent by reference, but its `filed` outcome is
 * still recorded through `useCardDecision` — a reload must not present a
 * filed draft as unfiled. Submitting moves the version to `in_review` and
 * opens an inbox item on a reviewer, and is not idempotent at all: the
 * outcome is recorded so a reload does not ask a colleague a second time.
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
import { useTranslations } from '@/i18n'
import { documentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import { cn } from '@/lib/utils'
import { useCardDecision } from '../hooks/use-card-decision'
import { DraftFileError, fileConversationDraft } from '../lib/document-draft-filing'
import { fetchConversationDraft } from '../lib/document-draft-preview'
import { CARD_SHELL } from './card-chrome'
import { DocumentDraftPreviewDialog } from './DocumentDraftPreviewDialog'

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
  // Its own key, not `published`: a superseded version is read, but it is no
  // longer the stand — reporting it as published would claim it still is.
  superseded: 'ersetzt',
  rejected: 'changesRequested',
}

/**
 * The existing row a same-name 409 carries, or null for every other refusal.
 *
 * Narrowed by hand rather than parsed: the shape is the route's `details`
 * envelope, and a 409 without a row is still a refusal the card must render
 * as a retryable error rather than crash on.
 */
function conflictRow(error: unknown): { documentId: string; displayName: string } | null {
  if (!(error instanceof DraftFileError) || error.status !== 409) return null
  const details = error.details
  if (typeof details !== 'object' || details === null) return null
  const { reason, documentId, displayName } = details as {
    reason?: unknown
    documentId?: unknown
    displayName?: unknown
  }
  return reason === 'same-name' && typeof documentId === 'string' && typeof displayName === 'string'
    ? { documentId, displayName }
    : null
}

/** A 409 that is not a same-name veto: the reference filed and left the writing states. */
function isAlreadySubmitted(error: unknown): boolean {
  if (!(error instanceof DraftFileError) || error.status !== 409) return false
  const details = error.details
  if (typeof details !== 'object' || details === null) return false
  return (details as { reason?: unknown }).reason === 'already-submitted'
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
  const projectId = useChatStore((s) => s.projectId)
  const conversationId = useChatStore((s) => s.currentConversation?.id ?? null)
  const isMobile = useIsMobile()
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isFiling, setIsFiling] = useState(false)
  // The document THIS press filed. The props still say unfiled — the card is
  // the frame the turn emitted and is never rewritten — so the open link below
  // reads these ids until a re-emitted card carries them itself.
  const [filedDoc, setFiledDoc] = useState<{ documentId: string; versionId: string } | null>(null)
  // A same-name 409, waiting on the reader's explicit confirmation.
  const [conflict, setConflict] = useState<{ documentId: string; displayName: string } | null>(null)
  // The preview's view state — what is open, what arrived, what failed. Local
  // `useState`, never a `CardInteraction`: opening a read starts no commitment
  // (`card-decision.ts`), so there is nothing to remember across a reload.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)

  // A filed card needs the project to link into the Files pane; a chat with no
  // project could not have filed in the first place, so this is belt-and-braces
  // rather than a state the product reaches.
  const filed = Boolean(documentId && versionId && versionState)
  // What the filed blocks show: the turn's own row when Piloti filed, the ids
  // this press got back when the reader did. One of them is always the row the
  // reference owns — filing never versions onto an unrelated document.
  const shownDocumentId = documentId ?? filedDoc?.documentId ?? null
  const shownFiled = filed || filedDoc !== null
  const href = shownDocumentId && projectId ? documentFilesHref(projectId, shownDocumentId) : null
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

  // The stand, in words. A filed card reports the version's state; an unfiled
  // one is a draft by definition — and a single write is no history, so the
  // counter in the row below appears only past the first write.
  const stand =
    filed && submitted && stateKey
      ? t(`cards.documentDraft.${stateKey}` as 'cards.documentDraft.inReview')
      : shownFiled
        ? t('cards.documentDraft.filed')
        : t('cards.documentDraft.draftState')

  // Files the draft into the project, in the reader's own session. Idempotent
  // by reference: a press after Piloti already filed (or after this press)
  // returns the same document with `alreadyFiled` rather than a second one. A
  // same-name 409 parks in `conflict` for the explicit confirmation below;
  // every other refusal is an actionable message with the file button still
  // offered as the retry. The `filed` outcome is recorded through
  // `useCardDecision` like `submitted` — record-only, because a
  // `CardInteraction` carries no document id and the link above reads this
  // mount's ids.
  const file = async (force: boolean) => {
    if (!conversationId) return
    setError(null)
    if (!force) setConflict(null)
    setIsFiling(true)
    try {
      const result = await fileConversationDraft(conversationId, { path, title, force })
      setFiledDoc({ documentId: result.documentId, versionId: result.versionId })
      setConflict(null)
      decide('filed')
    } catch (fileError) {
      const row = conflictRow(fileError)
      if (row && !force) {
        setConflict(row)
      } else if (isAlreadySubmitted(fileError)) {
        // Nothing to retry and nothing to confirm: the reference filed and a
        // person moved it on. The Files pane owns it from here.
        setError(t('cards.documentDraft.fileSubmitted'))
      } else {
        setError(t('cards.documentDraft.fileError'))
      }
    } finally {
      setIsFiling(false)
    }
  }

  // Reads the draft through the BFF preview door into the dialog. Runs on open
  // and on retry — never on mount, so a card the reader never looks at costs
  // no request.
  const loadPreview = async () => {
    if (!conversationId) return
    setPreviewLoading(true)
    setPreviewFailed(false)
    try {
      const draft = await fetchConversationDraft(conversationId, path)
      setPreviewContent(draft.content)
    } catch {
      setPreviewFailed(true)
      setPreviewContent(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  const openPreview = () => {
    setPreviewOpen(true)
    void loadPreview()
  }

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

      {/* The stand and the actions on one line, in that order — the diagram
          card's meta row, for the same reason: what the card KNOWS outranks what
          it offers, and a control on a line of its own reads as a hole in a card
          this small. The size is not here at all: it lives in the preview
          dialog, beside the words it measures. */}
      <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
        <span className="flex items-center gap-x-2">
          <span data-testid="document-draft-state">{stand}</span>
          {/* One write is no history: the counter appears only once the path
              has been written again, after the stand it numbers. */}
          {version > 1 && (
            <>
              <span aria-hidden className="text-muted-foreground/40">
                ·
              </span>
              <span className="tabular-nums">{t('cards.documentDraft.version', { version })}</span>
            </>
          )}
        </span>

        {!shownFiled && conversationId && (
          // Reads nothing but the draft, through the BFF preview door into the
          // dialog below. Presentational view state — see the header.
          <button type="button" className={ACTION} onClick={openPreview}>
            {t('cards.documentDraft.preview')}
          </button>
        )}

        {!shownFiled && canDecide && conversationId && (
          // Files the draft in the reader's own session — see the header.
          // Hidden where the answer could not be kept (`canDecide`): a filing
          // whose outcome dies on reload would file twice behind one press.
          <button
            type="button"
            className={ACTION}
            disabled={isFiling}
            onClick={() => void file(false)}
          >
            {isFiling ? t('cards.documentDraft.filing') : t('cards.documentDraft.file')}
          </button>
        )}

        {shownFiled && href && shownDocumentId && (
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
              void openFiledDocument({ documentId: shownDocumentId, projectId: projectId as string }).then((opened) => {
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

      {conflict && !shownFiled && (
        // The same-name veto, answered explicitly: the row it names, and the
        // confirmation that files beside it. Pressing the file action above
        // retries instead and clears this — the way back is never only here.
        <div className="flex flex-col gap-1" data-testid="document-draft-conflict">
          <p className="card-caption text-muted-foreground">{t('cards.documentDraft.fileConflict')}</p>
          <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
            {projectId && (
              <a
                href={documentFilesHref(projectId, conflict.documentId)}
                className={ACTION}
                data-testid="document-draft-conflict-open"
              >
                {conflict.displayName}
              </a>
            )}
            <button
              type="button"
              className={ACTION}
              disabled={isFiling}
              onClick={() => void file(true)}
            >
              {isFiling ? t('cards.documentDraft.filing') : t('cards.documentDraft.fileAnyway')}
            </button>
          </p>
        </div>
      )}

      {!shownFiled && conversationId && (
        <DocumentDraftPreviewDialog
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          title={title}
          path={path}
          version={version}
          bytes={bytes}
          content={previewContent}
          loading={previewLoading}
          failed={previewFailed}
          onRetry={() => void loadPreview()}
        />
      )}
    </Card>
  )
}

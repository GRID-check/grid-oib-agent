'use client'

/**
 * FileOperationProposalCard — the workspace change the agent proposed.
 *
 * One component for four verbs, switching on `operation`, because the four
 * differ in exactly one line: what each row of the proposal SAYS. Everything
 * else — the proposal shell, the pending/accepted/dismissed lifecycle, the
 * persisted decision, the partial-failure report — is the same object four
 * times over, and four components would be four places to fix the fifth bug.
 *
 * System-emitted (`aiq_agent/tools/files/`): the model cannot author one, so
 * every file named here is a file the tool resolved against the reader's own
 * inventory. What it must not claim is the change itself — the backend has no
 * path into `grid_app` (ADR-0003), so until this card is accepted nothing has
 * happened at all, and the tool result told the model so in those words.
 *
 * ## Why the outcome is per row
 *
 * A card can carry several operations of one kind („räum die
 * Einreichunterlagen zusammen" is four moves). They are applied in order and
 * each one's result is kept, so a card whose third move failed says three
 * moved and one did not, with the reason — rather than „übernommen", which
 * would be a lie about one file, or „fehlgeschlagen", which would be a lie
 * about three.
 *
 * ## How a decision lands
 *
 * Each row carries a status slot from the first paint, empty while the card
 * waits, so a row's ✓ or ✗ arrives without moving its text. The rows say what
 * happened first, and the card changes state one beat later
 * ({@link ROW_BEAT_MS}): watched together they were one jump, and the reader
 * never saw which file had moved. The busy button keeps its width (both labels
 * are stacked in one cell) and its focus (`aria-disabled`, never `disabled`:
 * Chrome blurs a focused button the moment it becomes disabled).
 */

import { useEffect, useRef, useState } from 'react'
import { Check, FolderTree, X } from 'lucide-react'
import { motion, motionDeliberate, useIconSwapTransition } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { useCardDecision } from '../hooks/use-card-decision'
import {
  applyFileOperations,
  operationLabel,
  type FileOperationItem,
  type FileOperationKind,
  type FileOperationResult,
} from '../lib/file-operations'
import { ProposalShell } from './ProposalShell'
import { StackedLabel } from './StackedLabel'

/** How long the rows' verdicts stand before the card takes its decided state. */
const ROW_BEAT_MS = (motionDeliberate.duration ?? 0) * 1000

interface FileOperationProposalCardProps {
  title: string
  operation: FileOperationKind
  operations: FileOperationItem[]
  note?: string | null
  /** Message this card belongs to — keys its persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /** Whether this surface requires the answer to be persisted. */
  decisionsMustPersist?: boolean
}

/** The project root has no path to print; it has a name the reader knows. */
const folderText = (path: string | null | undefined, rootLabel: string): string =>
  path && path.trim() ? path : rootLabel

/**
 * One row: what this operation does, in the operation's own words.
 *
 * Rendered as „from → to" wherever there IS a from — the reader is deciding
 * about a change, and a change the card only states the destination of asks
 * them to remember where the file is now.
 */
function OperationRow({
  operation,
  item,
  result,
}: {
  operation: FileOperationKind
  item: FileOperationItem
  result?: FileOperationResult
}) {
  const t = useTranslations('chat')
  const root = t('cards.fileOperationProposal.root')

  const subject =
    operation === 'create_folder' ? folderText(item.folder_name, root) : (item.document ?? '')
  const target =
    operation === 'move'
      ? folderText(item.target_folder, root)
      : operation === 'rename'
        ? (item.new_display_name ?? '')
        : operation === 'assign'
          ? (item.member ?? '')
          : folderText(item.parent_folder, root)
  const from = operation === 'move' ? folderText(item.current, root) : ''

  return (
    <li
      className="card-caption text-foreground flex items-baseline gap-x-1.5"
      data-testid="file-operation-row"
    >
      <RowStatus result={result} />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium" title={subject}>
          {subject}
        </span>
        {from ? (
          <span className="text-muted-foreground">
            {from} <span aria-hidden>→</span>{' '}
          </span>
        ) : (
          <span aria-hidden className="text-muted-foreground">
            →
          </span>
        )}
        <span className="text-muted-foreground min-w-0 truncate" title={target}>
          {target}
        </span>
        {result && !result.ok && (
          <span className="text-destructive" data-testid="file-operation-row-error">
            {result.reason}
          </span>
        )}
      </span>
    </li>
  )
}

/**
 * A row's verdict, in a slot that is there before it: the check pops in as an
 * icon swap (scale on the snap spring, opacity on a tween), a failure is a quiet ✗ beside the reason the row prints.
 */
function RowStatus({ result }: { result?: FileOperationResult }) {
  const swap = useIconSwapTransition()
  const Icon = result ? (result.ok ? Check : X) : null
  return (
    <span className="inline-flex size-3.5 shrink-0 self-center" aria-hidden>
      {Icon && (
        <motion.span
          className={result?.ok ? 'text-success' : 'text-destructive'}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
          data-testid={result?.ok ? 'file-operation-row-ok' : 'file-operation-row-failed'}
        >
          <Icon className="size-3.5" />
        </motion.span>
      )}
    </span>
  )
}

export function FileOperationProposalCard({
  title,
  operation,
  operations,
  note,
  messageId,
  cardKey,
  decisionsMustPersist,
}: FileOperationProposalCardProps) {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [results, setResults] = useState<FileOperationResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Why this card cannot be applied here, if it cannot. STATED rather than
  // drawn as an absence: a card that shows a proposal and offers nothing, with
  // no line saying why, reads as one that failed to load. One case is left —
  // every route behind this card is project-scoped, and a chat can have no
  // project.
  const unavailable = projectId ? undefined : ('noProject' as const)
  const failed = results?.filter((result) => !result.ok) ?? []

  // The decision the rows are announcing, recorded after the beat. Held in a
  // ref so an unmount during the beat records it at once instead of dropping
  // it: the writes have happened, and a reload must not offer them again.
  const pendingDecision = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      pendingDecision.current?.()
    },
    []
  )

  const accept = async () => {
    if (!projectId || isSubmitting) return
    setError(null)
    setIsSubmitting(true)
    try {
      const applied = await applyFileOperations(operation, operations, projectId)
      setResults(applied)
      const failures = applied.filter((result) => !result.ok).length
      if (failures === applied.length) {
        // Nothing was applied, so nothing was decided: the card stays pending
        // and the reader can press again once the cause is gone.
        setIsSubmitting(false)
        setError(t('cards.fileOperationProposal.error'))
        return
      }
      const record = (): void => {
        pendingDecision.current = null
        decide(failures > 0 ? 'partiallyApplied' : 'accepted')
        setIsSubmitting(false)
      }
      pendingDecision.current = record
      window.setTimeout(() => pendingDecision.current?.(), ROW_BEAT_MS)
    } catch {
      setIsSubmitting(false)
      setError(t('cards.fileOperationProposal.error'))
    }
  }

  if (decision === 'accepted' || decision === 'partiallyApplied') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-foreground text-sm">
          {decision === 'accepted'
            ? t(`cards.fileOperationProposal.applied.${operation}`, { count: operations.length })
            : t('cards.fileOperationProposal.partial')}
        </p>
        {failed.length > 0 && (
          <ul className="flex flex-col gap-1" data-testid="file-operation-failures">
            {failed.map((result, index) => (
              <li key={`${result.label}-${index}`} className="card-caption text-muted-foreground">
                {result.label} — {result.reason}
              </li>
            ))}
          </ul>
        )}
      </ProposalShell>
    )
  }

  if (decision === 'rejected') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-muted-foreground text-sm">
          {t('cards.fileOperationProposal.dismissed')}
        </p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <SectionLabel icon={FolderTree}>
        {t(`cards.fileOperationProposal.eyebrow.${operation}`)}
      </SectionLabel>

      <p className="text-foreground text-sm font-semibold">{title}</p>

      <ul className="flex flex-col gap-1" data-testid="file-operation-rows">
        {operations.map((item, index) => (
          <OperationRow
            key={`${operationLabel(operation, item)}-${index}`}
            operation={operation}
            item={item}
            result={results?.[index]}
          />
        ))}
      </ul>

      {note && <p className="card-caption text-muted-foreground">{note}</p>}

      {/* A chat with no project. The proposal still READS, and the reason
          stands where the buttons would be, so the card is unavailable rather
          than broken. */}
      {unavailable && (
        <p className="card-caption text-muted-foreground" data-testid="file-operation-unavailable">
          {t(`cards.fileOperationProposal.unavailable.${unavailable}`)}
        </p>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Nothing to press where the answer could not be kept (`canDecide`) or
          where there is nothing to press it against (`unavailable`, which
          includes a chat with no project: every route behind this card is
          project-scoped).

          `flex-wrap` on the row is not decoration: at 390px „Übernehmen?" and
          the two buttons do not fit on one line, and a non-wrapping row put the
          question UNDER the primary button — the one place a reader must be
          able to read what they are answering. Wrapped, the question takes its
          own line and the pair stays right-aligned beneath it. */}
      {canDecide && !unavailable && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="text-muted-foreground mr-auto text-sm">
            {t('cards.fileOperationProposal.prompt')}
          </p>
          <Button
            type="button"
            size="sm"
            onClick={() => void accept()}
            aria-disabled={isSubmitting || undefined}
            aria-busy={isSubmitting || undefined}
            className="aria-disabled:cursor-default"
          >
            <StackedLabel
              busy={isSubmitting}
              idle={t('cards.fileOperationProposal.accept')}
              working={t('cards.fileOperationProposal.applying')}
            />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (isSubmitting) return
              setError(null)
              decide('rejected')
            }}
            aria-disabled={isSubmitting || undefined}
            className="aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            {t('cards.fileOperationProposal.reject')}
          </Button>
        </div>
      )}
    </ProposalShell>
  )
}

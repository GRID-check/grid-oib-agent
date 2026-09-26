'use client'

/**
 * A run's message in the thread: the block, and the report beneath it once
 * there is one (ADR-0062, PR 2 design).
 *
 * The message-list dispatch (`ChatArea`) sends every assistant message that
 * carries a `runLedger` here instead of to the answer renderer. This component
 * owns two decisions and nothing else:
 *
 *   - which ledger the block renders from — `useRunLedger`: the stored one,
 *     replaced by the run's own stream while it is live;
 *   - whether the message's content is shown yet. The content IS the report,
 *     and it renders as today's answer card BELOW the block, so the reader gets
 *     the same sources and Herleitung a chat answer has. It appears once the
 *     run has produced it: `fertig`, and `unterbrochen` too, because that
 *     sentence says the report was written from what was there — hiding it
 *     would contradict the block's own words.
 *
 * The answer element is BUILT by the caller and handed in. The prop mapping
 * from a `ChatMessage` onto `AgentResponse` is thirty lines that exist once in
 * `ChatArea`; a second copy here would drift on the first added prop.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, motionEntrance, motionInstant } from '@/components/motion'
import type { ChatMessage } from '@/features/chat/types'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import type { RunStatus } from '@/lib/runs/run-ledger-types'
import { runDisplayStatus } from '@/lib/runs/run-vocabulary'
import { useRunLedger } from '../hooks/use-run-ledger'
import { DocumentPickerDialog } from '@/features/documents/components/document-picker/DocumentPickerDialog'
import { useDocumentLibrary } from '@/features/documents/hooks/use-document-library'
import { useTranslations } from '@/i18n'
import { foldName } from '@/lib/text/fold'
import { RunPlan } from './RunPlan'
import { usePlan } from '../hooks/use-plan'
import { useLayoutStore } from '@/features/layout/store'
import { openFilePeek } from '@/features/documents/lib/open-file-peek'
import type { RunLedgerDoc } from '@/lib/runs/run-ledger-types'
import { landingDelays } from '../lib/choreography'
import { RunBlock } from './RunBlock'

/** The states in which the message's content is a report the reader may have. */
const REPORT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['fertig', 'unterbrochen'])

export interface RunBlockMessageProps {
  message: ChatMessage
  /** The project the run belongs to; without one the block is static. */
  projectId?: string | null
  /** The thread the message is in; lets a status change reach the stored message. */
  conversationId?: string | null
  /** The report as the caller renders an answer. Shown only once the run has one. */
  answer?: ReactNode
  /** „Bericht fortschreiben", when the thread can commission a run. */
  onContinue?: (() => void | Promise<void>) | null
}

export function RunBlockMessage({
  message,
  projectId,
  conversationId,
  answer,
  onContinue,
}: RunBlockMessageProps): JSX.Element | null {
  const { ledger, live, cancel, writeNow, addDocument, connection } = useRunLedger({
    message,
    projectId,
    conversationId,
  })
  const reduced = useReducedMotion()
  // The picker for „Unterlage hinzufügen", and the reader behind a receipt
  // chip: both dialogs over the thread, and both read the same listing, which
  // is fetched only once one of them is wanted.
  const [picking, setPicking] = useState(false)
  const [wantsInventory, setWantsInventory] = useState(false)
  const inventory = useDocumentLibrary(projectId ?? null, wantsInventory)
  const t = useTranslations('runs')
  const named = new Set((ledger?.grundlage ?? []).map((doc) => foldName(doc.name)))
  const plan = usePlan(projectId ?? null, message.planId ?? null)
  const availableSources = useLayoutStore((state) => state.availableDataSources)
  const rahmen = plan.plan?.dataSources
    ? {
        labels: plan.plan.dataSources.map(
          (id) => (availableSources ?? []).find((source) => source.id === id)?.name ?? id
        ),
      }
    : undefined
  // A chip clicked before the listing has arrived is remembered and opened
  // once it does; otherwise the first click on a finished run would do nothing.
  const [pendingDoc, setPendingDoc] = useState<RunLedgerDoc | null>(null)
  const openDocument = useCallback((doc: RunLedgerDoc): void => {
    setWantsInventory(true)
    setPendingDoc(doc)
  }, [])
  useEffect(() => {
    if (!pendingDoc || !inventory.documents) return
    setPendingDoc(null)
    const key = foldName(pendingDoc.name)
    const found = inventory.documents.find((row) => foldName(row.name) === key)
    if (!found) return
    openFilePeek({
      file: found.file,
      source: found.shelf === 'archiv' ? 'buero' : 'projekt',
      projectId: projectId ?? null,
      presentation: 'modal',
      bindComposerSubject: false,
    })
  }, [pendingDoc, inventory.documents, projectId])
  // A report that arrives while the reader is watching rises AFTER the block
  // has finished saying how the run ended: the verdict first, the document
  // second. A thread scrolled back to weeks later has both at once — nothing
  // happened just now, so nothing should look as though it did.
  const paintedRef = useRef(false)
  useEffect(() => {
    paintedRef.current = true
  }, [])

  if (!ledger) return null

  const status = runDisplayStatus(ledger)
  const showAnswer = REPORT_STATUSES.has(status) && message.content.trim().length > 0
  const rises = paintedRef.current && !reduced

  return (
    <div className="flex flex-col gap-3" data-testid="run-block-message" data-run-id={ledger.runId}>
      <RunBlock
        ledger={ledger}
        title={message.runTitle ?? null}
        projectId={projectId ?? null}
        live={live}
        connection={connection}
        onCancel={cancel}
        onWriteNow={writeNow}
        onAddDocument={
          addDocument
            ? () => {
                setWantsInventory(true)
                setPicking(true)
              }
            : null
        }
        onOpenDocument={projectId ? openDocument : null}
        onContinue={onContinue ?? null}
        plan={
          plan.plan ? (
            <RunPlan
              plan={plan.plan}
              rahmen={rahmen}
              projectId={projectId ?? null}
              pending={plan.pending}
              onEdit={plan.edit}
              onHold={plan.hold}
              onStart={plan.start}
            />
          ) : null
        }
      />
      {addDocument && (
        <DocumentPickerDialog
          open={picking}
          onOpenChange={setPicking}
          title={t('unterlagen.addTitle')}
          description={t('unterlagen.addDescription')}
          documents={inventory.documents ?? []}
          folders={inventory.folders}
          loading={inventory.loading}
          disabledReason={(doc) => (named.has(foldName(doc.name)) ? t('unterlagen.alreadyNamed') : null)}
          confirmLabel={t('unterlagen.add')}
          onConfirm={(docs) => {
            for (const { name, title, shelf } of docs) void addDocument({ name, ...(title ? { title } : {}), shelf })
          }}
        />
      )}
      {showAnswer ? (
        <motion.div
          initial={rises ? { opacity: 0, y: 6 } : false}
          animate={{
            opacity: 1,
            y: 0,
            transition: rises
              ? { ...motionEntrance, delay: landingDelays(status).report }
              : motionInstant,
          }}
          data-testid="run-report"
        >
          {answer}
        </motion.div>
      ) : null}
    </div>
  )
}

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

import type { ReactNode } from 'react'
import type { ChatMessage } from '@/features/chat/types'
import type { RunStatus } from '@/lib/runs/run-ledger-types'
import { runDisplayStatus } from '@/lib/runs/run-vocabulary'
import { useRunLedger } from '../hooks/use-run-ledger'
import { RunBlock } from './RunBlock'

/** The states in which the message's content is a report the reader may have. */
const REPORT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['fertig', 'unterbrochen'])

export interface RunBlockMessageProps {
  message: ChatMessage
  /** The project the run belongs to; without one the block is static. */
  projectId?: string | null
  /** The report as the caller renders an answer. Shown only once the run has one. */
  answer?: ReactNode
}

export function RunBlockMessage({ message, projectId, answer }: RunBlockMessageProps): JSX.Element | null {
  const { ledger, live } = useRunLedger({ message, projectId })
  if (!ledger) return null

  const status = runDisplayStatus(ledger)
  const showAnswer = REPORT_STATUSES.has(status) && message.content.trim().length > 0

  return (
    <div className="flex flex-col gap-3" data-testid="run-block-message" data-run-id={ledger.runId}>
      <RunBlock
        ledger={ledger}
        title={message.runTitle ?? null}
        projectId={projectId ?? null}
        live={live}
      />
      {showAnswer ? answer : null}
    </div>
  )
}

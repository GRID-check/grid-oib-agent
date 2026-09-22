/**
 * Session Activity Utilities
 *
 * Pure functions that derive a session's activity from PERSISTED data, so the
 * answers survive a reload: they read the conversation's message list, never
 * an ephemeral store field.
 *
 * A deep-research run is a message in its thread (ADR-0062) and the run's
 * ledger is the account of it, so "is a run going here" is a question about
 * the stored ledgers. While the tab is open the run block keeps the stored
 * ledger current (`features/runs/hooks/use-run-ledger`); on a reload the
 * server's copy is the one that lands.
 */

import { isLiveStatus, runDisplayStatus } from '@/lib/runs/run-vocabulary'
import type { ChatMessage } from '../types'

/**
 * True when the user has never sent a typed chat message in this session.
 * Non-user message types (status, agent_response, etc.) do not count.
 */
export const hasNoUserChatMessages = (messages: ChatMessage[]): boolean =>
  !messages.some((message) => message.messageType === 'user')

/** The run messages of a thread, in thread order. */
export const runMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => Boolean(message.runLedger))

/** A run in this thread is still doing, or waiting for, something. */
export const hasLiveRun = (messages: ChatMessage[]): boolean =>
  messages.some(
    (message) => message.runLedger && isLiveStatus(runDisplayStatus(message.runLedger))
  )

/** The thread's run messages whose ledger says the run is still live. */
export const liveRunMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter(
    (message) => message.runLedger && isLiveStatus(runDisplayStatus(message.runLedger))
  )

/** A run in this thread finished with a report. */
export const hasFinishedRun = (messages: ChatMessage[]): boolean =>
  messages.some((message) => message.runLedger && runDisplayStatus(message.runLedger) === 'fertig')

/**
 * What a run commissioned from inside a thread is briefed with.
 *
 * Pure functions over the thread, so the briefs are testable without a store:
 * the question a run answers, and the context it starts from — a finding's
 * own words, or the previous report's findings for a Fortschreibung.
 */

import type { ChatMessage } from '@/features/chat/types'
import type { Finding, Findings } from '@/lib/conversations/message-findings'

export interface RunBrief {
  question: string
  context?: string
}

const STATUS_WORD: Record<Finding['status'], string> = {
  erfuellt: 'erfüllt',
  nicht_erfuellt: 'nicht erfüllt',
  offen: 'offen',
  nicht_anwendbar: 'nicht anwendbar',
}

const findingLine = (finding: Finding): string => {
  const parts = [finding.requirement]
  if (finding.value) parts.push(finding.value)
  parts.push(STATUS_WORD[finding.status])
  if (finding.reference) {
    parts.push([finding.reference.document, finding.reference.section].filter(Boolean).join(' '))
  }
  return `- ${parts.join(' — ')}${finding.comment ? ` (${finding.comment})` : ''}`
}

/** The brief for clearing one open finding. */
export function findingBrief(finding: Finding): RunBrief {
  const question = `Klären: ${finding.requirement}`
  const context = [
    'Offener Befund aus dem letzten Bericht:',
    findingLine(finding),
    'Ermitteln Sie, was den Befund entscheidet, und schreiben Sie ihn mit Wert, Fundstelle und Status fort.',
  ].join('\n')
  return { question, context }
}

/** The brief for carrying a finished report forward. */
export function continuationBrief(message: ChatMessage): RunBrief {
  const title = message.runTitle?.trim() || 'Bericht'
  const question = `Fortschreibung: ${title}`
  const lines = message.findings?.items.map(findingLine) ?? []
  const context = [
    'Fortschreibung des bisherigen Berichts. Bisherige Befunde:',
    ...(lines.length > 0 ? lines : ['(keine Befundliste vorhanden)']),
    'Prüfen Sie jeden Befund gegen den aktuellen Projektstand, kennzeichnen Sie, was sich geändert hat, und schließen Sie offene Punkte, wo die Quellen es erlauben.',
  ].join('\n')
  return { question, context }
}

/**
 * The findings of the most recent earlier run in the same thread, for the
 * change marks — the thread is the record of a subject's runs, so the
 * comparison needs no column.
 */
export function previousRunFindings(
  messages: readonly ChatMessage[],
  messageId: string
): Findings | undefined {
  const index = messages.findIndex((message) => message.id === messageId)
  for (let i = (index === -1 ? messages.length : index) - 1; i >= 0; i--) {
    const candidate = messages[i]
    if (candidate?.runLedger && candidate.findings) return candidate.findings
  }
  return undefined
}

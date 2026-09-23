/**
 * What a run commissioned from inside a thread is briefed with.
 *
 * Pure functions over the thread, so the briefs are testable without a store:
 * the question a run answers, and the context it starts from — a finding's
 * own words, or the previous report's findings for a Fortschreibung.
 */

import type { ChatMessage } from '@/features/chat/types'
import type { Finding, Findings, FindingStatus } from '@/lib/conversations/message-findings'
import {
  MAX_PLAN_DOCUMENTS,
  type PlanDocument,
  type PlanDocuments,
} from '@/lib/runs/plan-documents'
import type { CreatePlanInput } from '@/lib/plans/plan-client'
import {
  MAX_PLAN_INVENTORY_ROWS,
  MAX_PLAN_QUESTION_CHARS,
  MAX_PLAN_TITLE_CHARS,
  type ResearchPlan,
} from '@/lib/plans/plan-types'

export interface RunBrief {
  question: string
  context?: string
  /** The Unterlagen the run starts from: a continuation reads what the last report read. */
  documents?: PlanDocuments
}

const STATUS_WORD: Record<FindingStatus, string> = {
  erfuellt: 'erfüllt',
  nicht_erfuellt: 'nicht erfüllt',
  offen: 'offen',
  nicht_anwendbar: 'nicht anwendbar',
}

const findingLine = (finding: Finding): string => {
  const parts = [finding.requirement]
  if (finding.value) parts.push(finding.value)
  if (finding.status) parts.push(STATUS_WORD[finding.status])
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

/**
 * The office's own documents the last report drew on, as the next run's
 * Grundlage: what was read once is read again, in full, so a Fortschreibung
 * starts from the same paper and not from a fresh search. Regulations and
 * the web are not documents to name — the run finds them on its own.
 */
export function reportDocuments(message: ChatMessage): PlanDocument[] {
  const out: PlanDocument[] = []
  const seen = new Set<string>()
  for (const source of message.citations ?? []) {
    if (source.shelf !== 'project' && source.shelf !== 'archiv') continue
    const name = source.fileName?.trim()
    if (!name) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key) || out.length >= MAX_PLAN_DOCUMENTS) continue
    seen.add(key)
    const title = source.title?.trim()
    out.push({ name, ...(title && title !== name ? { title } : {}), shelf: source.shelf })
  }
  return out
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
  const grundlage = reportDocuments(message)
  return grundlage.length > 0
    ? { question, context, documents: { grundlage, ausgeschlossen: [] } }
    : { question, context }
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

/**
 * A continuation as a plan (ADR-0065): the last run's plan carried forward —
 * its sections, genre, depth, Rahmen and exclusions — with the report's cited
 * documents added to its Grundlage and the earlier findings as context. It is
 * proposed with a countdown, so the new block shows it and the reader may
 * adjust it, or not.
 */
export function continuationPlan(
  brief: RunBrief,
  previous: ResearchPlan,
  conversationId: string
): CreatePlanInput {
  const cited = brief.documents?.grundlage ?? []
  const grundlage = [...previous.grundlage.map((doc) => doc.name), ...cited.map((doc) => doc.name)].filter(
    (name, index, all) => all.findIndex((other) => other.toLocaleLowerCase() === name.toLocaleLowerCase()) === index
  )
  const unterlagen = [...previous.unterlagen, ...cited].filter(
    (doc, index, all) => all.findIndex((other) => other.name === doc.name) === index
  )
  return {
    conversationId,
    question: brief.question.slice(0, MAX_PLAN_QUESTION_CHARS),
    title: `Fortschreibung: ${previous.title}`.slice(0, MAX_PLAN_TITLE_CHARS),
    sections: [...previous.sections],
    genre: previous.genre,
    depth: previous.depth,
    grundlage: grundlage.slice(0, MAX_PLAN_DOCUMENTS),
    ausgeschlossen: previous.ausgeschlossen.map((doc) => doc.name),
    // A plan confined to its documents stays confined; the cited ones join them.
    nurGrundlage: previous.nurGrundlage,
    dataSources: previous.dataSources,
    unterlagen: unterlagen.slice(0, MAX_PLAN_INVENTORY_ROWS),
    ...(brief.context ? { context: brief.context } : {}),
    countdown: true,
  }
}

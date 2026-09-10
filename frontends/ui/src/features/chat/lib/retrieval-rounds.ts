/**
 * Retrieval ROUNDS for the Herleitung spine.
 *
 * The live line replaces: `status:retrieval:0` is overwritten by
 * `status:retrieval:1` the moment the model searches again. The graph needs
 * the opposite — every round kept, in order — so a second search is a new
 * layer, not a mutated caption.
 *
 * A round is a checkpoint: what the model concluded, the tools it called
 * because of that, and the files that fetch actually returned. The query in
 * `values` stays on the live line; the graph never draws it (PF-12).
 *
 * Files belong to a round by the `round` stamp the backend puts on each
 * Trace-Lanes hit. The store merges every `knowledge_search` completion onto
 * one step keyed by function name, so stream order cannot tell two fetches
 * apart — both payloads land on the same step after `status:retrieval:1`.
 * Unstamped hits (web/RIS URL scan, older payloads) still fall back to
 * stream order. Requery (`status:retrieval:requery`) is not a round.
 */

import { isStatusStepName, turnEventOf, type TurnEventStep } from './turn-events'
import { extractTraceLanesFromPayload } from './trace-lanes'
import { normalizeFileName, type CitedDocument } from './citations/model'

/** A thinking step as the round walker needs it — payload or already-hoisted lanes. */
export type RoundStep = TurnEventStep & {
  traceLanes?: Array<{ sources: Array<{ name?: string; round?: number }> }>
}

export interface RetrievalRound {
  index: number
  key: string
  values?: Record<string, string>
  /** Model's own checkpoint sentence. Absent when Thought was skipped. */
  reason?: string
  /** Tool basenames this round called, in call order, unique. */
  tools: string[]
  /** Hit names (filenames / hosts) this round's tools returned. */
  sourceNames: string[]
}

const RETRIEVAL_SLOT = /^status:retrieval:(\d+)$/i

const slotName = (functionName: string): string =>
  (functionName || '').trim().replace(/^tool:\s*/i, '')

const retrievalIndex = (functionName: string): number | null => {
  const match = RETRIEVAL_SLOT.exec(slotName(functionName))
  if (!match) return null
  const index = Number(match[1])
  return Number.isFinite(index) ? index : null
}

type SourceHit = { name: string; round?: number }

const sourceHitsOf = (step: RoundStep): SourceHit[] => {
  if (isStatusStepName(step.functionName || '')) return []
  const hits: SourceHit[] = []
  const lanes =
    step.traceLanes && step.traceLanes.length > 0
      ? step.traceLanes
      : extractTraceLanesFromPayload([step.content, step.rawPayload].filter(Boolean).join('\n'))
  for (const lane of lanes) {
    for (const source of lane.sources) {
      const name = source.name?.trim()
      if (!name) continue
      hits.push(
        typeof source.round === 'number' && Number.isFinite(source.round)
          ? { name, round: source.round }
          : { name }
      )
    }
  }
  return hits
}

const appendNames = (round: RetrievalRound, names: string[]): void => {
  if (names.length === 0) return
  const seen = new Set(round.sourceNames.map((n) => n.toLowerCase()))
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    round.sourceNames.push(name)
  }
}

/** Ordered retrieval rounds that actually spoke (live key + values). */
export const retrievalRounds = (steps: RoundStep[]): RetrievalRound[] => {
  const byIndex = new Map<number, RetrievalRound>()
  for (const step of steps) {
    const index = retrievalIndex(step.functionName || '')
    if (index === null) continue
    const event = turnEventOf(step)
    if (!event) continue
    const key = event.key?.trim()
    if (!key) continue
    const existing = byIndex.get(index)
    const tools = event.tools ?? existing?.tools ?? []
    byIndex.set(index, {
      index,
      key,
      ...(event.values ? { values: event.values } : existing?.values ? { values: existing.values } : {}),
      ...(event.reason ? { reason: event.reason } : existing?.reason ? { reason: existing.reason } : {}),
      tools: [...new Set(tools)],
      sourceNames: existing?.sourceNames ?? [],
    })
  }

  for (const step of steps) {
    for (const hit of sourceHitsOf(step)) {
      if (hit.round === undefined) continue
      const round = byIndex.get(hit.round)
      if (!round) continue
      appendNames(round, [hit.name])
    }
  }

  let current: number | undefined
  for (const step of steps) {
    const index = retrievalIndex(step.functionName || '')
    if (index !== null) {
      current = index
      continue
    }
    if (current === undefined) continue
    const round = byIndex.get(current)
    if (!round) continue
    appendNames(
      round,
      sourceHitsOf(step)
        .filter((hit) => hit.round === undefined)
        .map((hit) => hit.name)
    )
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

const cardKey = (card: CitedDocument): string =>
  normalizeFileName(card.fileName) || normalizeFileName(card.title) || normalizeFileName(card.id)

/** The documents this round's fetch actually returned, in card order. */
export const documentsForRound = (round: RetrievalRound, cards: CitedDocument[]): CitedDocument[] => {
  if (round.sourceNames.length === 0) return []
  const wanted = new Set(round.sourceNames.map((name) => normalizeFileName(name)).filter(Boolean))
  return cards.filter((card) => {
    const keys = [cardKey(card), normalizeFileName(card.fileName), normalizeFileName(card.title)].filter(Boolean)
    return keys.some((key) => wanted.has(key))
  })
}

/**
 * Cards no round claimed. They stay in the citation model ("Belegt durch");
 * the spine does not pretend the last fetch returned them.
 */
export const unassignedDocuments = (rounds: RetrievalRound[], cards: CitedDocument[]): CitedDocument[] => {
  const claimed = new Set(
    rounds.flatMap((round) => documentsForRound(round, cards).map((card) => card.id))
  )
  return cards.filter((card) => !claimed.has(card.id))
}

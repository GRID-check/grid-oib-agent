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

import type { RetrievalLedger, RetrievalLedgerEntry } from '@/lib/conversations/message-retrieval-ledger'
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

/** Every normalised name a card answers to, most specific first. */
const cardKeys = (card: CitedDocument): string[] =>
  [cardKey(card), normalizeFileName(card.fileName), normalizeFileName(card.title)].filter(Boolean)

/** The documents this round's fetch actually returned, in card order. */
export const documentsForRound = (round: RetrievalRound, cards: CitedDocument[]): CitedDocument[] => {
  if (round.sourceNames.length === 0) return []
  const wanted = new Set(round.sourceNames.map((name) => normalizeFileName(name)).filter(Boolean))
  return cards.filter((card) => cardKeys(card).some((key) => wanted.has(key)))
}

/** First card per normalised name — the lookup a ledger doc resolves through. */
const cardsByName = (cards: CitedDocument[]): Map<string, CitedDocument> => {
  const index = new Map<string, CitedDocument>()
  for (const card of cards) {
    for (const key of cardKeys(card)) if (!index.has(key)) index.set(key, card)
  }
  return index
}

/** One passage THIS round read of one document, when the ledger accounts for the round. */
export interface RoundLocus {
  /**
   * The page / Punkt THIS round read, as the backend stated it — `p.12` or
   * `Pkt. 3.1`, rendered verbatim and never parsed. Absent when the round
   * named none: the turn aggregate is never borrowed in its place, because
   * that is the very conflation the ledger exists to end.
   */
  detail?: string
  /** The round fetched this passage a second time, as the backend stated it. */
  repeat: boolean
}

/**
 * One slot in the fan under a round: one DOCUMENT, with every passage that
 * round read of it.
 *
 * Without a ledger a slot is just a card, exactly as before. With one, the slot
 * is the LEDGER's document: the same turn-level card (so the chip, the preview
 * and the citation markers behave identically) plus the loci that round reached
 * in it. A ledger doc the card model has no card for — the answer-repair pass,
 * or a name the model dropped — keeps its slot and renders bare.
 *
 * Folding by document is the point. One slot per (document, Punkt) drew five
 * opens of one Richtlinie as five identical cards, which is the shape a reader
 * cannot tell from five re-fetches.
 */
export interface FanCard {
  /** Unique within the fan — one per document the round returned. */
  key: string
  /** The turn-level card this slot stands for, when there is one. */
  card?: CitedDocument
  /** The ledger's own name for the document; the label of a bare slot. */
  name: string
  /** The ledger's display title, when it carried one. */
  title?: string
  /**
   * Present only for a ledger-backed slot: every passage THIS round read of
   * this document, in the order the round returned them. Never empty.
   */
  loci?: RoundLocus[]
}

/** A slot under construction — `loci` is the array the fold pushes onto. */
type LedgerSlot = FanCard & { loci: RoundLocus[] }

/** The fold key for "same document": the card key, else the bare name. */
const foldKey = (name: string): string => normalizeFileName(name) || name.trim().toLowerCase()

/**
 * The fan of a ledger round: one slot per DOCUMENT that round returned, in
 * first-seen order, carrying the loci it read in each.
 *
 * The `repeat` verdict is the backend's, per passage: only that side sees
 * every earlier round. A turn stored before the backend stamped it falls back
 * to `newDocs`, which is the same verdict at document granularity — every
 * locus of a document agrees, because that is all the older wire could say.
 */
export const ledgerFan = (entry: RetrievalLedgerEntry, cards: CitedDocument[]): FanCard[] => {
  const index = cardsByName(cards)
  const fresh = new Set(entry.newDocs.map((name) => normalizeFileName(name)).filter(Boolean))
  const slots = new Map<string, LedgerSlot>()
  for (const doc of entry.docs) {
    const cardKey = normalizeFileName(doc.name)
    const fold = foldKey(doc.name)
    const locus: RoundLocus = {
      ...(doc.detail ? { detail: doc.detail } : {}),
      repeat: doc.repeat ?? !fresh.has(cardKey),
    }
    const existing = slots.get(fold)
    if (existing) {
      existing.loci.push(locus)
      continue
    }
    const card = cardKey ? index.get(cardKey) : undefined
    slots.set(fold, {
      // The name is in the key so a re-ordered ledger does not reuse a slot
      // identity. No ordinal: the same file at two pages is now ONE slot.
      key: `r${entry.index}-${doc.name}`,
      ...(card ? { card } : {}),
      name: doc.name,
      ...(doc.title ? { title: doc.title } : {}),
      loci: [locus],
    })
  }
  return [...slots.values()]
}

/**
 * The fan under one round: the backend's own account of it when the ledger has
 * that round (matched by `index`), else today's filename match.
 *
 * The fallback is not a degraded mode — it is what every turn recorded before
 * the ledger existed, and what a turn whose ledger lost a round still gets.
 */
export const roundFan = (
  round: RetrievalRound,
  cards: CitedDocument[],
  ledger?: RetrievalLedger | null
): FanCard[] => {
  const entry = ledger?.find((candidate) => candidate.index === round.index)
  if (entry) return ledgerFan(entry, cards)
  return documentsForRound(round, cards).map((card) => ({
    key: card.id,
    card,
    name: card.fileName ?? card.title,
  }))
}

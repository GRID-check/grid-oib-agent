/**
 * Retrieval ROUNDS for the Herleitung spine.
 *
 * The live line replaces: round 0's sentence is overwritten by round 1's the
 * moment the model searches again. The graph needs the opposite — every round
 * kept, in order — so a second search is a new layer, not a mutated caption.
 *
 * A round is a checkpoint: a `retrieval` step (what the model concluded, the
 * tools it called because of that) plus the files the `sources` steps of that
 * round returned. A `sources` step carries its round; a hit may carry its own,
 * which wins. The query in `values` stays on the live line; the graph never
 * draws it (PF-12).
 */

import type { RetrievalLedger, RetrievalLedgerEntry } from '@/lib/conversations/message-retrieval-ledger'
import type { StoredThinkingStep } from './turn-fold'
import { normalizeFileName, type CitedDocument } from './citations/model'

/** The fields of a stored step the round walker reads. */
export type RoundStep = Pick<StoredThinkingStep, 'kind' | 'round' | 'turnEvent' | 'traceLanes'>

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

/** Ordered retrieval rounds, each with the names its fetch returned. */
export const retrievalRounds = (steps: readonly RoundStep[]): RetrievalRound[] => {
  const byIndex = new Map<number, RetrievalRound>()
  for (const step of steps) {
    if (step.kind !== 'retrieval' || step.round === undefined || !step.turnEvent) continue
    const { key, values, reason, tools } = step.turnEvent
    byIndex.set(step.round, {
      index: step.round,
      key,
      ...(values ? { values } : {}),
      ...(reason ? { reason } : {}),
      tools: [...new Set(tools ?? [])],
      sourceNames: byIndex.get(step.round)?.sourceNames ?? [],
    })
  }
  for (const step of steps) {
    if (step.kind !== 'sources') continue
    for (const lane of step.traceLanes ?? []) {
      for (const source of lane.sources) {
        const round = byIndex.get(source.round ?? step.round ?? -1)
        const name = source.name.trim()
        if (!round || !name) continue
        if (round.sourceNames.some((known) => known.toLowerCase() === name.toLowerCase())) continue
        round.sourceNames.push(name)
      }
    }
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

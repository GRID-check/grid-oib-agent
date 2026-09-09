/**
 * What a turn READ out of memory, as the surfaces render it (ADR-0055).
 *
 * Three surfaces read one field. The marker under the answer names the notes
 * that were in context, the Wissensbasis states how many were carried out of
 * how many exist, and the Herleitung shows the memory band beside — never
 * inside — the corpus bands. They must agree, so the derivations live here as
 * a pure module with a millisecond-long spec rather than three times inside
 * three render functions (`frontends/ui/AGENTS.md`).
 *
 * ## The one rule this module exists to hold
 *
 * `memory_context` says what was READ. It never says what was USED, because
 * nothing on either side of the wire can tell whether a note the model was
 * shown changed a word of the answer. Every helper here is named and typed for
 * that distinction, and the copy the callers reach for ("im Blick", not
 * "verwendet") is written on the same rule.
 *
 * ## Zero carried is a fact; absent is not
 *
 * A turn whose digest carried nothing still knows how many notes exist, and
 * that number is worth stating. A turn with NO memory context at all — the
 * field is absent — knows nothing, and every helper returns `null` for it
 * rather than a zero it would have invented.
 */

import type { MemoryContext } from '@/adapters/api/schemas'
import type { MemoryLevelCounts } from '@/features/layout/components/scope/scope-tree-model'

/** The subset of a message these derivations read. */
export interface MemoryContextMessage {
  memoryContext?: MemoryContext
}

/**
 * The counts the Wissensbasis states, or `null` when the turn carried no
 * memory context at all.
 *
 * `omitted` is taken off the wire rather than computed as `total - carried`:
 * it is the number the DIGEST disclosed to the model, and recomputing it here
 * would silently re-open the divergence between what the model is told and what
 * the reader is told that this whole record is about.
 */
export const memoryCounts = (context: MemoryContext | undefined): MemoryLevelCounts | null =>
  context
    ? { carried: context.carried.length, total: context.total, omitted: context.omitted }
    : null

/**
 * The counts from the most recent turn in a transcript that reported any.
 *
 * Newest-first, because the Wissensbasis states what the NEXT turn will read,
 * and the best evidence for that is the last turn that read anything. A
 * transcript with no such turn yields `null`, and the level then states no
 * counts at all rather than zeroes it made up.
 */
export const latestMemoryCounts = (
  messages: readonly MemoryContextMessage[] | undefined
): MemoryLevelCounts | null => {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const counts = memoryCounts(messages?.[i]?.memoryContext)
    if (counts) return counts
  }
  return null
}

/**
 * Whether the answer marker renders at all.
 *
 * Absent when `carried` is empty (the contract): a line saying "0 Notizen im
 * Blick" under every answer in a project with no memory yet is noise on the
 * one surface the card charter asks to keep quiet, and the Wissensbasis
 * already states the store's size for a reader who wants it.
 */
export const hasMemoryMarker = (context: MemoryContext | undefined): boolean =>
  (context?.carried.length ?? 0) > 0

/**
 * Whether this turn reached PAST the digest — `search_memory` returned notes.
 *
 * A distinct fact from `carried`, and worth its own sentence: the digest is
 * injected on every turn and reaching past it is a decision the agent made
 * because the question needed something the digest could not see.
 */
export const searchedMemory = (context: MemoryContext | undefined): boolean =>
  (context?.searched ?? 0) > 0

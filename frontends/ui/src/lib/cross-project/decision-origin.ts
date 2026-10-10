/**
 * Who stands behind a recorded decision, one rule for every reader: the agent's
 * cross-project lookup and a person's similar-projects page say the same, in
 * the same words: „von einer Person bestätigt", „aus den Unterlagen
 * erschlossen", „von Piloti notiert" (`references.decisions.origin`, and
 * `_decision_provenance` in the tool).
 */

import type { ProjectMemoryItem } from '@/lib/db/schema'

export type DecisionOrigin = 'person' | 'documents' | 'agent'

/** A person confirmed, pinned or wrote it: not only the agent's reading. */
export function isConfirmedMemory(item: Pick<ProjectMemoryItem, 'pinned' | 'verification' | 'provenanceType'>): boolean {
  return item.pinned || item.verification === 'user_confirmed' || item.provenanceType === 'user'
}

/**
 * A person's confirmation outranks the documents it was read from, which
 * outrank the agent's own note alone.
 */
export function decisionOriginOf(found: { confirmed: boolean; verification: ProjectMemoryItem['verification'] }): DecisionOrigin {
  if (found.confirmed) return 'person'
  return found.verification === 'source_grounded' ? 'documents' : 'agent'
}

/** {@link decisionOriginOf} of a memory row as it is stored. */
export function memoryOriginOf(item: Pick<ProjectMemoryItem, 'pinned' | 'verification' | 'provenanceType'>): DecisionOrigin {
  return decisionOriginOf({ confirmed: isConfirmedMemory(item), verification: item.verification })
}

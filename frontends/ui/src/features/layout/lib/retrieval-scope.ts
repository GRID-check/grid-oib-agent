/**
 * Which knowledge shelves a turn may read.
 *
 * Project documents and the Büroarchiv both ride the knowledge layer, which is
 * not a toggleable data source. The composer chips ("Projektunterlagen" /
 * "Büroarchiv") choose the shelves a turn searches: a project question must
 * not mix in Archiv hits, and "summarize this upload" must not walk the whole
 * corpus.
 *
 * Documented twin of `shelves_for_turn` in `src/aiq_agent/common/focus_file.py`.
 * The wire carries intent (`focus_shelf` / `source_preset`), never this list.
 * Change both mappings together.
 */

import type { SourcePresetId } from '../types'

export type RetrievalShelf = 'archiv' | 'project' | 'session' | 'base'

/**
 * Shelves this turn may retrieve from, or `undefined` when the signed
 * collection scope should be left intact (no subject, no preset).
 */
export function includeShelvesForTurn(input: {
  subjectShelf?: RetrievalShelf | null
  preset?: SourcePresetId | null
}): RetrievalShelf[] | undefined {
  // The law is not a competing shelf, so a subject file never subtracts it —
  // see `shelves_for_turn` in `src/aiq_agent/common/focus_file.py` for the
  // argument.
  if (input.subjectShelf === 'session') return ['session', 'base']
  if (input.subjectShelf === 'project') return ['project', 'session', 'base']
  if (input.subjectShelf === 'archiv') return ['archiv', 'session', 'base']
  if (input.preset === 'law') return ['base']
  if (input.preset === 'project') return ['project', 'session', 'base']
  if (input.preset === 'office') return ['archiv', 'session', 'base']
  return undefined
}

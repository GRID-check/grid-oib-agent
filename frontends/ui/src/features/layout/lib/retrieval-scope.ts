/**
 * Which knowledge shelves a turn may read.
 *
 * Project documents and the Büroarchiv both ride the knowledge layer, which is
 * not a toggleable data source. The composer chips ("Projektunterlagen" /
 * "Büroarchiv") used to only switch RIS/web off and still searched every
 * shelf — so a project question mixed in Archiv hits (#436) and "summarize
 * this upload" walked the whole corpus (#429).
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
  if (input.subjectShelf === 'session') return ['session']
  if (input.subjectShelf === 'project') return ['project', 'session']
  if (input.subjectShelf === 'archiv') return ['archiv', 'session']
  if (input.preset === 'law') return ['base']
  if (input.preset === 'project') return ['project', 'session', 'base']
  if (input.preset === 'office') return ['archiv', 'session', 'base']
  return undefined
}

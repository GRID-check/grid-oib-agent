/**
 * What a run-ledger document wears: its tint family and its authority badge.
 *
 * A `RunLedgerDoc` carries a name, sometimes a title and a shelf, and where in
 * the document the step read — nothing more, because the ledger describes what
 * a step reached and not how the answer will cite it. The chip still has to
 * paint it in the family every other source chip uses (ADR-0026), so the kind
 * is read off the SHELF the wire stated, which is data (ADR-0047): the base
 * corpus is Baurecht, the Archiv is office knowledge, the project and the
 * session are project knowledge. A document with no shelf is not attributed to
 * one and falls to the web family, exactly as `kindForLane` fails open.
 *
 * The badge is the one place a NAME is consulted, and only ever in the
 * conservative direction: a document that calls itself OIB or ÖNORM is badged
 * so, and one on the base shelf that names a Bauordnung, a Gesetz, a Verordnung
 * or a § is RIS. Nothing here promotes an unbadged upload to law — that is the
 * strongest claim this UI can make, and `authorityTag` refuses it for the same
 * reason.
 */

import { asShelf, kindForLane, KIND_TO_SIGNAL, type SourceKind } from '@/features/chat/lib/source-kinds'
import type { SourceTint } from '@/features/layout/lib/source-presets'
import type { RunLedgerDoc } from '@/lib/runs/run-ledger-types'

export interface DocProvenance {
  kind: SourceKind
  tint: SourceTint
  /** OIB / RIS / ÖNORM inside the Baurecht family; null everywhere else. */
  authority: string | null
}

const OIB_RE = /\bOIB\b/i
// No `\b` around the umlaut: JavaScript's word boundary knows ASCII only, so
// `\bÖNORM` never matches at the start of a string.
const ONORM_RE = /ÖNORM|\bONORM\b/i
const RIS_RE = /Bauordnung|\bBO\s|Gesetz|Verordnung|§/i

/** The lane key the shelf implies, in `kindForLane`'s vocabulary. */
function laneForShelf(shelf: string | undefined): string | undefined {
  switch (asShelf(shelf)) {
    case 'base':
      return 'baurecht'
    case 'archiv':
      return 'buero'
    case 'project':
    case 'session':
      return 'projekt'
    default:
      return undefined
  }
}

export function docProvenance(doc: Pick<RunLedgerDoc, 'name' | 'title' | 'shelf'>): DocProvenance {
  const label = `${doc.title ?? ''} ${doc.name}`
  const isOib = OIB_RE.test(label)
  const isOnorm = ONORM_RE.test(label)
  const shelfLane = laneForShelf(doc.shelf)
  // A name that says OIB or ÖNORM is law wherever it sits; otherwise the shelf
  // decides, and no shelf reads as unattributed (web).
  const kind: SourceKind = isOib || isOnorm ? 'baurecht' : kindForLane(shelfLane)
  const authority =
    kind !== 'baurecht'
      ? null
      : isOib
        ? 'OIB'
        : isOnorm
          ? 'ÖNORM'
          : RIS_RE.test(label)
            ? 'RIS'
            : null
  const tint: SourceTint = isOib ? 'oib' : KIND_TO_SIGNAL[kind]
  return { kind, tint, authority }
}

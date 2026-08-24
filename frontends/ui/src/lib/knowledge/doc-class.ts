/**
 * Frontend Dokumentart (doc_class) mirror — the closed vocabulary of base-corpus
 * document classes the platform owner assigns from the base-knowledge admin UI.
 *
 * SINGLE SOURCE OF TRUTH: the canonical vocabulary lives in the Python backend
 * (`src/aiq_agent/knowledge/document_classification.py` — `DOCUMENT_CLASSES`,
 * `DOCUMENT_CLASS_LABELS`, `DOCUMENT_CLASS_LANES`, `DEFAULT_DOC_CLASS`), which the
 * doc-class edit endpoint validates every write against. This file is a
 * hand-kept TypeScript mirror used only to render the editor's dropdown + badge.
 * A parity test (`doc-class.spec.ts`) reads the Python file and fails if the key
 * list here ever drifts — so the backend stays authoritative and a stale copy is
 * caught in CI (an out-of-vocabulary value the UI might send is still rejected
 * 400 server-side).
 *
 * Keep the ORDER identical to the Python `DOCUMENT_CLASSES` tuple.
 *
 * The badge color + authority tag are derived through the shared source-kind
 * taxonomy (`source-kinds.ts`) so the Dokumentart badge in this admin panel is
 * tinted and tagged identically to the citation chips the same document renders
 * as elsewhere in the app: every base class is in the `law` (Baurecht) family,
 * and carries the OIB / RIS / ÖNORM rung of the authority ladder.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { authorityTag, kindForLane, KIND_TO_SIGNAL } from '@/features/chat/lib/source-kinds'

/** Ordered, immutable key list — mirrors backend `DOCUMENT_CLASSES`. */
export const DOC_CLASSES = [
  'oib_richtlinie',
  'oib_leitfaden',
  'oib_erlaeuterung',
  'oib_begriffe',
  'oib_referenz',
  'oib_aenderung',
  'norm_extern',
  'gesetz',
  'sonstiges',
] as const

export type DocClass = (typeof DOC_CLASSES)[number]

/** doc_class key → German label (mirrors backend `DOCUMENT_CLASS_LABELS`). */
export const DOC_CLASS_LABELS: Record<DocClass, string> = {
  oib_richtlinie: 'OIB-Richtlinie (verbindlich)',
  oib_leitfaden: 'OIB-Leitfaden',
  oib_erlaeuterung: 'OIB-Erläuterung',
  oib_begriffe: 'OIB-Begriffsbestimmungen',
  oib_referenz: 'OIB-Referenzdokument',
  oib_aenderung: 'OIB-Änderungsdokument',
  norm_extern: 'Norm (ÖNORM u.a.)',
  gesetz: 'Gesetz / Bauordnung',
  sonstiges: 'Sonstiges Basisdokument',
}

/** Neutral base class assigned when nothing else is known (mirrors backend). */
export const DEFAULT_DOC_CLASS: DocClass = 'sonstiges'

/**
 * doc_class key → fine lane key (mirrors backend `DOCUMENT_CLASS_LANES`). Fed to
 * the source-kind helpers so the badge's tint + authority tag match the chips.
 */
const DOC_CLASS_LANES: Record<DocClass, string> = {
  oib_richtlinie: 'baurecht_oib',
  oib_leitfaden: 'baurecht_oib_leitfaden',
  oib_erlaeuterung: 'baurecht_oib_erlaeuterung',
  oib_begriffe: 'baurecht_oib_begriffe',
  oib_referenz: 'baurecht_oib_referenz',
  oib_aenderung: 'baurecht_oib_diff',
  norm_extern: 'norm_extern',
  gesetz: 'baurecht_ris',
  sonstiges: 'baurecht_basis',
}

/** Narrow an untrusted wire value to a known DocClass, else undefined. */
export const asDocClass = (value: string | null | undefined): DocClass | undefined =>
  value && (DOC_CLASSES as readonly string[]).includes(value) ? (value as DocClass) : undefined

/** Resolve a (possibly null/unknown) doc_class to a real class for display. */
export const resolveDocClass = (value: string | null | undefined): DocClass =>
  asDocClass(value) ?? DEFAULT_DOC_CLASS

/**
 * The `--source-*` tint family for a doc_class. All base classes resolve to the
 * `law` (Baurecht) family so they read as authoritative building law, matching
 * the citation chips.
 */
export const docClassSignal = (docClass: string | null | undefined): SourceSignal =>
  KIND_TO_SIGNAL[kindForLane(DOC_CLASS_LANES[resolveDocClass(docClass)])]

/**
 * Compact authority tag (OIB / RIS / ÖNORM) for a doc_class, derived from its
 * lane via the same `authorityTag` the chips use — so the badge matches. Returns
 * null only if a lane carried no authority tier (does not happen for the base
 * vocabulary, but the fallback keeps the contract honest).
 */
export const docClassAuthority = (
  docClass: string | null | undefined,
): 'OIB' | 'RIS' | 'ÖNORM' | null => {
  const tag = authorityTag(DOC_CLASS_LANES[resolveDocClass(docClass)])
  return tag === 'OIB' || tag === 'RIS' || tag === 'ÖNORM' ? tag : null
}

/** Whether a doc_class is one of the binding official OIB base laws (`oib_*`). */
export const isOibBinding = (docClass: string | null | undefined): boolean =>
  resolveDocClass(docClass).startsWith('oib_')

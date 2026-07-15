/**
 * Controlled document-tag vocabulary — the closed set of ingestion tags a user
 * may assign in the Files metadata panel.
 *
 * SINGLE SOURCE OF TRUTH: the canonical vocabulary lives in the Python backend
 * (`src/aiq_agent/knowledge/document_classification.py` —
 * `DOCUMENT_TYPE_TAGS` / `DISCIPLINE_TAGS` / `ALLOWED_TAGS`), which the tag-edit
 * endpoint validates every write against. This file is a hand-kept TypeScript
 * mirror used only to render the editor's toggleable chips. The two are pinned
 * together by a backend parity test (`tests/test_tag_vocabulary_parity.py`) that
 * fails if these arrays ever drift from the Python tuples — so a stale copy here
 * is caught in CI, and the backend remains the authority (an out-of-vocabulary
 * value the UI might send is still rejected 400 server-side).
 *
 * Keep the ORDER identical to the Python tuples; the parity test compares order.
 */

/** 1–2 of these describe what the document *is*. */
export const DOCUMENT_TYPE_TAGS = [
  'Bebauungsplan',
  'Flächenwidmungsplan',
  'Grundriss',
  'Schnitt',
  'Ansicht',
  'Detail',
  'Gutachten',
  'Bescheid',
  'Norm/Richtlinie',
  'Vertrag',
  'Foto',
  'Sonstiges',
] as const

/** 0–3 of these (the six OIB 2023 Richtlinien disciplines) apply when clear. */
export const DISCIPLINE_TAGS = [
  'Standsicherheit',
  'Brandschutz',
  'Hygiene/Gesundheit/Umweltschutz',
  'Nutzungssicherheit/Barrierefreiheit',
  'Schallschutz',
  'Energieeinsparung/Wärmeschutz',
] as const

export type DocumentTypeTag = (typeof DOCUMENT_TYPE_TAGS)[number]
export type DisciplineTag = (typeof DISCIPLINE_TAGS)[number]
export type ControlledTag = DocumentTypeTag | DisciplineTag

/** The complete allowed vocabulary (union of both groups). */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set<string>([...DOCUMENT_TYPE_TAGS, ...DISCIPLINE_TAGS])

/** Hard cap on tags stored per document (mirrors the backend `MAX_TAGS`). */
export const MAX_TAGS = 5

/** Grouped for the editor UI (Dokumenttyp / Fachbereich sections). */
export const TAG_GROUPS = [
  { id: 'documentType', tags: DOCUMENT_TYPE_TAGS },
  { id: 'discipline', tags: DISCIPLINE_TAGS },
] as const

export type TagGroupId = (typeof TAG_GROUPS)[number]['id']

/** Whether every tag in the list is part of the controlled vocabulary. */
export function areTagsValid(tags: readonly string[]): boolean {
  return tags.every((tag) => ALLOWED_TAGS.has(tag))
}

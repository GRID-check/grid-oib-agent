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
 *
 * A tag is stored as written here. A new tag is an English token
 * (`correspondence`) that a person reads through i18n, `files.documentTag.<token>`
 * ({@link tagLabel}). The German values predate that rule and are still stored
 * as such (metadata database, vector payloads); until their rename they are
 * their own label.
 */

import type { Translator } from '@/i18n'

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
  'correspondence',
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

/** Bounds on the model's topic keywords the BFF accepts on an edit. The backend normalises them. */
export const MAX_TOPICS = 6
export const MAX_TOPIC_LENGTH = 40

/** Grouped for the editor UI (Dokumenttyp / Fachbereich sections). */
export const TAG_GROUPS = [
  { id: 'documentType', tags: DOCUMENT_TYPE_TAGS },
  { id: 'discipline', tags: DISCIPLINE_TAGS },
] as const

export type TagGroupId = (typeof TAG_GROUPS)[number]['id']

/**
 * The document type ingestion detected: the first of its tags that is a
 * {@link DOCUMENT_TYPE_TAGS} entry, or `undefined`. Membership, not position:
 * a user-edited tag list need not lead with the type. The Files preview's Type
 * row and the upload summary both ask this, so they name a file the same way.
 */
export function documentTypeOf(tags: readonly string[] | null | undefined): DocumentTypeTag | undefined {
  return (tags ?? []).find((tag): tag is DocumentTypeTag => (DOCUMENT_TYPE_TAGS as readonly string[]).includes(tag))
}

/**
 * The tags that are English tokens, each with its label in every dictionary
 * under `files.documentTag`. The parity test holds this list to every token in
 * the vocabulary, so a new token cannot ship without a label.
 */
export const LABELLED_TAGS = [
  'correspondence',
] as const

export type LabelledTag = (typeof LABELLED_TAGS)[number]

function isLabelledTag(tag: string): tag is LabelledTag {
  return (LABELLED_TAGS as readonly string[]).includes(tag)
}

/**
 * What a person reads for a stored tag. `t` is the `files` translator. A token
 * reads as its label („Korrespondenz“, "Correspondence"); a German value and a
 * free topic read as themselves. Every surface that shows, counts or matches a
 * tag goes through this, so a token never reaches a person raw.
 */
export function tagLabel(tag: string, t: Translator): string {
  return isLabelledTag(tag) ? t(`documentTag.${tag}`) : tag
}

/** Whether every tag in the list is part of the controlled vocabulary. */
export function areTagsValid(tags: readonly string[]): boolean {
  return tags.every((tag) => ALLOWED_TAGS.has(tag))
}

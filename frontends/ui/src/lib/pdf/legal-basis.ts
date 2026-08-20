/**
 * The answer's `legal_basis` cards, as the section a Behörde reads first.
 *
 * ## Why this exists next to the .docx card walker rather than instead of it
 *
 * `answer-export/cards.ts` already renders every card type into a document, and
 * this module does NOT re-do that job: it renders exactly one card type into
 * one appendix, reading the SAME dictionary keys that walker reads —
 * `cardTypes.legal_basis` for the heading, `fields.<name>` for every label,
 * `values.lane.<member>` for the one closed vocabulary a `legal_basis` carries.
 * A second set of German words for „Paragraf" and „Ausgabe" is the failure the
 * `answerExport` namespace exists to prevent, and it would land in the two
 * documents an architect is most likely to put side by side — the .docx they
 * edit and the .pdf they attach.
 *
 * The field ORDER is mirrored too, from `FIELD_ORDER.legal_basis` in that file:
 * `law, article, section, summary, original_text`, then whatever else the card
 * carries (`lane`, `edition`) in the order it carries it. That is what
 * `orderedFields` does, and it is what makes a Fundstelle read the same way in
 * both exports.
 *
 * ## Why a bespoke renderer for one type and not the forty-type walker
 *
 * The walker's whole argument is that forty bespoke renderers would silently
 * lose a card type on the day the forty-first ships. That argument does not
 * transfer: this section is not "the cards", it is *the citations*, and its
 * membership is a deliberate choice rather than a catalogue. A `legal_basis` is
 * six known string fields (`models.py`, `LegalBasisCard`) — shape dispatch
 * would be machinery standing over nothing.
 *
 * ## What it refuses to do
 *
 * Nothing here invents a citation. A card with no `law` is dropped rather than
 * headed „Rechtsgrundlage" with empty rows under it: on a page that has left
 * the app, a labelled blank is indistinguishable from a claim.
 */

import type { Translator } from '@/i18n/translate'
import type { PdfBlock, PdfFactRow, PdfSection } from './ReactPdfDocument'

/** A stored card, as untrusted jsonb: keys of unknown type. */
type CardRecord = Record<string, unknown>

const isRecord = (value: unknown): value is CardRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A `legal_basis` card this renderer will print — which means one with a `law`.
 *
 * The law is not one field among six, it is the CITATION; the other five
 * qualify it. `LegalBasisCard.law` is `str` with `min_length=1` (`models.py`),
 * required, so every card that passed `validate_cards` on the way in has one
 * and this predicate costs a real card nothing. What it stops is the card that
 * did not: jsonb written by a build older or newer than this one, replayed from
 * a stored message, or hand-supplied.
 *
 * Such a card would otherwise still print — `cardBlocks` drops a card only when
 * it yields NO blocks, and a `summary` alone yields two. The result is an entry
 * under „Rechtsgrundlagen" that states a legal position and names no law. On a
 * page that has left the app and is attached to an Einreichung, that does not
 * read as an incomplete card; it reads as a claim whose source the reader
 * failed to find. Printing nothing is the honest failure — the answer's own
 * prose still carries what the card said.
 */
const isLegalBasis = (value: unknown): value is CardRecord =>
  isRecord(value) &&
  value.type === 'legal_basis' &&
  typeof value.law === 'string' &&
  value.law.trim().length > 0

/**
 * Reading order, copied from `FIELD_ORDER.legal_basis` in
 * `answer-export/cards.ts` — which took it from the declaration order in
 * `models.py`, the order the author of the card meant it to be read in.
 */
const DECLARED_ORDER: readonly string[] = ['law', 'article', 'section', 'summary', 'original_text']

/**
 * Fields no card prints at its top level. The same three
 * `answer-export/cards.ts` subtracts: the discriminator, the heading, and the
 * model-supplied preview the product refuses to trust.
 *
 * `legal_basis` carries none of them today, and the set is applied anyway
 * because a stored card is jsonb written by a backend that may be newer than
 * this build.
 */
const SKIPPED_FIELDS = new Set(['type', 'title', 'preview'])

/**
 * Above this many characters a value is a paragraph, not a row.
 *
 * 90, the same threshold `answer-export/cards.ts` uses, so `summary` and
 * `original_text` break out of the fact block in both exports at the same
 * point. A 300-character excerpt squeezed into a 110pt-labelled row is a
 * column of two-word lines.
 */
const PROSE_LENGTH = 90

/**
 * A dictionary miss, spotted the way `flatLabel` spots it.
 *
 * `createTranslator` returns the fully qualified key when it finds nothing, so
 * a missing entry surfaces as the literal string `answerExport.fields.x`. A
 * field name this build has never heard of must still print with its data
 * intact rather than under a dot-path, so the caller falls back to the name.
 */
const isMiss = (translated: string, key: string): boolean =>
  translated === `answerExport.${key}`

/** `original_text` → `Original text`, when the dictionary has no word for it. */
const humanize = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase())

const fieldLabel = (name: string, t: Translator): string => {
  const label = t(`fields.${name}`)
  return isMiss(label, `fields.${name}`) ? humanize(name) : label
}

/**
 * A field's value as text.
 *
 * `lane` is the one field on this card whose stored value is a wire token
 * (`baurecht_oib`), and the dictionary already spells it („OIB" / „RIS") for
 * the .docx. Everything else is prose the model wrote or wording it copied, and
 * is carried verbatim — a citation the export rewrote is not a citation.
 */
const valueText = (name: string, value: string, t: Translator): string => {
  if (name !== 'lane') return value
  const translated = t(`values.lane.${value}`)
  return isMiss(translated, `values.lane.${value}`) ? value : translated
}

/** Present fields in reading order: the declared ones first, then the rest. */
const orderedFields = (card: CardRecord): string[] => {
  const present = Object.keys(card).filter((key) => !SKIPPED_FIELDS.has(key))
  const declared = DECLARED_ORDER.filter((key) => present.includes(key))
  return [...declared, ...present.filter((key) => !declared.includes(key))]
}

/**
 * One card's blocks: a heading, then its fields.
 *
 * Adjacent short fields accumulate into ONE fact block and a long one flushes
 * it, which is how the .docx's `CardBody` builds the same card — so „Gesetz /
 * Richtlinie", „Paragraf" and „Punkt" share a block and the excerpt that
 * follows them is its own paragraph.
 */
function cardBlocks(card: CardRecord, t: Translator): PdfBlock[] {
  const blocks: PdfBlock[] = []
  let rows: PdfFactRow[] = []
  const flush = (): void => {
    if (rows.length === 0) return
    blocks.push({ kind: 'rows', rows })
    rows = []
  }

  for (const name of orderedFields(card)) {
    const raw = card[name]
    // Every field of a `LegalBasisCard` is `str | None`. Anything else in this
    // slot is a card from a build this one does not know; printing `[object
    // Object]` under „Paragraf" would be worse than printing nothing.
    if (typeof raw !== 'string') continue
    const value = valueText(name, raw, t).trim()
    if (!value) continue
    if (value.length > PROSE_LENGTH || value.includes('\n')) {
      flush()
      blocks.push({ kind: 'prose', label: fieldLabel(name, t), text: value })
    } else {
      rows.push({ label: fieldLabel(name, t), value })
    }
  }
  flush()

  // The per-card heading survives even under a section named for the same
  // thing, because with two Fundstellen it is the only line separating one
  // from the next — without it the second card's „Gesetz / Richtlinie" row
  // reads as a continuation of the first.
  return blocks.length > 0 ? [{ kind: 'heading', text: legalBasisHeading(t) }, ...blocks] : []
}

/**
 * The heading one Fundstelle gets.
 *
 * `cardTypes.legal_basis` and not a new key: `legal_basis` is the one card in
 * the catalogue with no `title` field at all, so this is the same fallback the
 * .docx heads it with, and `label-coverage.spec.ts` already guards the entry.
 */
const legalBasisHeading = (t: Translator): string => {
  const name = t('cardTypes.legal_basis')
  return isMiss(name, 'cardTypes.legal_basis') ? humanize('legal_basis') : name
}

/**
 * The „Rechtsgrundlagen" section for an answer's cards, or nothing.
 *
 * Returns an EMPTY array — never a section with an empty body — when the run
 * produced no `legal_basis` card, when the value is not a list at all, or when
 * every card it holds is unprintable. A heading standing over nothing in a
 * submission document says the citations were lost, not that there were none.
 *
 * `cards` is `unknown` because that is what it is: `metadata.cards` is jsonb
 * that crossed a process boundary, and a producer that had to narrow it before
 * calling would be narrowing it against a schema this module can then assume.
 */
export function legalBasisSection(cards: unknown, t: Translator): PdfSection[] {
  if (!Array.isArray(cards)) return []
  const blocks = cards.filter(isLegalBasis).flatMap((card) => cardBlocks(card, t))
  if (blocks.length === 0) return []
  return [{ heading: t('legalBasis'), blocks }]
}

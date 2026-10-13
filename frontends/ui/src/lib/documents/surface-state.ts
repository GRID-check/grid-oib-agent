/**
 * Where a document stands with Piloti, in the one word every surface says.
 *
 * ## Why this exists
 *
 * Ingestion and the content check (ADR-0086) used to speak four languages
 * about the same row. The badge said „In Quarantäne“, the folder brief
 * „zurückgehalten“, CONTEXT.md **Zurückgehalten**; the status filter had no
 * group for a held file at all; the upload summary counted an undeclared status
 * as stored while the brief counted it as being read and the badge said
 * „Unbekannt“. Each surface read `DOCUMENT_STATUS_FACTS` and then decided on
 * its own what to call the result.
 *
 * This module is that decision, made once. Every surface that names a
 * document's state (the badge, the folder brief, the status filter and sort,
 * the upload summary and history, the chat peek) asks {@link surfaceStateOf}
 * and says {@link surfaceStateLabel}: one German word each, „Zitierbar“, „Wird
 * gelesen“, „Zurückgehalten“, „Nicht lesbar“, „Abgelegt“, „Unbekannt“.
 *
 * Nothing here restates the status vocabulary. A status reaches its state
 * through the badge colour `DOCUMENT_STATUS_FACTS` already declares for it
 * (`variant`), so a new status is one entry there and arrives here on its own.
 * `surface-state.spec.ts` holds every declared status to one state and the
 * surfaces to one answer per status.
 *
 * Pure and client-safe: no database, no server import. The Postgres side (the
 * shelf summary, the level listing's state filter) counts by status alone
 * through {@link declaredStatusesIn}, which is derived from the same table.
 */

import type { Translator } from '@/i18n/translate'
import { QUARANTINED_PREFIX } from '@/lib/upload-screening/quarantine'
import {
  DOCUMENT_STATUS_FACTS,
  KNOWN_DOCUMENT_STATUSES,
  documentStatusFacts,
  type DocumentReadFamily,
  type DocumentStatusVariant,
} from './document-status'

/**
 * The six states a reader can tell apart, and acts on differently.
 *
 * - `citable`    — indexed; Piloti can find and cite it („Zitierbar“).
 * - `reading`    — in flight; it will change on its own („Wird gelesen“).
 * - `held`       — the content check stopped it, and a person decides
 *                  („Zurückgehalten“, CONTEXT.md). It waits in the Quarantäne.
 * - `unreadable` — the read went wrong; nothing was decided about its content,
 *                  and a person can read it again („Nicht lesbar“).
 * - `stored`     — at rest and deliberately not in the knowledge base: a
 *                  report Piloti wrote, a row stranded at birth („Abgelegt“).
 * - `unknown`    — a status nobody declared („Unbekannt“). Drift, not
 *                  vocabulary: `document-status.spec.ts` fails for a writer
 *                  that emits one.
 */
export type SurfaceState = 'citable' | 'reading' | 'held' | 'unreadable' | 'stored' | 'unknown'

/** Every state, in the order a reader scans for them: what Piloti has, what moves, what needs a person, the rest. */
export const SURFACE_STATES: readonly SurfaceState[] = ['citable', 'reading', 'held', 'unreadable', 'stored', 'unknown']

/** The facts a state is read from. Only `status` is required; the rest refine it where a surface has them. */
export interface SurfaceStateInput {
  status: string | null | undefined
  /** The stored reason. A verdict here (`quarantined:{…}`) on a failed row is the gate's stop, not a failed read. */
  errorMessage?: string | null
  /** The content check's verdict (`documents.screening_outcome`). `quarantined` holds the file whatever its status. */
  screeningOutcome?: string | null
}

/** A row, or its bare status for a surface that holds nothing else (the SQL tallies, the history counts). */
export type SurfaceStateSubject = SurfaceStateInput | string | null | undefined

/**
 * The badge colour is the state: green is "Piloti can quote this", red "the
 * read broke", amber "a person decides". One table, so the colour and the word
 * cannot disagree.
 */
const STATE_BY_VARIANT: Record<DocumentStatusVariant, SurfaceState> = {
  success: 'citable',
  info: 'reading',
  warning: 'held',
  destructive: 'unreadable',
  secondary: 'stored',
}

function inputOf(subject: SurfaceStateSubject): SurfaceStateInput {
  if (typeof subject === 'string' || subject === null || subject === undefined) return { status: subject }
  return subject
}

/**
 * The gate's own verdict on the row, whatever its status says. The reconcile
 * turns a verdict into `quarantined` (`failedOrQuarantined`), so a failed row
 * carrying one predates that; it is still a hold, never a failed read.
 */
function heldByVerdict(input: SurfaceStateInput, variant: DocumentStatusVariant | null): boolean {
  if (input.screeningOutcome === 'quarantined') return true
  return variant === 'destructive' && Boolean(input.errorMessage?.startsWith(QUARANTINED_PREFIX))
}

/**
 * The state of a document. An undeclared status is `unknown`, never `citable`:
 * calling something citable that is not is the error that wastes an
 * afternoon.
 */
export function surfaceStateOf(subject: SurfaceStateSubject): SurfaceState {
  const input = inputOf(subject)
  const facts = documentStatusFacts(input.status)
  if (heldByVerdict(input, facts?.variant ?? null)) return 'held'
  return facts ? STATE_BY_VARIANT[facts.variant] : 'unknown'
}

/**
 * The one word for a state, from a translator bound to the `files` namespace
 * (`useTranslations('files')`). The keys are built here rather than written at
 * a call site, so `surface-state.spec.ts` checks every one exists in both
 * dictionaries.
 */
export function surfaceStateLabel(state: SurfaceState, t: Translator): string {
  return t(`surfaceState.${state}`)
}

/**
 * The folder brief's families (`DocumentReadFamily`, which the shelf summary
 * counts in SQL and the level listing filters by) as views of a state.
 *
 * `unknown` folds into `reading`, and this is the one place it does: Postgres
 * counts a status no family declares under `reading` (`readFamilyWhere`,
 * `lib/documents/repository.ts`), and the brief must add up to the same
 * numbers. Every other state is its own family.
 */
const FAMILY_BY_STATE: Record<SurfaceState, DocumentReadFamily> = {
  citable: 'readable',
  reading: 'reading',
  held: 'held',
  unreadable: 'failed',
  stored: 'unindexed',
  unknown: 'reading',
}

/** The family a state is counted in. */
export function readFamilyOfState(state: SurfaceState): DocumentReadFamily {
  return FAMILY_BY_STATE[state]
}

/**
 * The state a family stands for, for a surface that holds a family and has to
 * say its word (the brief's legend, a slice's title). `reading` answers
 * `reading`: what it also counts, a status nobody declared, is drift.
 */
const STATE_BY_FAMILY: Record<DocumentReadFamily, SurfaceState> = {
  readable: 'citable',
  reading: 'reading',
  held: 'held',
  failed: 'unreadable',
  unindexed: 'stored',
}

export function stateOfReadFamily(family: DocumentReadFamily): SurfaceState {
  return STATE_BY_FAMILY[family]
}

/** The family of a document (or a bare status), through its state. */
export function documentReadFamily(subject: SurfaceStateSubject): DocumentReadFamily {
  return readFamilyOfState(surfaceStateOf(subject))
}

/**
 * The declared statuses of one family, lower-case as the column holds them,
 * for the SQL that counts and filters by family. By status alone: Postgres
 * cannot read a verdict out of `error_message`, and no current writer leaves
 * one on a failed row. `reading` is the declared in-flight set only; the SQL
 * that asks for it also takes every status no family declares (`notInArray`
 * over the other four), which is {@link FAMILY_BY_STATE}'s `unknown` fold.
 */
export function declaredStatusesIn(family: DocumentReadFamily): string[] {
  return KNOWN_DOCUMENT_STATUSES.filter(
    (status) => FAMILY_BY_STATE[STATE_BY_VARIANT[DOCUMENT_STATUS_FACTS[status].variant]] === family
  )
}

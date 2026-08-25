/**
 * What role a document plays in a project — the declaration the wizard has been
 * missing.
 *
 * The repo already labels documents three ways, and none of them can answer
 * "which file is THE Bebauungsplan for this project":
 *
 *   - `tags` (`lib/documents/tag-vocabulary`) are content labels, LLM-guessed at
 *     ingestion and many-to-many. Three files can carry "Bebauungsplan": the
 *     real one, a scan of the neighbour's, and a PDF of the legal text. A tag
 *     cannot say which one governs, and carries no user commitment.
 *   - `doc_class` ("Dokumentart") is single-valued and human-set, but it is the
 *     norm-hierarchy axis that drives retrieval lanes for the BASE corpus. A
 *     project's Bebauungsplan has no lane to sit in.
 *   - folders are a renameable string. Building extraction on "the folder called
 *     Bebauungsplan" is inference-from-a-name, which is the move ADR-0047 exists
 *     to delete.
 *
 * A role is a fourth, genuinely different axis: a DECLARED, SCOPED binding
 * between a document and a slot in the project model. Scoped is the part the
 * other three cannot express — "Bestandsplan *of Bauwerk bw2*" — and without it
 * the whole thing is useless for the mixed Neubau/Bestand projects the intake
 * concept exists to serve.
 *
 * This module is the vocabulary and its rules. Storage is
 * `lib/db/schema/document-roles`; nothing here touches the database.
 */

import { evaluateIntakeConditions } from './intake-definition'
import type { ProjectIntakeCondition, ProjectIntakeScope } from './intake-definition'
import type { ProjectPrimitiveValue } from './types'

/**
 * The closed set of roles, ordered so the UI renders deterministically.
 *
 * Derived from the intake concept: `B2_upl` (the Bebauungsplan upload that
 * starts the extraction flow) plus the Modul I document-onboarding categories.
 * Closed on purpose, for the same reason `ALLOWED_TAGS` is: free-form roles
 * produce semantic duplicates ("Bestandsplan" vs "Bestandspläne" vs "Plan
 * Bestand") that no downstream consumer can match on.
 */
export const DOCUMENT_ROLES = [
  'bebauungsplan',
  'flaechenwidmungsplan',
  'grundbuchauszug',
  'lageplan',
  'bestandsplan',
  'foto_bestand',
  'gutachten_baugrund',
  'gutachten_laerm',
  'gutachten_schadstoffe',
  'vorentwurf_studie',
  'behoerdenkorrespondenz',
  'vorbescheid',
  'sonstige_projektgrundlage',
] as const

export type DocumentRole = (typeof DOCUMENT_ROLES)[number]

/**
 * How many documents a role can hold.
 *
 * `one` is a claim about the world, not a storage convenience: a project has one
 * governing Bebauungsplan, and a second one means the first was superseded.
 * `many` is the normal case — a Bestandsplan set is a dozen sheets, and refusing
 * the thirteenth would be arbitrary.
 */
export type RoleCardinality = 'one' | 'many'

export interface DocumentRoleDefinition {
  role: DocumentRole
  /** German label, shown as the slot's name. */
  label: string
  /**
   * Which level of the project model this role binds to. A `bauwerk` role
   * carries the building's instance id; `projekt` and (for now) `grundstueck`
   * roles carry none — see `roleRequiresScopeInstance`.
   *
   * This is the field that makes roles work at all for a project with a Neubau
   * and a Bestand in it: "the Bestandsplan" is not a project fact.
   */
  scope: ProjectIntakeScope
  cardinality: RoleCardinality
  /**
   * When the checklist should push this role, in the same condition language
   * the intake questions already use, evaluated by `evaluateIntakeConditions`.
   *
   * Sharing the evaluator is the point: Modul I's "adaptive checklist" and its
   * "dringend empfohlen" flag become DATA rather than bespoke UI code, and they
   * can never disagree with the question conditions about what a project is.
   */
  recommendedWhen?: ProjectIntakeCondition[]
  /** One line on why this document matters, shown under the slot. */
  why?: string
}

/**
 * The registry. Order is the order the checklist renders in, so the documents
 * that unblock the most downstream work come first.
 */
export const DOCUMENT_ROLE_DEFINITIONS: readonly DocumentRoleDefinition[] = [
  {
    role: 'bebauungsplan',
    label: 'Bebauungsplan',
    scope: 'grundstueck',
    cardinality: 'one',
    recommendedWhen: [{ param: 'B2', op: 'equals', value: 'ja' }],
    why: 'Grundlage für Bauklasse, Bebauungsweise, Dichte und Fluchtlinien.',
  },
  {
    role: 'flaechenwidmungsplan',
    label: 'Flächenwidmungsplan',
    scope: 'grundstueck',
    cardinality: 'one',
    why: 'Zeigt, ob die geplante Nutzung am Standort grundsätzlich möglich ist.',
  },
  {
    role: 'grundbuchauszug',
    label: 'Grundbuchauszug',
    scope: 'grundstueck',
    cardinality: 'one',
  },
  {
    role: 'lageplan',
    label: 'Lageplan',
    scope: 'grundstueck',
    cardinality: 'one',
  },
  {
    role: 'bestandsplan',
    label: 'Bestandspläne (Grundrisse, Schnitte, Ansichten)',
    scope: 'bauwerk',
    cardinality: 'many',
    recommendedWhen: [{ param: 'C2', op: 'equals', value: 'bestand' }],
    why: 'Ohne Bestandspläne bleibt der Vergleich von Bestand und Zielzustand eine Schätzung.',
  },
  {
    role: 'foto_bestand',
    label: 'Fotos / Bestandsaufnahme',
    scope: 'bauwerk',
    cardinality: 'many',
    recommendedWhen: [{ param: 'C2', op: 'equals', value: 'bestand' }],
  },
  {
    role: 'gutachten_baugrund',
    label: 'Baugrundgutachten',
    scope: 'grundstueck',
    cardinality: 'many',
  },
  {
    role: 'gutachten_laerm',
    label: 'Lärmgutachten',
    scope: 'grundstueck',
    cardinality: 'many',
    why: 'Liefert die Pegel, die der Wizard bewusst nicht abfragt.',
  },
  {
    role: 'gutachten_schadstoffe',
    label: 'Schadstoffgutachten',
    scope: 'projekt',
    cardinality: 'many',
    recommendedWhen: [{ param: 'A5', op: 'includes_any', value: ['Abbruch'] }],
  },
  {
    role: 'vorentwurf_studie',
    label: 'Vorentwürfe & Studien',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'behoerdenkorrespondenz',
    label: 'Behördenkorrespondenz',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'vorbescheid',
    label: 'Vorbescheid',
    scope: 'projekt',
    cardinality: 'many',
  },
  {
    role: 'sonstige_projektgrundlage',
    label: 'Sonstige Projektgrundlagen',
    scope: 'projekt',
    cardinality: 'many',
  },
]

/**
 * Whether a binding has been confirmed by a person.
 *
 * Deliberately the same split the project profile already draws between `facts`
 * and `assumptions`: a classifier may SUGGEST that a file is the Bebauungsplan,
 * and only a human turns that into `declared`. It is what makes the concept's
 * `dokument_ungeprüft` state expressible without inventing a fourth answer mode
 * — an extracted value is an assumption whose evidence is a `suggested` binding.
 */
export const ROLE_CONFIDENCES = ['declared', 'suggested'] as const
export type RoleConfidence = (typeof ROLE_CONFIDENCES)[number]

/** Who created the binding. Provenance, kept separate from confidence. */
export const ROLE_SOURCES = ['user', 'wizard', 'classifier'] as const
export type RoleSource = (typeof ROLE_SOURCES)[number]

const DEFINITION_BY_ROLE: ReadonlyMap<DocumentRole, DocumentRoleDefinition> = new Map(
  DOCUMENT_ROLE_DEFINITIONS.map((definition) => [definition.role, definition])
)

export function isDocumentRole(value: string): value is DocumentRole {
  return DEFINITION_BY_ROLE.has(value as DocumentRole)
}

export function isRoleConfidence(value: string): value is RoleConfidence {
  return (ROLE_CONFIDENCES as readonly string[]).includes(value)
}

export function isRoleSource(value: string): value is RoleSource {
  return (ROLE_SOURCES as readonly string[]).includes(value)
}

export function documentRoleDefinition(role: DocumentRole): DocumentRoleDefinition {
  const definition = DEFINITION_BY_ROLE.get(role)
  // Unreachable through the type, but a role read off the wire is a string.
  if (!definition) throw new Error(`Unknown document role: ${role}`)
  return definition
}

export function documentRoleLabel(role: DocumentRole): string {
  return documentRoleDefinition(role).label
}

/**
 * Does this role need a scope instance id, and is the one supplied usable?
 *
 * A `projekt` role takes none; anything narrower requires one. Stated as one
 * function so the API route, the service and the UI cannot each decide
 * differently — the case that produces silent breakage is a `bauwerk` role
 * stored without its building, which then matches every building.
 */
export function roleRequiresScopeInstance(role: DocumentRole): boolean {
  // `bauwerk` only, deliberately. A project has many buildings and the wizard
  // mints an id for each, so a bauwerk role without one would match every
  // building. It has exactly ONE plot and mints no id for it (the data model
  // allows more, and v1 starts with one), so demanding an instance for a
  // `grundstueck` role would make the Bebauungsplan unbindable today. When
  // plots become plural they get ids, and this reads `!== 'projekt'`.
  return documentRoleDefinition(role).scope === 'bauwerk'
}

export function isScopeInstanceValid(role: DocumentRole, scopeInstanceId: string | null): boolean {
  const required = roleRequiresScopeInstance(role)
  if (required) return typeof scopeInstanceId === 'string' && scopeInstanceId.length > 0
  return scopeInstanceId === null
}

/**
 * Roles the checklist should push, given the intake answers so far.
 *
 * `instanceId` scopes the evaluation to one building, exactly as it does for a
 * question: without it, a `bauwerk` condition reads the project-global answer
 * and every building gets the same recommendation.
 *
 * A role with no `recommendedWhen` is never *pushed*. It stays offerable — the
 * checklist lists every role — but nothing claims the project needs it.
 */
export function recommendedRoles(
  answers: Record<string, ProjectPrimitiveValue>,
  instanceId?: string
): DocumentRole[] {
  return DOCUMENT_ROLE_DEFINITIONS.filter(
    (definition) =>
      definition.recommendedWhen !== undefined &&
      evaluateIntakeConditions(definition.recommendedWhen, answers, instanceId)
  ).map((definition) => definition.role)
}

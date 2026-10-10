/**
 * The similar-projects page (`/app/projects/{id}/referenzen`): the closed
 * projects most like the current one that the person may open, with what they
 * share, their period and edition, their recorded decisions and their permit
 * conditions. Plain data: the service builds it, the organism draws it.
 *
 * Type-only imports from the schema, so the organism can import this file
 * without pulling the database into the browser bundle.
 */

import type { FingerprintFact } from '@/lib/cross-project/fingerprint'
import type { PermitRecordKind, PermitRequirementKind, ProjectMemoryKind } from '@/lib/db/schema'

/** How many closed projects the page lists; the rest of the office stays out of sight. */
export const SIMILAR_PROJECTS_MAX = 12
/** Decisions and constraints shown per project. */
export const SIMILAR_DECISIONS_MAX = 5
/** Source documents (file and page) named under one decision. */
export const SIMILAR_DECISION_SOURCES_MAX = 3
/** Permit records shown per project. */
export const SIMILAR_PERMITS_MAX = 5
/** Requirements (Auflagen, Nachforderungen) shown per permit record. */
export const SIMILAR_PERMIT_REQUIREMENTS_MAX = 4
/** Permit records one project's read brings back, newest first, before the page cuts them. */
export const SIMILAR_PERMIT_RECORDS_READ = 20

/**
 * Where a decision came from, as the person reading it should know it:
 * `person` (a person wrote or confirmed it), `documents` (drafted from the
 * project's own files, not yet confirmed), `agent` (noted by Piloti while the
 * project ran).
 */
export type ReferenceOrigin = 'person' | 'documents' | 'agent'

/** A value read from the project's documents; `confirmed` false means a person has not yet checked it. */
export interface ReferenceFact<T> {
  value: T
  confirmed: boolean
}

export interface ReferenceDecision {
  id: string
  kind: Extract<ProjectMemoryKind, 'decision' | 'constraint'>
  content: string
  origin: ReferenceOrigin
  /** The files it was read from, at most {@link SIMILAR_DECISION_SOURCES_MAX}. */
  sources: { fileName: string; page: string | null }[]
}

export interface ReferencePermitRequirement {
  kind: PermitRequirementKind
  content: string
}

export interface ReferencePermit {
  id: string
  fileName: string
  kind: PermitRecordKind
  authority: string | null
  /** `YYYY-MM-DD`, or null when the notice does not name its day. */
  issuedOn: string | null
  requirements: ReferencePermitRequirement[]
}

/** `start` and `end` are `YYYY-MM-DD`; an open end is null. */
export interface ReferencePeriod {
  start: string
  end: string | null
}

export interface SimilarProject {
  id: string
  name: string
  period: ReferencePeriod
  /** The Land, as its wizard label; null when the project names none. */
  bundesland: ReferenceFact<string> | null
  /** The OIB edition the project was planned under, as its token (`2019`); null when none is known. */
  oibEdition: ReferenceFact<string> | null
  /**
   * Whether the ranking found anything in common (`similarity.ts` above 0). A
   * closed project that shares nothing is still listed, after the alike ones,
   * by recency: the office may have few, and the reader should see them.
   */
  alike: boolean
  /**
   * What the project shares with the current one, as labels (`Niederösterreich`,
   * `GK 4`, `Holzbau`); `confirmed` false when either side only has it as a
   * suggestion read from its documents.
   */
  sharedTraits: ReferenceFact<string>[]
  decisions: ReferenceDecision[]
  permits: ReferencePermit[]
  /** How many decisions and permit records the project holds for this reader, before the page cuts them. */
  counts: { decisions: number; permits: number }
}

/** What the ranking compared: the current project's fingerprint, open facts included. */
export interface ReferenceBasis {
  facts: FingerprintFact[]
  /** Facts the briefing can still fill that are open; each one makes the ranking coarser. */
  missing: number
  /** The reader may complete the briefing: `project:edit`, which a closed project refuses. */
  editable: boolean
}

/** The similar-projects page: what it compared, the projects, and how many closed ones it left out. */
export interface SimilarProjectsPage {
  basis: ReferenceBasis
  projects: SimilarProject[]
  /** Closed projects the reader may open beyond {@link SIMILAR_PROJECTS_MAX}; Piloti searches them too. */
  more: number
}

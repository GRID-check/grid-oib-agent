/**
 * The cross-project lookups' wire contract (ADR-0085): what the agent's tools
 * send and what the BFF answers. The one description, in zod, shared by the
 * routes and the specs and exported as JSON Schema for the Python tier
 * (`cross-project-schema.ts`, `tests/fixtures/cross-project.schema.json`), as
 * ADR-0055 asks of a primitive with more than one consumer.
 *
 * No `server-only` and no drizzle: the browser may import the types.
 */

import { z } from 'zod'
import { PERMIT_RECORD_KINDS, PERMIT_REQUIREMENT_KINDS } from '@/lib/db/schema/permit-records'
import { DISCIPLINE_TAGS, DOCUMENT_TYPE_TAGS } from '@/lib/documents/tag-vocabulary'

/**
 * How many projects one search call searches at most: one collection search
 * per project (plus the restricted collections the reader may read), so this is
 * the bound on fan-out. A wider scope pages with `offset`.
 */
export const CROSS_PROJECT_PAGE_PROJECTS = 8
/** How many named projects one call may name. */
export const CROSS_PROJECT_MAX_NAMED = 20
/** How many hits one search returns at most, across every project it searched. */
export const CROSS_PROJECT_MAX_HITS = 20
/** How many projects one listing returns at most. */
export const CROSS_PROJECT_MAX_LISTED = 30
/** How many permit records one search returns at most, across every project it searched. */
export const CROSS_PROJECT_MAX_PERMITS = 8
/** How many of one permit record's requirements a search returns: the ones that matched. */
export const CROSS_PROJECT_MAX_PERMIT_REQUIREMENTS = 6

/** A project's life stage (ADR-0082). */
export const PROJECT_STATUSES = ['active', 'closed'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/**
 * Which projects a search covers: every one in reach ordered by likeness to the
 * current project (`similar`, the default), the closed ones, every one newest
 * first, or the ones it names. The conversation's own project is never part of
 * it: that one is searched by the chat's own tools, under its own scope.
 */
export const CROSS_PROJECT_SCOPES = ['similar', 'closed', 'all', 'named'] as const
export type CrossProjectScope = (typeof CROSS_PROJECT_SCOPES)[number]

/** A calendar day, `YYYY-MM-DD`, that is a real date. */
export const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
    message: 'Not a calendar day',
  })

export const crossProjectSearchRequestSchema = z.object({
  query: z.string().trim().min(2).max(500),
  scope: z.enum(CROSS_PROJECT_SCOPES).default('similar'),
  /** The projects a `named` scope searches; ignored for the others. Ids the reader may not open are skipped without a word. */
  projectIds: z.array(z.string().uuid()).max(CROSS_PROJECT_MAX_NAMED).default([]),
  /** Only documents tagged with one of these types (ingestion's closed vocabulary). */
  documentTypes: z.array(z.enum(DOCUMENT_TYPE_TAGS)).max(DOCUMENT_TYPE_TAGS.length).default([]),
  /** Only documents tagged with one of these OIB disciplines. */
  disciplines: z.array(z.enum(DISCIPLINE_TAGS)).max(DISCIPLINE_TAGS.length).default([]),
  /**
   * Only projects whose period overlaps `[from, to]`. A project's period, not a
   * document's upload day: archived projects are uploaded in bulk, so the day a
   * file arrived says nothing about when the work was done.
   */
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Where in the scope's project list this page starts; the previous answer's `nextOffset`. */
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(CROSS_PROJECT_MAX_HITS).default(10),
  /**
   * Search only what narrows nobody: no restricted folder's passage, decision or
   * permit, even in a chat whose reach includes the asker's cleared folders. The
   * turn's automatic first step asks this (ADR-0064's amendment); a restricted
   * folder stays a step the model takes with its own call.
   */
  openFoldersOnly: z.boolean().default(false),
})
export type CrossProjectSearchRequest = z.infer<typeof crossProjectSearchRequestSchema>

export const crossProjectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(PROJECT_STATUSES),
  /**
   * The project's Bundesland token (`wien`), null when its brief has none. A
   * precedent from another Land was decided under another Bauordnung, and the
   * agent says so: it cannot tell without the Land.
   */
  bundesland: z.string().nullable(),
})
export type CrossProjectRef = z.infer<typeof crossProjectRefSchema>

export const crossProjectHitSchema = z.object({
  project: crossProjectRefSchema,
  documentId: z.string(),
  filename: z.string(),
  /** The name a person gave the document, when one differs from the file name. */
  title: z.string().nullable(),
  /**
   * The retrieval collection the passage came from. The BFF recorded its
   * project (and, for a restricted folder's collection, the folder) on the
   * conversation before answering; the agent admits exactly these into the turn.
   */
  collection: z.string(),
  page: z.number().int().nullable(),
  snippet: z.string(),
  score: z.number(),
  tags: z.array(z.string()),
  uploadedAt: z.string(),
})
export type CrossProjectHit = z.infer<typeof crossProjectHitSchema>

/**
 * A decision another project recorded in its memory (`decision` or
 * `constraint`): what the project itself wrote down while it ran. Retrieved
 * before passages: short, comparable, and it says why.
 */
export const crossProjectDecisionSchema = z.object({
  project: crossProjectRefSchema,
  /** The project's retrieval collection: the decision's identity as a citable source. */
  collection: z.string(),
  kind: z.enum(['decision', 'constraint']),
  content: z.string(),
  /** A person confirmed, pinned or wrote it, rather than only the agent. */
  confirmed: z.boolean(),
  recordedAt: z.string(),
  /** It came from a folder with its own access list: it narrows who may read the chat, as such a passage does. */
  restricted: z.boolean(),
})
export type CrossProjectDecision = z.infer<typeof crossProjectDecisionSchema>

/** One thing a Bescheid demands or points out (permitting memory, docs/design/permitting-memory.md). */
export const crossProjectPermitRequirementSchema = z.object({
  kind: z.enum(PERMIT_REQUIREMENT_KINDS),
  /** The requirement, close to the document's words. */
  content: z.string(),
  /** What it asks as proof (a Gutachten, a Nachweis, a plan). */
  evidence: z.string().nullable(),
  /** The provision the document cites for it, as written. */
  legalBasis: z.string().nullable(),
  page: z.number().int().nullable(),
})
export type CrossProjectPermitRequirement = z.infer<typeof crossProjectPermitRequirementSchema>

/**
 * A Bescheid another project went through, read once at ingest: who issued it,
 * where, when, and the requirements of it that match the question. The agent
 * cites the DOCUMENT (file name and collection), so the record is a source like
 * a passage, retrieved before passages beside the decisions.
 */
export const crossProjectPermitSchema = z.object({
  project: crossProjectRefSchema,
  /** The document's retrieval collection: the project's own, or a restricted folder's. */
  collection: z.string(),
  fileName: z.string(),
  kind: z.enum(PERMIT_RECORD_KINDS),
  /** The issuing authority as the document names it; null when it does not name one. */
  authority: z.string().nullable(),
  /** The Gemeinde the procedure ran in, as the document writes it. */
  municipality: z.string().nullable(),
  issuedOn: isoDay.nullable(),
  /** Geschäftszahl or Aktenzahl. */
  reference: z.string().nullable(),
  /** Only the requirements that matched, best first. */
  requirements: z.array(crossProjectPermitRequirementSchema).max(CROSS_PROJECT_MAX_PERMIT_REQUIREMENTS),
  /** It came from a folder with its own access list: it narrows who may read the chat, as such a passage does. */
  restricted: z.boolean(),
})
export type CrossProjectPermit = z.infer<typeof crossProjectPermitSchema>

export const crossProjectSearchResponseSchema = z.object({
  /** Recorded decisions of the searched projects that match the question, best first; at most 6. */
  decisions: z.array(crossProjectDecisionSchema),
  /** Bescheide of the searched projects whose requirements match the question, best first; at most {@link CROSS_PROJECT_MAX_PERMITS}. */
  permits: z.array(crossProjectPermitSchema).max(CROSS_PROJECT_MAX_PERMITS),
  hits: z.array(crossProjectHitSchema),
  /** The projects in the scope the reader may open, the conversation's own left out. */
  projectsInScope: z.number().int(),
  /** How many of them this page searched. */
  projectsSearched: z.number().int(),
  /** The offset of the next page of projects, or null when this page reached the end. */
  nextOffset: z.number().int().nullable(),
  /** Always true since ticket 1 records project status; kept so older agents still parse the answer. */
  statusKnown: z.boolean(),
})
export type CrossProjectSearchResponse = z.infer<typeof crossProjectSearchResponseSchema>

export const crossProjectListRequestSchema = z.object({
  /** A part of the name or the address, case-insensitive. */
  query: z.string().trim().max(200).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  /** Only projects whose period overlaps `[from, to]`, as the search reads it. */
  from: isoDay.optional(),
  to: isoDay.optional(),
  /** Every project listed is recorded on the conversation, so the default stays small. */
  limit: z.number().int().min(1).max(CROSS_PROJECT_MAX_LISTED).default(10),
})
export type CrossProjectListRequest = z.infer<typeof crossProjectListRequestSchema>

export const crossProjectListedSchema = crossProjectRefSchema.extend({
  /**
   * The project's retrieval collection. Anything a lookup says about a project
   * is use of it, a name and an address included, so the BFF recorded the
   * project on the conversation before answering.
   */
  collection: z.string(),
  address: z.string().nullable(),
  /** The project's period, as days: its start, and its end once it has one (open until then). */
  period: z.object({ start: z.string(), end: z.string().nullable() }),
  /** Whether this is the project the conversation runs in. */
  current: z.boolean(),
})
export type CrossProjectListed = z.infer<typeof crossProjectListedSchema>

export const crossProjectListResponseSchema = z.object({
  projects: z.array(crossProjectListedSchema),
  /** How many projects matched before `limit` cut the list. */
  total: z.number().int(),
  statusKnown: z.boolean(),
})
export type CrossProjectListResponse = z.infer<typeof crossProjectListResponseSchema>

export const crossProjectBriefRequestSchema = z.object({
  projectId: z.string().uuid(),
})
export type CrossProjectBriefRequest = z.infer<typeof crossProjectBriefRequestSchema>

export const crossProjectBriefResponseSchema = z.object({
  project: crossProjectListedSchema,
  /** The brief's summary prose, when one was generated. */
  summary: z.string().nullable(),
  /** The confirmed facts, goals, open points and assumptions, in the agent's PROJECT_CONTEXT grammar. */
  facts: z.string(),
})
export type CrossProjectBriefResponse = z.infer<typeof crossProjectBriefResponseSchema>

/** Every schema the Python tier reads, by the name it looks it up under. */
export const CROSS_PROJECT_WIRE_SCHEMAS = {
  CrossProjectSearchRequest: crossProjectSearchRequestSchema,
  CrossProjectSearchResponse: crossProjectSearchResponseSchema,
  CrossProjectPermit: crossProjectPermitSchema,
  CrossProjectListRequest: crossProjectListRequestSchema,
  CrossProjectListResponse: crossProjectListResponseSchema,
  CrossProjectBriefRequest: crossProjectBriefRequestSchema,
  CrossProjectBriefResponse: crossProjectBriefResponseSchema,
} as const

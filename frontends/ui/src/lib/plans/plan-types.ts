/**
 * The research plan: what a deep research is about, as one record every
 * tier reads (ADR-0068).
 *
 * Before this the plan was prose in an agent message and a chat reply the
 * reader owed. It is now a row of its own, created by the agent's clarifier
 * or by a reader in the „Auftrag planen" dialog, edited on the run block,
 * and read by the worker at the instant the run may start. This file is the
 * one definition; `plan-schema.ts` exports it as JSON Schema for the Python
 * mirror (`src/aiq_agent/common/research_plan.py`), the same arrangement the
 * run ledger uses.
 *
 * The lifecycle, and the one rule each transition enforces:
 *
 *   proposed ──(Anpassen)──▶ held ──(Starten)──▶ approved ──(worker)──▶ started
 *      │                                            ▲
 *      └──────────(Starten, or startsAt passes)─────┘
 *
 * - `proposed` carries `startsAt`: the instant the run may start on its own.
 *   Null under a deployment that asks first; then the plan behaves as held.
 * - `held` never starts on its own. A person pressed „Anpassen", or the
 *   deployment asks before every run.
 * - `approved` starts at the worker's next poll.
 * - `started` is read-only: the worker read the plan at that instant, and a
 *   later edit would describe a plan the run is not running.
 * - `superseded`: a newer plan replaced this one (a carried-forward run).
 */

import { z } from 'zod'
import { MAX_PLAN_DOCUMENTS, planDocumentSchema } from '@/lib/runs/plan-documents'

export const PLAN_GENRES = ['pruefbericht', 'aktenvermerk', 'vergleich', 'checkliste', 'bericht'] as const
export type PlanGenre = (typeof PLAN_GENRES)[number]

export const PLAN_DEPTHS = ['kurzpruefung', 'gutachten'] as const
export type PlanDepth = (typeof PLAN_DEPTHS)[number]

export const PLAN_STATUSES = ['proposed', 'held', 'approved', 'started', 'superseded'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

/** The states in which the plan may still be edited, held or started. */
export const EDITABLE_PLAN_STATUSES = ['proposed', 'held', 'approved'] as const satisfies readonly PlanStatus[]
export const isEditablePlanStatus = (status: PlanStatus): boolean =>
  (EDITABLE_PLAN_STATUSES as readonly PlanStatus[]).includes(status)

export const PLAN_AUTHORS = ['agent', 'user'] as const
export type PlanAuthor = (typeof PLAN_AUTHORS)[number]

export const MAX_PLAN_SECTIONS = 12
export const MAX_PLAN_SECTION_CHARS = 200
export const MAX_PLAN_TITLE_CHARS = 200
export const MAX_PLAN_QUESTION_CHARS = 500
export const MAX_PLAN_INVENTORY_ROWS = 200
export const MAX_PLAN_DATA_SOURCES = 32
const MAX_ID_CHARS = 64
const MAX_DATA_SOURCE_CHARS = 64
/** The grace a proposed plan waits before it starts on its own, bounded so a payload cannot park a run for a day. */
export const MAX_PLAN_GRACE_SECONDS = 600

const instantSchema = z.string().datetime({ offset: true })
const idSchema = z.string().trim().min(1).max(MAX_ID_CHARS)

export const planSectionsSchema = z
  .array(z.string().trim().min(1).max(MAX_PLAN_SECTION_CHARS))
  .min(1)
  .max(MAX_PLAN_SECTIONS)

const documentNamesSchema = z.array(z.string().trim().min(1).max(256)).max(MAX_PLAN_DOCUMENTS)
const dataSourcesSchema = z.array(z.string().trim().min(1).max(MAX_DATA_SOURCE_CHARS)).max(MAX_PLAN_DATA_SOURCES)

/** The plan as every client reads it. */
export const researchPlanSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    conversationId: idSchema.nullable(),
    /** The run this plan was commissioned into; null until it is. */
    runId: idSchema.nullable(),
    author: z.enum(PLAN_AUTHORS),
    status: z.enum(PLAN_STATUSES),
    question: z.string().trim().min(1).max(MAX_PLAN_QUESTION_CHARS),
    title: z.string().trim().min(1).max(MAX_PLAN_TITLE_CHARS),
    sections: planSectionsSchema,
    genre: z.enum(PLAN_GENRES),
    depth: z.enum(PLAN_DEPTHS),
    grundlage: z.array(planDocumentSchema).max(MAX_PLAN_DOCUMENTS),
    ausgeschlossen: z.array(planDocumentSchema).max(MAX_PLAN_DOCUMENTS),
    /**
     * „Nur diese": of the reader's own documents only the Grundlage may be
     * used. Off, the run reads whatever it finds and the Grundlage is its
     * focus. Never true without a Grundlage (the table's CHECK says so).
     */
    nurGrundlage: z.boolean(),
    /** The Rahmen: the sources the run may draw on. Null keeps the worker's default. */
    dataSources: dataSourcesSchema.nullable(),
    /** What the card may name: the inventory the plan was drafted against. */
    unterlagen: z.array(planDocumentSchema).max(MAX_PLAN_INVENTORY_ROWS),
    /** When a proposed plan starts on its own; null when it waits for a person. */
    startsAt: instantSchema.nullable(),
    heldAt: instantSchema.nullable(),
    approvedAt: instantSchema.nullable(),
    startedAt: instantSchema.nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict()

export type ResearchPlan = z.infer<typeof researchPlanSchema>

/**
 * A plan as it is proposed: by the clarifier (through the internal tasks
 * route) or by a reader (through the project route). Documents are named by
 * file name and resolved against `unterlagen` on the BFF, once, for every
 * client.
 */
export const researchPlanDraftSchema = z
  .object({
    question: z.string().trim().min(1).max(MAX_PLAN_QUESTION_CHARS),
    title: z.string().trim().min(1).max(MAX_PLAN_TITLE_CHARS).optional(),
    sections: planSectionsSchema,
    genre: z.enum(PLAN_GENRES).default('bericht'),
    depth: z.enum(PLAN_DEPTHS).default('gutachten'),
    grundlage: documentNamesSchema.default([]),
    ausgeschlossen: documentNamesSchema.default([]),
    nurGrundlage: z.boolean().default(false),
    dataSources: dataSourcesSchema.nullable().optional(),
    unterlagen: z.array(planDocumentSchema).max(MAX_PLAN_INVENTORY_ROWS).default([]),
  })
  .strict()

export type ResearchPlanDraft = z.infer<typeof researchPlanDraftSchema>
export type ResearchPlanDraftInput = z.input<typeof researchPlanDraftSchema>

/**
 * What a reader may change on the block, until the plan is started. Not the
 * Rahmen: the worker filters its tools by the sources it was submitted with,
 * so the data sources are fixed when the run is commissioned.
 */
export const researchPlanEditSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_PLAN_TITLE_CHARS).optional(),
    sections: planSectionsSchema.optional(),
    genre: z.enum(PLAN_GENRES).optional(),
    depth: z.enum(PLAN_DEPTHS).optional(),
    grundlage: documentNamesSchema.optional(),
    ausgeschlossen: documentNamesSchema.optional(),
    nurGrundlage: z.boolean().optional(),
    /**
     * Documents the reader named from the project's own listing that the
     * inventory the plan was drafted against does not hold. Merged into
     * `unterlagen` before the names resolve, so a plan the agent drafted with
     * no inventory can still be told what to read.
     */
    unterlagen: z.array(planDocumentSchema).max(MAX_PLAN_DOCUMENTS * 2).optional(),
  })
  .strict()

export type ResearchPlanEdit = z.infer<typeof researchPlanEditSchema>

/** How a proposed plan starts: on its own after a grace, or only when a person says so. */
export const PLAN_START_POLICIES = ['auto', 'ask'] as const
export type PlanStartPolicy = (typeof PLAN_START_POLICIES)[number]

/** The schemas exported to JSON Schema for the Python tier, by name. */
export const RESEARCH_PLAN_WIRE_SCHEMAS = {
  researchPlan: researchPlanSchema,
  researchPlanDraft: researchPlanDraftSchema,
  researchPlanEdit: researchPlanEditSchema,
} as const

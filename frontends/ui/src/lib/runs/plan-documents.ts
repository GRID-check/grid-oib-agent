/**
 * The Unterlagen a reader names for a run: the plan card's Grundlage (read in
 * full) and Ausgeschlossen (never used). The mirror of
 * `src/aiq_agent/common/plan_documents.py`, bounded the same way, so a list the
 * card sends is a list every tier accepts.
 *
 * Identity is the knowledge layer's own: the file name as the inventory lists
 * it (ADR-0047). The shelf and the title travel beside it for display.
 */

import { z } from 'zod'

export const MAX_PLAN_DOCUMENTS = 20
const MAX_NAME_CHARS = 256
const MAX_TITLE_CHARS = 256
const MAX_SHELF_CHARS = 64

export const planDocumentSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_CHARS),
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
    shelf: z.string().trim().min(1).max(MAX_SHELF_CHARS).optional(),
  })
  .strict()

export type PlanDocument = z.infer<typeof planDocumentSchema>

export const planDocumentsSchema = z
  .object({
    grundlage: z.array(planDocumentSchema).max(MAX_PLAN_DOCUMENTS).default([]),
    ausgeschlossen: z.array(planDocumentSchema).max(MAX_PLAN_DOCUMENTS).default([]),
  })
  .strict()

export type PlanDocuments = z.infer<typeof planDocumentsSchema>

/** The label a document is shown under: its title when it has one, else its name. */
export const planDocumentLabel = (doc: PlanDocument): string => doc.title ?? doc.name

/** Nothing named on either list. */
export const isEmptyPlanDocuments = (docs: PlanDocuments | null | undefined): boolean =>
  !docs || (docs.grundlage.length === 0 && docs.ausgeschlossen.length === 0)

/**
 * Reduce an untrusted payload to the contract, or null when nothing survives.
 * A name on both lists is excluded (the stricter intention wins); the caps
 * apply after deduplication, case-folded.
 */
export function sanitizePlanDocuments(input: unknown): PlanDocuments | null {
  const parsed = z
    .object({ grundlage: z.array(z.unknown()).optional(), ausgeschlossen: z.array(z.unknown()).optional() })
    .safeParse(input)
  if (!parsed.success) return null
  const seen = new Set<string>()
  const take = (rows: unknown[] | undefined): PlanDocument[] => {
    const out: PlanDocument[] = []
    for (const raw of rows ?? []) {
      if (out.length >= MAX_PLAN_DOCUMENTS) break
      const row = typeof raw === 'string' ? { name: raw } : raw
      const doc = planDocumentSchema.safeParse(row)
      if (!doc.success) continue
      const key = doc.data.name.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(doc.data)
    }
    return out
  }
  const ausgeschlossen = take(parsed.data.ausgeschlossen)
  const grundlage = take(parsed.data.grundlage)
  if (grundlage.length === 0 && ausgeschlossen.length === 0) return null
  return { grundlage, ausgeschlossen }
}

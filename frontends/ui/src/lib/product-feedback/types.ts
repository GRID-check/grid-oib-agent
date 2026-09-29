/**
 * Product feedback — request schemas and wire shapes.
 *
 * No `'server-only'`: the form and the platform triage list import the wire
 * types and the bounds. The value sets live beside the table
 * (`@/lib/db/schema/product-feedback`) so schema, CHECK and validation cannot
 * drift apart.
 */

import { z } from 'zod'
import {
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_PAGE_MAX,
  PRODUCT_FEEDBACK_STATUSES,
  type ProductFeedbackContext,
  type ProductFeedbackKind,
  type ProductFeedbackStatus,
} from '@/lib/db/schema/product-feedback'

export {
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_PAGE_MAX,
  PRODUCT_FEEDBACK_STATUSES,
}
export type { ProductFeedbackContext, ProductFeedbackKind, ProductFeedbackStatus }

/** The shortest message worth sending: "Bug" says nothing a platform owner can act on. */
export const PRODUCT_FEEDBACK_MESSAGE_MIN = 10

const contextString = (max: number) => z.string().trim().max(max).optional()

/**
 * An app path, never a URL. Anything that is not a plain `/path` is dropped
 * rather than refused: the path is a convenience for triage and a malformed one
 * must not cost the reporter their report.
 */
const pagePathSchema = z
  .string()
  .trim()
  .max(PRODUCT_FEEDBACK_PAGE_MAX)
  .nullish()
  .transform((value) => (value && /^\/[^\s?#]*$/.test(value) ? value : null))

/** POST /api/feedback/reports */
export const submitProductFeedbackSchema = z.object({
  kind: z.enum(PRODUCT_FEEDBACK_KINDS),
  message: z.string().trim().min(PRODUCT_FEEDBACK_MESSAGE_MIN).max(PRODUCT_FEEDBACK_MESSAGE_MAX),
  pagePath: pagePathSchema,
  allowContact: z.boolean().default(true),
  context: z
    .object({
      userAgent: contextString(500),
      viewport: contextString(40),
      locale: contextString(40),
      timeZone: contextString(80),
      appVersion: contextString(80),
    })
    .strip()
    .default({}),
})

export type SubmitProductFeedbackInput = z.infer<typeof submitProductFeedbackSchema>

/** What the reporter gets back: enough to say "thank you", nothing more. */
export interface SubmittedProductFeedbackView {
  id: string
  kind: ProductFeedbackKind
  createdAt: string
}

/** GET /api/platform/feedback */
export const listProductFeedbackQuerySchema = z.object({
  status: z.enum(PRODUCT_FEEDBACK_STATUSES).optional(),
  kind: z.enum(PRODUCT_FEEDBACK_KINDS).optional(),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
})

export type ListProductFeedbackQuery = z.infer<typeof listProductFeedbackQuerySchema>

/** PATCH /api/platform/feedback/[id] */
export const triageProductFeedbackSchema = z.object({
  status: z.enum(PRODUCT_FEEDBACK_STATUSES),
})

/** One report as the platform triage page receives it. */
export interface ProductFeedbackReportView {
  id: string
  kind: ProductFeedbackKind
  status: ProductFeedbackStatus
  message: string
  pagePath: string | null
  context: ProductFeedbackContext
  allowContact: boolean
  organizationId: string
  organizationName: string | null
  reporter: { userId: string; name: string | null; email: string | null }
  triagedBy: string | null
  triagedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProductFeedbackListResponse {
  reports: ProductFeedbackReportView[]
  counts: Record<ProductFeedbackStatus, number>
  nextCursor: string | null
}

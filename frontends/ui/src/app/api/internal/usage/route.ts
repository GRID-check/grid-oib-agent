/**
 * INTERNAL service endpoint — the single write path into the `llm_usage_events`
 * ledger. The backend's unified cost tracker
 * (src/aiq_agent/common/cost_tracking.py) POSTs one batch per flush; grid_app
 * stays single-writer. Token-guarded; not user-facing.
 */

import { z } from 'zod'
import { COST_SOURCES, USAGE_ACTIVITIES } from '@/lib/db/schema'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withTenant } from '@/lib/db/tenant-context'
import { recordUsageEvents } from '@/lib/budgets/service'

const usageEventSchema = z.object({
  model: z.string().max(200).nullable().optional(),
  requestedModel: z.string().max(200).nullable().optional(),
  generationId: z.string().max(120).nullable().optional(),
  promptTokens: z.number().int().min(0).default(0),
  completionTokens: z.number().int().min(0).default(0),
  totalTokens: z.number().int().min(0).default(0),
  cachedTokens: z.number().int().min(0).default(0),
  reasoningTokens: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).finite().default(0),
  costSource: z.enum(COST_SOURCES).default('missing'),
  isByok: z.boolean().nullable().optional(),
  /** What the call was for when it was not an agent's chat completion (stored as `agent_group`). */
  role: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable()
    .optional(),
})

const usageBatchSchema = z.object({
  organizationId: z.string().min(1).max(120).nullable(),
  userId: z.string().max(120).nullable().optional(),
  projectId: z.string().max(120).nullable().optional(),
  conversationId: z.string().max(255).nullable().optional(),
  jobId: z.string().max(255).nullable().optional(),
  /** The chat answer the batch's spend belongs to (`turn.response.answer_message_id`). */
  messageId: z.string().max(128).nullable().optional(),
  /** The kind of work the whole batch served (`ingest` for a document ingestion job). */
  activity: z.enum(USAGE_ACTIVITIES).nullable().optional(),
  events: z.array(usageEventSchema).min(1).max(100),
})

export const POST = internalApiRoute(
  'Internal Usage',
  async ({ request }) => {
    const batch = await parseJsonBody(request, usageBatchSchema)

    // Anonymous deployments (REQUIRE_AUTH=false) have no org; those events are
    // not attributable to a tenant and are dropped deliberately (documented).
    if (!batch.organizationId) {
      return { recorded: 0, skipped: batch.events.length }
    }

    // The ledger row is the tenant's own; the scope makes the database agree.
    const recorded = await withTenant({ organizationId: batch.organizationId }, () =>
      recordUsageEvents(
      batch.events.map((event) => ({
        organizationId: batch.organizationId as string,
        userId: batch.userId ?? null,
        projectId: batch.projectId ?? null,
        conversationId: batch.conversationId ?? null,
        jobId: batch.jobId ?? null,
        messageId: batch.messageId ?? null,
        activity: batch.activity ?? null,
        agentGroup: event.role ?? null,
        requestedModel: event.requestedModel ?? null,
        model: event.model ?? null,
        generationId: event.generationId ?? null,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        cachedTokens: event.cachedTokens,
        reasoningTokens: event.reasoningTokens,
        costUsd: event.costUsd.toFixed(8),
        costSource: event.costSource,
        isByok: event.isByok ?? null,
      }))
      )
    )
    return { recorded }
  },
  { status: 202, tenancy: { fromPayload: 'body.organizationId' } }
)

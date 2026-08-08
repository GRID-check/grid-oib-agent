/**
 * INTERNAL service endpoint — the single write path into the
 * `agent_profiler_spans` ledger. The backend's agent profiler
 * (src/aiq_agent/common/profiler.py) POSTs one batch per flush, mirroring
 * `api/internal/usage/route.ts`; grid_app stays single-writer.
 */

import { z } from 'zod'
import { SPAN_KINDS, SPAN_STATUSES } from '@/lib/db/schema'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withOptionalTenant } from '@/lib/db/tenant-context'
import { recordProfilerSpans } from '@/lib/profiler/service'

const spanSchema = z.object({
  spanId: z.string().min(1).max(64),
  parentSpanId: z.string().max(64).nullable().optional(),
  kind: z.enum(SPAN_KINDS),
  name: z.string().min(1).max(200),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
  durationMs: z.number().int().min(0),
  status: z.enum(SPAN_STATUSES).default('ok'),
  errorMessage: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
})

const spanBatchSchema = z.object({
  organizationId: z.string().max(120).nullable().optional(),
  conversationId: z.string().max(255).nullable().optional(),
  turnId: z.string().min(1).max(64),
  jobId: z.string().max(255).nullable().optional(),
  spans: z.array(spanSchema).min(1).max(200),
})

export const POST = internalApiRoute(
  'Internal Agent Profiler Spans',
  async ({ request }) => {
    const batch = await parseJsonBody(request, spanBatchSchema)

    // `organization_id` is nullable on this table: a turn from a session with
    // no organization produces a row that belongs to no tenant and cannot
    // satisfy any tenant predicate. Such rows are written outside the boundary
    // and stay visible only to the platform tier.
    const recorded = await withOptionalTenant(
      batch.organizationId,
      'profiler spans from a turn with no organization selected belong to no tenant',
      () => recordProfilerSpans(
      batch.spans.map((span) => ({
        organizationId: batch.organizationId ?? null,
        conversationId: batch.conversationId ?? null,
        turnId: batch.turnId,
        jobId: batch.jobId ?? null,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? null,
        kind: span.kind,
        name: span.name,
        startedAt: new Date(span.startedAt),
        endedAt: new Date(span.endedAt),
        durationMs: span.durationMs,
        status: span.status,
        errorMessage: span.errorMessage ?? null,
        metadata: span.metadata ?? null,
      }))
      )
    )
    return { recorded }
  },
  { status: 202, tenancy: { fromPayload: 'body.organizationId (nullable)' } }
)

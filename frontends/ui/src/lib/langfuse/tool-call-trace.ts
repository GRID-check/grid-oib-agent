import 'server-only'
/**
 * One MCP tool call on the agent door as a Langfuse trace (ADR-0089, ADR-0122):
 * the trace `agent-tool-call` holding one `TOOL` observation named
 * `mcp.<operation>`, or `a2a.<operation>` for the A2A door's call of an ask
 * route (ADR-0124). Everything the product does is observable in Langfuse, and
 * an agent's call is something the product does: which operation, for which
 * door, run or proposed, with what status and how long it took.
 *
 * ## What it carries
 *
 * Names, codes and numbers, never the call's input or its answer: an agent
 * quotes documents and people, and the PostHog twin of this record
 * (`agent_operation_called`, `lib/agent-api/telemetry.ts`) keeps the same rule.
 * An unknown operation name is the agent's own text and is recorded as
 * `unknown`. The session is the conversation when Piloti made the call, so the
 * call sits beside the chat turn that asked for it. The person is named only
 * under `GRID_TRACE_IDENTITY_ATTRIBUTES=true`, the gate every other trace uses
 * (`docs/observability/langfuse.md`).
 *
 * ## Best-effort
 *
 * Posted through the ingestion API without waiting: a tool call never waits for,
 * or fails because of, Langfuse. With Langfuse unconfigured nothing is sent
 * (`langfuseApiConfig`, which has no default host on purpose).
 */

import { LangfuseClient } from '@langfuse/client'
import { type LangfuseApiConfig, langfuseApiConfig } from './config'

/** The trace name an analyst filters on (`docs/observability/langfuse.md`, the trace-name table). */
export const TOOL_CALL_TRACE_NAME = 'agent-tool-call'

export interface ToolCallRecord {
  /** A catalog or meta-tool name, or null for a name no operation has. */
  operation: string | null
  domain: string | null
  /** `mcp` for an external agent, `piloti` for Piloti in-product, `a2a` for the A2A door, `platform` for the platform door. */
  door: 'mcp' | 'piloti' | 'a2a' | 'platform'
  /** The MCP server's mode; null on the A2A door. */
  mode: 'search' | 'tools' | null
  /**
   * `confirm`: put to the person in their own chat; `declined`: they did not
   * confirm; `person_required`: not run, the client cannot ask the person
   * (`agent-api/confirmation.ts`).
   */
  decision: 'run' | 'propose' | 'refused' | 'confirm' | 'declined' | 'person_required'
  /** `elicitation` when the person confirmed this call in their own chat; otherwise absent. */
  decisionSource?: 'elicitation' | null
  status: number
  startedAt: number
  endedAt: number
  clientId: string | null
  organizationId: string
  userId: string
  conversationId?: string | null
}

type IngestionBatch = Parameters<LangfuseClient['api']['ingestion']['batch']>[0]

/** Langfuse's environment alphabet, as `trace_context.langfuse_environment` coerces `APP_ENV`. Shared by the BFF's traces. */
export function environment(raw = process.env.APP_ENV ?? ''): string | undefined {
  const value = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return value && !value.startsWith('langfuse') ? value : undefined
}

/** The deployed commit, as a trace's release; none when unknown. */
export function release(raw = process.env.GRID_GIT_SHA ?? ''): string | undefined {
  const value = raw.trim()
  return value && value !== 'unknown' ? value : undefined
}

const identityOn = () => process.env.GRID_TRACE_IDENTITY_ATTRIBUTES?.trim().toLowerCase() === 'true'

/** The ingestion batch for one call. Pure, so the mapping is tested without a network. */
export function toolCallBatch(call: ToolCallRecord, ids: { traceId: string; observationId: string; eventIds: [string, string] }): IngestionBatch {
  const env = environment()
  const rel = release()
  const name = `${call.door === 'a2a' ? 'a2a' : 'mcp'}.${call.operation ?? 'unknown'}`
  const startTime = new Date(call.startedAt).toISOString()
  const endTime = new Date(call.endedAt).toISOString()
  const metadata = {
    operation: call.operation ?? 'unknown',
    domain: call.domain,
    door: call.door,
    mode: call.mode,
    decision: call.decision,
    ...(call.decisionSource ? { decision_source: call.decisionSource } : {}),
    status: call.status,
    duration_ms: call.endedAt - call.startedAt,
    client_id: call.clientId,
  }
  const identity = identityOn()
  return {
    batch: [
      {
        type: 'trace-create',
        id: ids.eventIds[0],
        timestamp: startTime,
        body: {
          id: ids.traceId,
          timestamp: startTime,
          name: TOOL_CALL_TRACE_NAME,
          metadata,
          tags: [
            'feature:agent-mcp',
            `door:${call.door}`,
            `decision:${call.decision}`,
            ...(call.status >= 400 ? [`error:${call.status}`] : []),
            ...(identity ? [`org:${call.organizationId}`] : []),
          ],
          ...(call.conversationId ? { sessionId: call.conversationId } : {}),
          ...(identity ? { userId: call.userId } : {}),
          ...(env ? { environment: env } : {}),
          ...(rel ? { release: rel } : {}),
        },
      },
      {
        type: 'observation-create',
        id: ids.eventIds[1],
        timestamp: startTime,
        body: {
          id: ids.observationId,
          traceId: ids.traceId,
          type: 'TOOL',
          name,
          startTime,
          endTime,
          metadata,
          level: call.status >= 500 ? 'ERROR' : call.status >= 400 ? 'WARNING' : 'DEFAULT',
          ...(call.status >= 400 ? { statusMessage: `HTTP ${call.status}` } : {}),
          ...(env ? { environment: env } : {}),
        },
      },
    ],
  }
}

let cached: { key: string; client: LangfuseClient } | null = null

/** One ingestion client per configuration, shared by the BFF's own traces. */
export function clientFor(config: LangfuseApiConfig): LangfuseClient {
  const key = `${config.baseUrl}\u0000${config.publicKey}\u0000${config.secretKey}`
  if (cached?.key !== key) {
    cached = {
      key,
      client: new LangfuseClient({ publicKey: config.publicKey, secretKey: config.secretKey, baseUrl: config.baseUrl, timeout: 5 }),
    }
  }
  return cached.client
}

/** A 32-hex trace id, the form the agent writes and `isTraceId` accepts. */
const hexId = () => crypto.randomUUID().replace(/-/g, '')

/**
 * Post `call` as its trace. Resolves when sent (or skipped) and never rejects;
 * callers do not await it.
 */
export async function recordToolCallTrace(call: ToolCallRecord): Promise<void> {
  const config = langfuseApiConfig()
  if (!config) return
  try {
    const batch = toolCallBatch(call, {
      traceId: hexId(),
      observationId: crypto.randomUUID(),
      eventIds: [crypto.randomUUID(), crypto.randomUUID()],
    })
    await clientFor(config).api.ingestion.batch(batch, { timeoutInSeconds: 5, maxRetries: 1 })
  } catch (error) {
    console.warn('[Langfuse] tool call trace failed (non-fatal):', error)
  }
}

import 'server-only'
/**
 * What the agent door records about each call (ADR-0119, ADR-0089).
 *
 *  - PostHog, through the collector: `agent_operation_called` and
 *    `agent_operation_missing` (`docs/observability/posthog-events.md`), for
 *    product analytics: which operations agents use and which they miss.
 *  - Langfuse: one `agent-tool-call` trace per MCP tool call and per A2A
 *    method's call of an ask route (`lib/langfuse/tool-call-trace.ts`), the
 *    observability platform's view of the same call, beside the chat turns it
 *    belongs to.
 *
 * Properties are scalars the catalog and the route already know. The text of an
 * agent's request never goes in: an agent quotes documents and names, and the
 * server events are non-personal by rule, so `agent_operation_missing` sends
 * the length of the description only.
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import { recordToolCallTrace } from '@/lib/langfuse/tool-call-trace'
import type { Confirmation } from './confirmation'
import type { CallDecision } from './policy'
import type { AgentPrincipal } from './principal'

export type McpMode = 'search' | 'tools'

/**
 * Where a call came in: the office MCP server for an external agent or for
 * Piloti, the A2A door, or the platform door (`/api/platform/mcp`, ADR-0126).
 */
export type CallDoor = 'mcp' | 'piloti' | 'a2a' | 'platform'

export interface McpCallContext {
  principal: AgentPrincipal
  /** The MCP server's mode; null on the A2A door, which has none. */
  mode: McpMode | null
  /** Set by a door that is not the MCP server (`a2a`); otherwise read from the principal. */
  door?: CallDoor
  /**
   * Set on a 2026-07-28 request of an outside agent when a signing key exists:
   * a destructive write is put to the person first (`confirmation.ts`). Absent,
   * every call takes its path unchanged.
   */
  confirmation?: Confirmation | null
  /** `elicitation` on the round that runs a call the person confirmed in their own chat. */
  decisionSource?: 'elicitation'
}

/**
 * What became of a call: run or proposed (`CallDecision`), refused, put to the
 * person to confirm (`confirm`), not confirmed by them (`declined`), or not
 * run because it needs the person's yes and this client cannot ask for it
 * (`person_required`, `confirmation.ts`). The last is not `refused`: nothing
 * the caller may not do was asked, and counting it there would hide how often
 * a client without form elicitation reaches for an operation it cannot run.
 */
export type RecordedDecision = CallDecision | 'refused' | 'confirm' | 'declined' | 'person_required'

function doorOf({ principal, door }: McpCallContext): CallDoor {
  if (door) return door
  if (principal.door === 'platform') return 'platform'
  return principal.actor === 'external_agent' ? 'mcp' : 'piloti'
}

export function recordOperationCalled(
  ctx: McpCallContext,
  call: {
    /** A catalog name, or null for a name no operation has: that is the agent's own text. */
    operation: string | null
    domain: string | null
    decision: RecordedDecision
    status: number
    startedAt: number
  },
): void {
  const { principal, mode } = ctx
  const endedAt = Date.now()
  // Not awaited: a call never waits for, or fails because of, Langfuse.
  void recordToolCallTrace({
    operation: call.operation,
    domain: call.domain,
    door: doorOf(ctx),
    mode,
    decision: call.decision,
    ...(ctx.decisionSource ? { decisionSource: ctx.decisionSource } : {}),
    status: call.status,
    startedAt: call.startedAt,
    endedAt,
    clientId: principal.clientId,
    organizationId: principal.session.organizationId,
    userId: principal.session.userId,
    conversationId: principal.conversationId ?? null,
  })
  captureServer({
    event: 'agent_operation_called',
    distinctId: principal.session.userId,
    organizationId: principal.session.organizationId,
    properties: {
      operation: call.operation,
      domain: call.domain,
      door: doorOf(ctx),
      mode,
      decision: call.decision,
      ...(ctx.decisionSource ? { decision_source: ctx.decisionSource } : {}),
      status: call.status,
      duration_ms: endedAt - call.startedAt,
      client_id: principal.clientId,
    },
  })
}

export function recordOperationMissing(ctx: McpCallContext, descriptionLength: number, category: string): void {
  const { principal, mode } = ctx
  captureServer({
    event: 'agent_operation_missing',
    distinctId: principal.session.userId,
    organizationId: principal.session.organizationId,
    properties: {
      description_length: descriptionLength,
      category,
      door: doorOf(ctx),
      mode,
      client_id: principal.clientId,
    },
  })
}

/**
 * Proposed operations (`operation`, ADR-0122): any WRITE operation of the
 * agent catalog that Piloti called through the MCP surface, held as a proposal
 * until a person accepts it.
 *
 * Accepting runs it AS THE ACCEPTING PERSON through `callOperation`, the
 * dispatcher the MCP server itself uses, so the operation's route decides:
 * its `authz`, its rate limit, its tenant slot and its own body schema. The
 * proposal adds no second rule; `DECIDE_PERMISSIONS.operation` is only the
 * right to see the project, and an organization-scoped one (no project, 0176)
 * needs nothing but the right to read it.
 *
 * Two outcomes, as for every kind (`./appliers.ts`). What belongs to the
 * proposal is a failed result with the reason: the operation left the catalog,
 * or became read-only, sensitive or hidden from Piloti since it was proposed,
 * its input no longer fits, or the
 * route answered with a refusal (its own message). A refusal of the decider is
 * not special-cased: the route's 403 is the route's message, and the proposal
 * is `failed` with it.
 */

import 'server-only'
import { UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { callOperation, OperationInputError, validateOperationInput } from '@/lib/agent-api/dispatch'
import { findOperation } from '@/lib/agent-api/catalog'
import { annotationsOf, type AgentOperation } from '@/lib/agent-api/operation'
import { isOnDoor } from '@/lib/agent-api/exposure'
import { isPilotiAskOperation } from '@/lib/piloti-asks/ask-wire'
import type { OperationPayload, ProposedChangeResult } from './types'

/**
 * Why Piloti never asks Piloti (ADR-0124, the recursion lock): every operation
 * Piloti's own door reaches arrives here as a proposal, so refusing an ask here
 * is what keeps a turn, a turn an ask started included, from starting another.
 */
export const PILOTI_ASK_REFUSAL =
  'Piloti cannot ask Piloti: an ask is how another agent consults Piloti, and a turn may not start another.'

/**
 * The person's own decisions: deciding a proposal and undoing a change Piloti
 * made. A proposal is how the person says yes or no to Piloti (ADR-0105); a
 * card that applies or dismisses another proposal would turn one click on a
 * card the agent worded into a yes to a change the person never read, and an
 * undo the agent proposes is the same decision made for them. Piloti does not
 * see them either (`exposure.config.ts`, `piloti: false`); this is the
 * applier's own reason, kept whatever the config says.
 */
export const PROPOSAL_DECISION_OPERATIONS: ReadonlySet<string> = new Set([
  'proposal-apply',
  'proposal-dismiss',
  'piloti-change-undo',
])

/** Why Piloti never files a decision on a proposal, nor an undo: the person makes those ({@link PROPOSAL_DECISION_OPERATIONS}). */
export const PROPOSAL_DECISION_REFUSAL =
  'Piloti cannot apply, dismiss or undo a change for the person: they decide that themselves, on its own card.'

/**
 * Why `name` cannot be applied as a proposal, or null when it can: it exists, it
 * writes, it is no ask, and Piloti may propose it. Every operation proposal is
 * Piloti's (`proposeOperation` files them), and Piloti never proposes a sensitive
 * operation nor one of a domain it does not see (`policy.ts`). Asked again
 * here, at the click, because the catalog may have changed since the proposal
 * was filed: an operation that became sensitive or hidden, or left the door,
 * since then is not run on a card the agent worded.
 */
function unusableReason(op: AgentOperation | undefined, name: string): string | null {
  if (isPilotiAskOperation(name)) return PILOTI_ASK_REFUSAL
  // Withheld or off the office door reads as unknown, here as on every door (`isOnDoor`). Hidden from
  // Piloti behind a native tool (`exposure.config.ts`) is still on the door: a card filed before applies.
  if (!op || !isOnDoor(op.name)) return `The operation ${name} no longer exists`
  if (annotationsOf(op).readOnlyHint) return `The operation ${name} only reads, so there is nothing to apply`
  if (op.sensitivity) return `The operation ${name} is not one Piloti may propose; make the change in Piloti yourself`
  if (PROPOSAL_DECISION_OPERATIONS.has(op.name)) return PROPOSAL_DECISION_REFUSAL
  return null
}

/** The operation a payload names, if it can still be applied. */
function usableOperation(name: string): { op: AgentOperation } | { reason: string } {
  const op = findOperation(name)
  const reason = unusableReason(op, name)
  return reason || !op ? { reason: reason ?? `The operation ${name} no longer exists` } : { op }
}

/**
 * Refuse when it is proposed what could only fail when it is applied (422): an
 * unknown or read-only operation, or an input its schemas reject.
 */
export function requireProposableOperation(payload: OperationPayload): void {
  const found = usableOperation(payload.operation)
  if ('reason' in found) throw new UnprocessableError(found.reason, { reason: 'proposal-operation-unusable' })
  try {
    validateOperationInput(found.op, payload.input)
  } catch (error) {
    if (error instanceof OperationInputError) {
      throw new UnprocessableError(error.message, { reason: 'proposal-operation-input' })
    }
    throw error
  }
}

/** The route's own words for a refusal: its error envelope's `error`, else a note with the status. */
function routeMessage(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const message = (body as { error: unknown }).error
    if (typeof message === 'string' && message.trim()) return message
  }
  return `The operation failed (${status})`
}

const failed = (label: string, reason: string): ProposedChangeResult[] => [{ label, ok: false, reason }]

/** Run the proposal's operation as the deciding person: one result, the route's outcome. */
export async function applyOperation(
  payload: OperationPayload,
  context: { session: AuthorizedSession; proposalId?: string }
): Promise<ProposedChangeResult[]> {
  const label = payload.summary
  const found = usableOperation(payload.operation)
  if ('reason' in found) return failed(label, found.reason)
  try {
    // The route learns it applies this card (`actingProposalId`): a decision it records says so.
    const origin = context.proposalId ? { proposalId: context.proposalId } : {}
    const result = await callOperation(found.op, payload.input, context.session, 'person', origin)
    return result.ok ? [{ label, ok: true }] : failed(label, routeMessage(result.status, result.body))
  } catch (error) {
    if (error instanceof OperationInputError) return failed(label, error.message)
    throw error
  }
}

import 'server-only'
/**
 * The person says yes in their own chat (ADR-0122, amendment "the person
 * confirms in their own chat"): before an outside agent's destructive write
 * runs, the door asks the person through the client, with MCP elicitation on
 * the 2026-07-28 multi-round-trip flow (`inputRequired`), and runs the call only
 * on their yes.
 *
 * Only ever in FRONT of a call that would run today. The question is asked when
 * every one of these holds, and otherwise the call takes today's path, byte for
 * byte:
 *
 *  - the request is of the 2026-07-28 era (the legacy path never builds a
 *    {@link Confirmation}, so Piloti's own client and every 2025-era client are
 *    untouched);
 *  - the caller is an outside agent (`actor: 'external_agent'`); Piloti never
 *    asks, its writes stay proposals;
 *  - the client declared form elicitation in the request's capabilities;
 *  - the operation is one the caller may see, the decision is `run`, and its
 *    annotations mark it a destructive write;
 *  - a signing key exists ({@link requestStateKey}).
 *
 * The yes runs the call through `runOperation`'s whole path again:
 * visibility, the read gate, the route's own `authz`, rate limit and schema. So
 * the answer can never let through a call the door would refuse: it can only
 * stop one. The operation and its input travel to the second round in
 * `requestState`, HMAC-signed, bound to the person, the organization and the
 * client, and valid for {@link CONFIRMATION_TTL_SECONDS}; the second round must
 * repeat the same call. Neither `inputResponses` nor an unsigned state is
 * trusted: the SDK refuses a state that fails verification before a handler runs.
 *
 * One kind of operation is stricter (ADR-0122, amendment "a decision only the
 * person makes"): one marked `requiresPersonConfirmation` runs for an outside
 * agent only on the person's yes. Where the question above can be asked, it is
 * asked, whether or not the operation is otherwise destructive. Where it cannot
 * (a 2025-era request, a client without form elicitation, no signing key), the
 * call is refused and never runs, and the agent is handed the page where the
 * person decides it themselves ({@link personRequiredResult}). Every operation
 * without the mark is answered exactly as described above.
 */

import { createHmac } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CLIENT_CAPABILITIES_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server'
import { configuredAppOrigin } from '@/lib/app-origin'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import { withTenant } from '@/lib/db/tenant-context'
import { usableInternalSecret } from '@/lib/internal-auth'
import { type OperationInput, OperationInputError, validateOperationInput } from './dispatch'
import { type AgentOperation, annotationsOf } from './operation'
import { describeTargets, targetsOf } from './operation-targets'
import { summaryOfOperation } from './operation-proposals'
import { callDecision, findVisibleOperation } from './policy'
import type { AgentPrincipal } from './principal'
import { type McpCallContext, recordOperationCalled } from './telemetry'

/** The key of the one input request: the person's yes or no. */
export const CONFIRM_INPUT = 'confirm'

/** How long the person has to answer; a later answer is refused and the agent calls again. */
export const CONFIRMATION_TTL_SECONDS = 300

/** What the second round carries: the call the person was asked about. */
export interface PendingCall {
  readonly operation: string
  readonly input: OperationInput
}

/** What a modern request's server holds to ask: the codec bound to this principal. */
export interface Confirmation {
  readonly codec: RequestStateCodec<PendingCall>
}

/** The form the client shows: one checkbox. */
const confirmSchema = () => ({
  type: 'object' as const,
  properties: {
    confirm: { type: 'boolean' as const, title: 'Confirm', description: 'Check to let the agent make this change as you.' },
  },
  required: [CONFIRM_INPUT],
})

/** Separates this key from every other use of the internal secret. */
const SIGNING_DOMAIN = 'grid:mcp-request-state:v1'

/**
 * The HMAC key for `requestState`: derived from `GRID_INTERNAL_API_TOKEN`, which
 * every deployment already provisions on every frontend pod, so a second round
 * served by another pod verifies. Null (no confirmation, today's behaviour) when
 * the secret is unset or the dev default outside dev, as for the token itself.
 */
export function requestStateKey(): Uint8Array | null {
  const secret = usableInternalSecret()
  if (!secret) return null
  return new Uint8Array(createHmac('sha256', secret).update(SIGNING_DOMAIN, 'utf8').digest())
}

/** Who the state is for: a state minted for one person, organization or client is refused for another. */
function bindingOf(principal: AgentPrincipal): string {
  return [principal.session.organizationId, principal.session.userId, principal.clientId ?? ''].join('\0')
}

/**
 * The confirmation for one request's server, or null when this principal is
 * never asked: Piloti, or no key. Called only for the 2026-07-28 era.
 */
export function confirmationFor(principal: AgentPrincipal, key: Uint8Array | null = requestStateKey()): Confirmation | null {
  if (principal.actor !== 'external_agent' || !key) return null
  const codec = createRequestStateCodec<PendingCall>({
    key,
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    bind: (ctx) => `${ctx.mcpReq.method}\0${bindingOf(principal)}`,
  })
  return { codec }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the request's client declared form elicitation (2026-07-28: the
 * capabilities ride in every request's `_meta`). An empty `elicitation` object
 * means form, as the specification says.
 */
export function declaresFormElicitation(req: ServerContext): boolean {
  const envelope = req.mcpReq.envelope as Record<string, unknown> | undefined
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY]
  const elicitation = isRecord(capabilities) ? capabilities.elicitation : undefined
  if (!isRecord(elicitation)) return false
  return elicitation.form !== undefined || elicitation.url === undefined
}

/**
 * The operation `call` names if the person must confirm it: visible, run, and
 * a destructive write or one that runs only on the person's yes.
 */
function operationToConfirm(principal: AgentPrincipal, call: PendingCall): AgentOperation | null {
  const op = findVisibleOperation(principal, call.operation)
  if (!op || callDecision(principal, op) !== 'run') return null
  if (op.requiresPersonConfirmation) return op
  const annotations = annotationsOf(op)
  return !annotations.readOnlyHint && annotations.destructiveHint ? op : null
}

/**
 * What the agent reads when an operation runs only on the person's yes and its
 * client cannot ask them: nothing changed, the page where the person decides
 * it, and not to try again unasked. `url` is null when the deployment pins no
 * origin, as for every other link the door hands out (`links.ts`).
 */
export function personRequiredResult(op: string, url: string | null): CallToolResult {
  const where = url
    ? ` Give the person this link, where they decide it in Piloti themselves: ${url}`
    : ' The person decides it in Piloti themselves.'
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          `${op} runs only on the person's own yes, and this client cannot ask them for it (MCP form elicitation), ` +
          `so nothing was changed.${where} Do not call it again unless they ask you to.`,
      },
    ],
    structuredContent: { decision: 'person_required', operation: op, changed: false, url },
  }
}

/**
 * The refusal for a call that runs only on the person's yes when this request
 * cannot carry the question; null for every other call, which then takes its
 * path unchanged. Only an outside agent's call is refused here: Piloti's write
 * is a proposal the person accepts, and a name the caller cannot see stays
 * unknown. A malformed call is left to today's path, whose validator refuses it
 * with the reason, so the agent fixes its input before it is sent to the person.
 */
function refusalWithoutThePerson(ctx: McpCallContext, call: PendingCall): CallToolResult | null {
  if (ctx.principal.actor !== 'external_agent') return null
  const op = findVisibleOperation(ctx.principal, call.operation)
  const confirmation = op?.requiresPersonConfirmation
  if (!op || !confirmation || callDecision(ctx.principal, op) !== 'run') return null
  let input: OperationInput
  try {
    input = validateOperationInput(op, call.input)
  } catch (error) {
    if (error instanceof OperationInputError) return null
    throw error
  }
  const origin = configuredAppOrigin()
  recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'person_required', status: 403, startedAt: Date.now() })
  return personRequiredResult(op.name, origin ? `${origin}${confirmation.decideAt(input)}` : null)
}

/** The project and document the call names, by the names the person reads; none when they cannot be read cheaply. */
async function namedTargets(principal: AgentPrincipal, op: AgentOperation, input: OperationInput): Promise<string[]> {
  const { session } = principal
  try {
    const views = await withTenant({ organizationId: session.organizationId, userId: session.userId }, () =>
      describeTargets(session, op, input),
    )
    return views.flatMap((view) => (view.name ? [`${view.type.replace('_', ' ')} "${view.name}"`] : []))
  } catch {
    return []
  }
}

/** What the person reads: what will change, on what, and that nothing does without them. */
export async function confirmationMessage(principal: AgentPrincipal, op: AgentOperation, input: OperationInput): Promise<string> {
  const what = summaryOfOperation(op, input).replace(/\.$/, '')
  const targets = await namedTargets(principal, op, input)
  const on = targets.length > 0 ? ` This affects ${targets.join(', ')}.` : ''
  return `An agent connected to Piloti wants to make this change as you: ${what}.${on} Nothing changes unless you confirm.`
}

/** What the agent reads when the person said no: nothing changed, and not to try again unasked. */
export function declinedResult(op: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `The person did not confirm ${op}, so nothing was changed. Do not call it again unless they ask you to.`,
      },
    ],
    structuredContent: { decision: 'declined', operation: op, changed: false },
  }
}

const MISMATCH =
  'The confirmation the person gave was for a different call, so nothing was changed. Call the operation again to ask them.'

/** The audit line for the person's answer: who decided (the person), through what, and how it ended. */
function auditDecision(
  principal: AgentPrincipal,
  op: AgentOperation,
  input: OperationInput,
  decision: 'applied' | 'failed' | 'declined',
): void {
  let targets: { type: string; id: string }[] = []
  try {
    targets = targetsOf(op, input).filter((target) => target.type === 'project' || target.type === 'document')
  } catch {
    // Too many to name: the line still records the decision.
  }
  recordAuditEventAfterCommit({
    action: 'agent.operation.decided',
    organizationId: principal.session.organizationId,
    actor: { userId: principal.session.userId, email: principal.session.email || null },
    targetType: 'organization',
    targetId: principal.session.organizationId,
    alsoTargets: targets,
    metadata: { operation: op.name, decision, decisionSource: 'elicitation', clientId: principal.clientId ?? '' },
  })
}

/**
 * Run `call` for `ctx`, asking the person first when {@link operationToConfirm}
 * says so and the request can carry the question, and refusing it when it runs
 * only on their yes and the request cannot ({@link refusalWithoutThePerson});
 * `run` is today's path for the same call, which every other case ends in. `call` is null
 * when the arguments name no catalog operation (a read tool, an unparseable
 * call): then it is `run`, unchanged.
 */
export async function confirmThenRun(
  ctx: McpCallContext,
  req: ServerContext,
  call: PendingCall | null,
  run: (ctx: McpCallContext) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  const confirmation = ctx.confirmation
  if (call && !(confirmation && declaresFormElicitation(req))) {
    const refused = refusalWithoutThePerson(ctx, call)
    if (refused) return refused
  }
  if (!confirmation) return run(ctx)
  // Verified and bound by the SDK before this handler runs (`requestState.verify`); absent when the round carried none.
  const pending = req.mcpReq.requestState<PendingCall>()
  if (isRecord(pending)) return answered(ctx, req, confirmation, call, pending as PendingCall, run)
  if (!call || !declaresFormElicitation(req)) return run(ctx)
  const op = operationToConfirm(ctx.principal, call)
  if (!op) return run(ctx)
  try {
    validateOperationInput(op, call.input)
  } catch (error) {
    // A call the route would refuse is refused as today, never put to the person.
    if (error instanceof OperationInputError) return run(ctx)
    throw error
  }
  return ask(ctx, req, confirmation, op, call)
}

async function ask(
  ctx: McpCallContext,
  req: ServerContext,
  confirmation: Confirmation,
  op: AgentOperation,
  call: PendingCall,
): Promise<InputRequiredResult> {
  const startedAt = Date.now()
  const requestState = await confirmation.codec.mint({ operation: op.name, input: call.input }, req)
  const message = await confirmationMessage(ctx.principal, op, call.input)
  recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'confirm', status: 202, startedAt })
  return inputRequired({
    inputRequests: { [CONFIRM_INPUT]: inputRequired.elicit({ message, requestedSchema: confirmSchema() }) },
    requestState,
  })
}

/** The second round: the person answered (or the client re-sent without an answer, and is asked again). */
async function answered(
  ctx: McpCallContext,
  req: ServerContext,
  confirmation: Confirmation,
  call: PendingCall | null,
  pending: PendingCall,
  run: (ctx: McpCallContext) => Promise<CallToolResult>,
): Promise<CallToolResult | InputRequiredResult> {
  if (!call || call.operation !== pending.operation || !isDeepStrictEqual(call.input ?? {}, pending.input ?? {})) {
    return { isError: true, content: [{ type: 'text', text: MISMATCH }] }
  }
  const op = operationToConfirm(ctx.principal, call)
  // No longer one to confirm (it left the door, or stopped being destructive): today's path decides.
  if (!op) return run(ctx)
  const answer = inputResponse(req.mcpReq.inputResponses, CONFIRM_INPUT)
  if (answer.kind !== 'elicit') return ask(ctx, req, confirmation, op, call)
  if (answer.action !== 'accept' || answer.content?.confirm !== true) {
    recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'declined', status: 200, startedAt: Date.now() })
    auditDecision(ctx.principal, op, call.input, 'declined')
    return declinedResult(op.name)
  }
  const result = await run({ ...ctx, decisionSource: 'elicitation' })
  auditDecision(ctx.principal, op, call.input, result.isError ? 'failed' : 'applied')
  return result
}

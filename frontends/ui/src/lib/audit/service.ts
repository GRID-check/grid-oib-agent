/**
 * Admin audit trail — WORKOS-NATIVE (Audit Logs product), no local table.
 *
 * Every privileged mutation in the BFF emits a WorkOS Audit Log event
 * (`workos.auditLogs.createEvent`) into the organization it affected.
 * Viewing, retention, export (CSV via the export API) and SIEM streaming are
 * all WorkOS-native: org admins open the Admin Portal audit-logs viewer
 * (`adminPortal.generateLink({ intent: 'audit_logs' })`), and the existing
 * `widgets:audit-log-streaming:manage` widget configures streams.
 *
 * Event ACTIONS must exist as Audit Log schemas in the WorkOS environment, or
 * WorkOS rejects the event. Action AND schema live together in `./schemas.mjs`
 * (one list, so they cannot drift), and the deploy reconciles them into the
 * environment — `npm run provision:audit-schemas` does it by hand
 * (docs/deployment/workos-provisioning.md). The default emitter is deliberately
 * non-throwing regardless, because an audit hiccup must never take the
 * privileged mutation down with it — the domain tables (budget_policies
 * supersede chain, org_model_config_versions) remain the system of record for
 * WHAT changed.
 *
 * That trade inverts on exactly one class of event, so there are two emitters:
 * `recordAuditEvent` (never throws, the default every existing call site keeps)
 * and `recordAuditEventOrThrow` (opt-in, see its own note).
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import type { AuthoredRefKind } from '@/lib/documents/document-authors'
import { AUDIT_ACTIONS } from './schemas.mjs'

export { AUDIT_ACTIONS }
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** Flat primitives only — the WorkOS metadata contract. */
export type AuditMetadata = Record<string, string | number | boolean>

/**
 * Which hand wrote the thing — NOT which slot of the WorkOS event it lands in.
 *
 * `'agent'` does NOT become `actor.type: 'agent'` on the wire, and that is the
 * decision, not an oversight. The rejected option was the literal one: the SDK
 * types `AuditLogActor.type` as a free `string` and the validator WorkOS
 * generates constrains the actor only to `required: [id, type, metadata]`, so
 * `type: 'agent'` would be accepted. It is still the wrong slot for two
 * reasons. The actor is the AUTHORIZATION principal, and the question this
 * whole feature exists to answer — "who authorized the creation of this
 * AI-generated document" — has to resolve to a human; an agent sitting there
 * deletes the only fact being asked for. And it deletes it from the one field
 * the trail can be searched by: the audit-log export filters on `actorIds` /
 * `actorNames` (`AuditLogExportOptions`), so an event actored by `run_x` is
 * unfindable by the person who commissioned it.
 *
 * So the actor stays the commissioning human on every path, and `'agent'`
 * instead adds what produced the thing as a SECOND TARGET, `{type: <the
 * reference's kind>, id: <the reference>}`. Two structured facts — which human
 * authorized, which run produced — each queryable on its own, neither shadowing
 * the other. That is ADR-0047's provenance-is-not-responsibility line drawn
 * through the audit trail rather than only through the `documents` row.
 *
 * The target's TYPE is the reference's kind and not a constant, which it was
 * until migration 0066. Every agent-authored event used to be emitted with
 * `{type: 'agent_run'}` regardless of what the id actually named, so a filed
 * diagram asserted — in a structured field the audit-log export filters on —
 * that `msg_42-1a2b3c4d` was a backend job id. An auditor resolving it looked up
 * a run that does not exist and got nothing: a dead end in the one record that
 * answers "what wrote this, in which run, on whose authority", and a silent one,
 * because a target that resolves to nothing looks exactly like a target nobody
 * has looked up yet.
 *
 * The cost of the choice, stated so it is not discovered: an action emitted
 * with `type: 'agent'` MUST register EVERY member of `AUTHORED_REF_KINDS` among
 * its targets in `schemas.mjs`, or WorkOS rejects the whole event the way it
 * rejects an unregistered action (issues #255/#256). `schemas.spec.ts` fails
 * when a kind is added here and not registered there.
 */
export type AuditActorType = 'user' | 'agent'

/**
 * What an agent-authored event points BACK at: the identifier, and what kind of
 * identifier it is.
 *
 * The kind travels with the id rather than being assumed, for the same reason
 * `documents.authored_by_ref_kind` exists (migration 0066): the two producers
 * that exist file under two different kinds of identity, and a record that names
 * one without saying which cannot be resolved by the person it was written for.
 * Here the kind does double duty — it is also the WorkOS target type, so the
 * event says what it points at in the field an auditor filters on.
 */
export interface AuditAgentRef {
  kind: AuthoredRefKind
  id: string
}

/**
 * `ref` is required on the agent branch rather than optional: an agent-authored
 * event that cannot name what produced it answers half the enterprise question,
 * and half an answer is not an audit record. Making it a discriminated union
 * means the missing half is a compile error at the call site instead of a
 * malformed event discovered in a viewer months later.
 */
export type AuditActor =
  | { type?: 'user'; userId: string; email?: string | null }
  | { type: 'agent'; userId: string; email?: string | null; ref: AuditAgentRef }

/** The WorkOS event target shape — `{type, id}` is all this app ever sends. */
interface AuditTarget {
  type: string
  id: string
}

export interface AuditEventInput {
  /** WorkOS org the action AFFECTED (audit events are org-scoped). */
  organizationId: string
  actor: AuditActor
  action: AuditAction
  targetType: string
  targetId?: string | null
  metadata?: Record<string, string | number | boolean | null | undefined>
  /** Source request, for actor IP + user agent in the event context. */
  request?: Request
}

function requestContext(request?: Request): { location: string; userAgent?: string } {
  // First hop of x-forwarded-for is the client (the BFF sits behind a proxy).
  const forwarded = request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const userAgent = request?.headers.get('user-agent') ?? undefined
  return { location: forwarded || 'unknown', userAgent }
}

/**
 * Nulls out, and ALWAYS an object — never `undefined`.
 *
 * WorkOS generates the validator from what `createSchema` registers, and
 * registering a `metadata` property map makes metadata REQUIRED in the
 * generated schema (`required: [action, actor, context, occurred_at, targets,
 * metadata]`) — an event that omits it is rejected outright. The map itself
 * stays permissive (no `required` inside it, no `additionalProperties: false`),
 * so `{}` validates for every action, including the ones that register no
 * metadata at all. Sending the empty object costs nothing and removes a whole
 * rejection class; see the actor note in `emit`.
 */
function compactMetadata(metadata: AuditEventInput['metadata']): AuditMetadata {
  const entries = Object.entries(metadata ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] != null,
  )
  return Object.fromEntries(entries)
}

/**
 * The subject of the event, plus what produced it when a machine wrote it.
 *
 * Both are targets rather than one being metadata, because the reference has to
 * survive as an identity: a `runId` metadata KEY would have to be registered
 * per action (`schemas.mjs` rejects events whose metadata keys do not match
 * what the schema declares), so every future agent-authored action would owe a
 * duplicate registration — and the emitter cannot inject the key blindly
 * without breaking the actions that do not declare it.
 *
 * The second target's type is the reference's own kind. That is what makes it
 * resolvable: `agent_run` sends an auditor to the job store, `answer_artifact`
 * to the chat answer the artifact was drawn in. One constant for both would send
 * them to the job store for a value that was never in it.
 */
function eventTargets(input: AuditEventInput): AuditTarget[] {
  const subject: AuditTarget = { type: input.targetType, id: input.targetId ?? input.organizationId }
  if (input.actor.type !== 'agent') return [subject]
  return [subject, { type: input.actor.ref.kind, id: input.actor.ref.id }]
}

/** A WorkOS emit that failed, with the event it was carrying. */
export class AuditEmitError extends Error {
  readonly action: AuditAction
  readonly organizationId: string

  constructor(input: AuditEventInput, cause: unknown) {
    super(`failed to emit audit event ${input.action} for org ${input.organizationId}`, { cause })
    this.name = 'AuditEmitError'
    this.action = input.action
    this.organizationId = input.organizationId
  }
}

/** The single WorkOS call both emitters share. Throws whatever WorkOS throws. */
async function emit(input: AuditEventInput): Promise<void> {
  const workos = getWorkOS()
  await workos.auditLogs.createEvent(input.organizationId, {
    action: input.action,
    occurredAt: new Date(),
    actor: {
      // Always the human, agent-authored events included — see AuditActorType.
      type: 'user',
      id: input.actor.userId,
      name: input.actor.email ?? undefined,
      // Required, and empty on purpose. The validator WorkOS generates for an
      // action that registers a metadata map also marks `actor.metadata`
      // required — `actor: {required: [id, type, metadata]}` with an EMPTY
      // property map — even though the app never registers an actor schema
      // and `createSchema` is never passed one. Omitting it is what issues
      // #274/#277 were: every emit rejected with "Invalid Audit Log event:
      // incorrect or missing metadata keys", pointing at `/actor`, on the one
      // path that deliberately swallows its errors — so the trail lost
      // `resource.shared` and `platform.model_defaults.updated` events while
      // the mutations themselves succeeded. The property map is empty and
      // unconstrained, so `{}` satisfies it; the actor's identity is already
      // carried by `id` and `name`.
      metadata: {},
    },
    targets: eventTargets(input),
    context: requestContext(input.request),
    metadata: compactMetadata(input.metadata),
  })
}

/** Emit one WorkOS Audit Log event. Never throws. */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await emit(input)
  } catch (error) {
    console.error(`[Audit] failed to emit ${input.action} for org ${input.organizationId}:`, error)
  }
}

/**
 * The same emit, for the events whose ABSENCE is the failure.
 *
 * Swallowing is right for a privileged mutation the domain tables already
 * record: the trail loses a line, the system of record does not. It is wrong
 * for an event that IS the record — "this document was written by a machine on
 * this human's authority" has no domain table to fall back on, and a missing
 * record is indistinguishable from the thing never having happened. That is
 * the shape issues #274/#277 had: every emit rejected, nothing thrown, and the
 * trail silently short a whole class of event while the mutations succeeded.
 *
 * A separate exported function rather than a `required: true` flag on the
 * input, so opting in is a name a reviewer can grep for and never something a
 * spread-in options object turns on by accident. Callers are expected to fail
 * the operation — an agent-authored document that could not be audited should
 * not be kept.
 */
export async function recordAuditEventOrThrow(input: AuditEventInput): Promise<void> {
  try {
    await emit(input)
  } catch (error) {
    throw new AuditEmitError(input, error)
  }
}

/**
 * The app's trusted origin for portal return URLs. `request.url` derives
 * from the inbound Host header, which a misconfigured proxy may forward
 * unvalidated — and WorkOS does not allowlist Admin Portal returnUrls, so a
 * spoofed Host would become an open redirect out of the portal. The AuthKit
 * redirect URI env var already pins the real origin per deployment.
 */
export function trustedAppOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(request.url).origin
}

/**
 * Native audit-log viewer: a short-lived WorkOS Admin Portal link scoped to
 * the organization. Throws on WorkOS errors — callers surface a 502.
 */
export async function generateAuditPortalLink(organizationId: string, returnUrl?: string): Promise<string> {
  const workos = getWorkOS()
  const { link } = await workos.adminPortal.generateLink({
    intent: 'audit_logs',
    organization: organizationId,
    returnUrl,
  })
  return link
}

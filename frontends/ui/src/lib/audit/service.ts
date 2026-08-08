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
 * (docs/deployment/workos-provisioning.md). The emitter is deliberately
 * non-throwing regardless, because an audit hiccup must never take the
 * privileged mutation down with it — the domain tables (budget_policies
 * supersede chain, org_model_config_versions) remain the system of record for
 * WHAT changed.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { AUDIT_ACTIONS } from './schemas.mjs'

export { AUDIT_ACTIONS }
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

/** Flat primitives only — the WorkOS metadata contract. */
export type AuditMetadata = Record<string, string | number | boolean>

export interface AuditEventInput {
  /** WorkOS org the action AFFECTED (audit events are org-scoped). */
  organizationId: string
  actor: { userId: string; email?: string | null }
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
 * rejection class; see the actor note in `recordAuditEvent`.
 */
function compactMetadata(metadata: AuditEventInput['metadata']): AuditMetadata {
  const entries = Object.entries(metadata ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] != null,
  )
  return Object.fromEntries(entries)
}

/** Emit one WorkOS Audit Log event. Never throws. */
export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    const workos = getWorkOS()
    await workos.auditLogs.createEvent(input.organizationId, {
      action: input.action,
      occurredAt: new Date(),
      actor: {
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
      targets: [
        {
          type: input.targetType,
          id: input.targetId ?? input.organizationId,
        },
      ],
      context: requestContext(input.request),
      metadata: compactMetadata(input.metadata),
    })
  } catch (error) {
    console.error(`[Audit] failed to emit ${input.action} for org ${input.organizationId}:`, error)
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

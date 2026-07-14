/**
 * File-access authorization — shared by the web app and the file-gateway
 * (mounted-drive) service, so a document is authorized identically no matter how
 * it is reached.
 *
 * A document inherits access from its parent project (ADR-0004): the caller
 * supplies the project the file belongs to, and this resolves the same per-project
 * WorkOS FGA decision `requireProjectAccess` uses. The provisioned `document` FGA
 * resource type reserves per-file grants for a later step without changing this.
 *
 * FGA decisions are memoized in the shared cache (Dragonfly, ADR-0020 explicitly
 * anticipates "FGA check memoization (short TTL)"). Membership/role changes
 * invalidate via {@link invalidateProjectAccess}. This is also the fix for the
 * previously-uncached WorkOS round-trip(s) on every project-scoped request.
 */

import 'server-only'
import { getWorkOS } from '@/lib/workos/client'
import { getCached, invalidateCachedPrefix } from '@/lib/cache'
import { findProjectTenancy } from '@/lib/projects/repository'
import { resolveOrganizationMembershipId } from '@/lib/auth/session'
import { isDeletionUnderHold } from '@/lib/compliance/repository'
import { findDocumentIdByObjectKey } from '@/lib/documents/repository'
import type { ProjectPermission } from '@/lib/authz/projects'

/** FGA decisions are short-lived; role changes also invalidate explicitly. */
const FGA_DECISION_TTL_MS = 30_000

function decisionKey(membershipId: string, projectId: string, permission: ProjectPermission): string {
  return `fga:${membershipId}:project:${projectId}:${permission}`
}

/**
 * Cached WorkOS FGA check: does this org-membership hold `permission` on the
 * project? Both allow and deny are cached for a short TTL.
 */
export async function checkProjectPermission(
  membershipId: string,
  projectId: string,
  permission: ProjectPermission,
): Promise<boolean> {
  return getCached(decisionKey(membershipId, projectId, permission), FGA_DECISION_TTL_MS, async () => {
    const result = await getWorkOS().authorization.check({
      organizationMembershipId: membershipId,
      permissionSlug: permission,
      resourceExternalId: projectId,
      resourceTypeSlug: 'project',
    })
    return result.authorized
  })
}

/**
 * Drop every cached FGA decision for a membership on a project. Call after a role
 * assignment/removal so revocation isn't bounded only by the TTL.
 */
export async function invalidateProjectAccess(membershipId: string, projectId: string): Promise<void> {
  await invalidateCachedPrefix(`fga:${membershipId}:project:${projectId}:`)
}

export interface FileAccessRequest {
  userId: string
  organizationId: string
  projectId: string
  permission: ProjectPermission
}

/**
 * Resolve a file-access decision from a resolved user+org (no session cookie) —
 * the shape the file-gateway calls with. Enforces org tenancy first (a project
 * outside the caller's org is a hard deny), then the cached per-project FGA check.
 */
export async function checkFileAccess(req: FileAccessRequest): Promise<{ allow: boolean }> {
  const project = await findProjectTenancy(req.projectId)
  if (!project || project.organizationId !== req.organizationId || project.deletedAt) {
    return { allow: false }
  }
  const membershipId = await resolveOrganizationMembershipId(req.userId, req.organizationId)
  if (!membershipId) {
    return { allow: false }
  }
  const allow = await checkProjectPermission(membershipId, req.projectId, req.permission)
  return { allow }
}

export interface FileDeletableRequest {
  organizationId: string
  projectId: string
  /** Canonical S3 object key the delete targets (used to resolve a document-level hold). */
  objectKey: string
}

/**
 * Is a drive `rm` of this object permitted by compliance? This answers the
 * legal-hold question ONLY — the caller's Guard separately enforces
 * `project:edit` (ADR-0024 §3). The file-gateway calls this synchronously before
 * destroying bytes: bytes must never be deleted while under a legal hold.
 *
 * Fails CLOSED on any uncertainty (unknown/cross-tenant project → not deletable),
 * because the safe direction for a destructive op is to refuse. Not cached: a
 * hold is a rare, high-stakes signal that must be read fresh at delete time
 * (a stale "deletable" could destroy held evidence).
 */
export async function checkFileDeletable(req: FileDeletableRequest): Promise<{ deletable: boolean }> {
  const project = await findProjectTenancy(req.projectId)
  if (!project || project.organizationId !== req.organizationId || project.deletedAt) {
    return { deletable: false }
  }
  const documentId = await findDocumentIdByObjectKey(req.projectId, req.objectKey)
  const held = await isDeletionUnderHold({
    organizationId: req.organizationId,
    projectId: req.projectId,
    documentId,
  })
  return { deletable: !held }
}

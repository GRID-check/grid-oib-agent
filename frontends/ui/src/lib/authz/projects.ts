import { getWorkOS } from "@/lib/workos/client";
import { timedWorkOSCall } from "@/lib/workos/instrumentation";
import { getCached } from "@/lib/cache";
import type { AuthorizedSession } from "@/lib/auth/types";
import { NotFoundError } from "@/lib/api/errors";
import { findProjectTenancy } from "@/lib/projects/repository";

export type ProjectPermission =
  | "project:view"
  | "project:edit"
  | "project:manage"
  | "project:chat";

export type ProjectRole = "project-viewer" | "project-editor" | "project-admin";

/**
 * Optional short-TTL cache of per-project FGA `authorization.check` results.
 *
 * These checks are the WorkOS round-trips UNIQUE to the project-authz flows
 * (save/summary/consistency-check): a normal chat-message persistence POST does
 * no FGA call at all. Each failing request makes up to two of them, each a
 * network round-trip bounded only by the SDK timeout — the leg most likely to
 * turn an inter-container network blip into a multi-second stall.
 *
 * `GRID_AUTHZ_CACHE_TTL_MS` (default `0` = OFF) caches the boolean result of a
 * check for (organizationMembershipId, projectId, permissionSlug). Precedent:
 * feature flags — themselves capability gates — are already cached 30s
 * (`@/lib/workos/feature-flags`), and org-membership resolution is cached 10min
 * (`@/lib/auth/session`).
 *
 * Security tradeoff (revocation delay ≤ TTL), accepted only when explicitly
 * enabled:
 *   - A grant or revocation of a project role propagates up to TTL later. Keep
 *     the TTL short (30-60s) so the window matches the existing flag cache.
 *   - The org tenancy check (`findProjectTenancy`) is NEVER cached — it runs on
 *     every request — so a project can never be served across-org from cache;
 *     only the per-project FGA grant within the caller's own org is cached.
 *   - Org admins bypass FGA before this cache is consulted, so an admin
 *     grant/revoke is unaffected.
 * Disabled by default; turn on only where a ≤TTL revocation lag is acceptable.
 */
function authzCacheTtlMs(): number {
  const raw = process.env.GRID_AUTHZ_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Authorize a session against a project and derive its effective role.
 *
 * Denials throw {@link NotFoundError} (message "Not found") so responses
 * never confirm the existence of projects the caller may not see.
 */
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission = "project:view",
  options: { includeDeleted?: boolean } = {},
): Promise<{ role: ProjectRole }> {
  // Verify the project belongs to the current org (and is not soft-deleted,
  // unless the caller explicitly needs deleted projects, e.g. restore).
  // This tenancy check runs for EVERYONE — the org-admin bypass below only
  // skips the per-project FGA checks. Bypassing it for admins let an org-A
  // admin act on an org-B project by id (routes query by id downstream).
  const project = await findProjectTenancy(projectId);

  if (
    !project ||
    project.organizationId !== session.organizationId ||
    (project.deletedAt && !options.includeDeleted)
  ) {
    throw new NotFoundError();
  }

  // Org admins bypass per-project FGA checks (but never the tenancy check).
  if (session.role === "admin") {
    return { role: "project-admin" };
  }

  const workos = getWorkOS();
  const ttlMs = authzCacheTtlMs();
  const check = (permissionSlug: ProjectPermission) => {
    // Time every FGA round-trip so a stalled check names itself in the logs
    // (the fast path stays silent — see timedWorkOSCall).
    const run = () =>
      timedWorkOSCall(`authorization.check ${permissionSlug}`, () =>
        workos.authorization
          .check({
            organizationMembershipId: session.organizationMembershipId,
            permissionSlug,
            resourceExternalId: projectId,
            resourceTypeSlug: "project",
          })
          .then((result) => result.authorized),
      );
    if (ttlMs <= 0) return run();
    // Cache keyed on the membership (a (user, org) identity) + project +
    // permission. The store is fail-open: a cache outage degrades to run().
    return getCached(
      `authz:check:${session.organizationMembershipId}:${projectId}:${permissionSlug}`,
      ttlMs,
      run,
    );
  };

  // One round-trip instead of three sequential checks: the requested
  // permission gates access; manage/edit only refine the derived role.
  const [authorized, isAdmin, isEditor] = await Promise.all([
    check(permission),
    permission === "project:manage" ? Promise.resolve(null) : check("project:manage"),
    permission === "project:edit" ? Promise.resolve(null) : check("project:edit"),
  ]);

  if (!authorized) {
    throw new NotFoundError();
  }

  if (isAdmin ?? permission === "project:manage") return { role: "project-admin" };
  if (isEditor ?? permission === "project:edit") return { role: "project-editor" };
  return { role: "project-viewer" };
}

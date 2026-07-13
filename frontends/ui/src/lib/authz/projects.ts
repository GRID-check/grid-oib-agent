import { getWorkOS } from "@/lib/workos/client";
import type { AuthorizedSession } from "@/lib/auth/types";
import { NotFoundError } from "@/lib/api/errors";
import { findProjectTenancy } from "@/lib/projects/repository";

/**
 * The single source of truth for project permission slugs. The Zod enum on the
 * internal route and any other validation derive from this — do not re-list them.
 */
export const PROJECT_PERMISSIONS = [
  "project:view",
  "project:edit",
  "project:manage",
  "project:chat",
] as const;

export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

export type ProjectRole = "project-viewer" | "project-editor" | "project-admin";

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
  const check = (permissionSlug: ProjectPermission) =>
    workos.authorization
      .check({
        organizationMembershipId: session.organizationMembershipId,
        permissionSlug,
        resourceExternalId: projectId,
        resourceTypeSlug: "project",
      })
      .then((result) => result.authorized);

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

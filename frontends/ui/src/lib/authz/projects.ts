import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { getWorkOS } from "@/lib/workos/client";
import type { AuthorizedSession } from "@/lib/auth/types";
import { projects } from "@/lib/db/schema";

export type ProjectPermission =
  | "project:view"
  | "project:edit"
  | "project:manage"
  | "project:chat";

export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission = "project:view",
  options: { includeDeleted?: boolean } = {},
): Promise<{ role: "project-viewer" | "project-editor" | "project-admin" }> {
  // Verify the project belongs to the current org (and is not soft-deleted,
  // unless the caller explicitly needs deleted projects, e.g. restore).
  // This tenancy check runs for EVERYONE — the org-admin bypass below only
  // skips the per-project FGA checks. Bypassing it for admins let an org-A
  // admin act on an org-B project by id (routes query by id downstream).
  const db = getDb();
  const [project] = await db
    .select({
      organizationId: projects.organizationId,
      deletedAt: projects.deletedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (
    !project ||
    project.organizationId !== session.organizationId ||
    (project.deletedAt && !options.includeDeleted)
  ) {
    throw new Error("Not found");
  }

  // Org admins bypass per-project FGA checks (but never the tenancy check).
  if (session.role === "admin") {
    return { role: "project-admin" };
  }

  const workos = getWorkOS();

  const { authorized } = await workos.authorization.check({
    organizationMembershipId: session.organizationMembershipId,
    permissionSlug: permission,
    resourceExternalId: projectId,
    resourceTypeSlug: "project",
  });

  if (!authorized) {
    throw new Error("Not found");
  }

  const { authorized: isAdmin } = await workos.authorization.check({
    organizationMembershipId: session.organizationMembershipId,
    permissionSlug: "project:manage",
    resourceExternalId: projectId,
    resourceTypeSlug: "project",
  });
  if (isAdmin) return { role: "project-admin" };

  const { authorized: isEditor } = await workos.authorization.check({
    organizationMembershipId: session.organizationMembershipId,
    permissionSlug: "project:edit",
    resourceExternalId: projectId,
    resourceTypeSlug: "project",
  });
  if (isEditor) return { role: "project-editor" };

  return { role: "project-viewer" };
}

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
): Promise<{ role: "project-viewer" | "project-editor" | "project-admin" }> {
  // Org admins bypass per-project checks.
  if (session.role === "admin") {
    return { role: "project-admin" };
  }

  // Verify the project belongs to the current org.
  const db = getDb();
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project || project.organizationId !== session.organizationId) {
    throw new Error("Not found");
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

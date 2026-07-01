# Project Access Control (WorkOS FGA)

Project-level authorization uses WorkOS Fine-Grained Authorization (FGA). Each project is registered as a WorkOS FGA resource, and access is checked on every request.

## Resource creation

When a project is created (via server action or API route), the flow is:

1. A `projects` row is inserted into PostgreSQL with a generated `collectionName` (`proj_{uuid}`).
2. A WorkOS FGA resource is created via `workos.authorization.createResource()` with `resourceTypeSlug: 'project'` and `externalId` set to the project's UUID.
3. The returned WorkOS resource ID is stored back in the `workosResourceId` column.
4. The creator is assigned the `project-admin` role via `workos.authorization.assignRole()`.

Source: `frontends/ui/src/app/projects/actions.ts:30`, `frontends/ui/src/app/api/projects/route.ts:52`

## Permission check (`requireProjectAccess`)

`frontends/ui/src/lib/authz/projects.ts`

```typescript
export async function requireProjectAccess(
  session: AuthorizedSession,
  projectId: string,
  permission: ProjectPermission = "project:view",
): Promise<{ role: "project-viewer" | "project-editor" | "project-admin" }>
```

### Check flow

1. **Org admin bypass**: If the session's `role` is `"admin"`, the check passes immediately and returns `"project-admin"`.
2. **Org validation**: The project's `organizationId` is fetched from PostgreSQL. If the project doesn't exist or the org doesn't match the session's org, the function throws `"Not found"`.
3. **FGA check**: Calls `workos.authorization.check()` with:
   - `organizationMembershipId` from the session
   - `permissionSlug` (the requested permission)
   - `resourceExternalId` (project UUID)
   - `resourceTypeSlug`: `"project"`
4. **Role resolution**: After the permission check passes, two additional FGA checks determine the effective role:
   - `project:manage` → `"project-admin"`
   - `project:edit` → `"project-editor"`
   - Otherwise → `"project-viewer"`

If the FGA check fails, the function throws `"Not found"` (not `"Forbidden"`) to avoid leaking information about project existence.

## Permission slugs

| Slug | Required for |
|------|-------------|
| `project:view` | Viewing project page, listing documents, project-scoped chat |
| `project:edit` | Uploading documents to a project |
| `project:manage` | Editing project name, managing members, deleting project |
| `project:chat` | Chatting within a project context (checked alongside `project:view`) |

## Where permissions are enforced

| Action | Route / Action | Permission |
|--------|---------------|------------|
| List projects | `GET /api/projects`, `page.tsx` | Org-scoped (no FGA — project rows filtered by org) |
| View project | `GET /api/projects/[id]` | `project:view` |
| Edit project name | `PATCH /api/projects/[id]` | `project:manage` |
| Delete project | `DELETE /api/projects/[id]` | `project:manage` |
| List documents | `GET /api/documents?projectId=` | `project:view` (implicitly via project page) |
| Upload document | `POST /api/documents/upload` | `project:edit` |
| List members | `GET /api/projects/[id]/members` | `project:manage` |
| Add member | `POST /api/projects/[id]/members` | `project:manage` |
| Remove member | `DELETE /api/projects/[id]/members/[id]` | `project:manage` |
| V1 collection access | `validateCollectionName()` in `[...path]/route.ts` | `project:edit` (for `proj_*` collections) |
| WebSocket scope | `GET /api/auth/websocket-scope` | `project:view` |

## Owner assignment

The project creator is automatically assigned `project-admin` via `workos.authorization.assignRole()` in the same transaction that inserts the project. No additional setup is needed.

Source: `frontends/ui/src/app/projects/actions.ts:57`

## Project-org validation

Every project belongs to exactly one organization (the `organizationId` FK on the `projects` table). Access checks verify:

1. The project exists (DB lookup).
2. The project's `organizationId` matches `session.organizationId`.
3. If mismatch, throws `"Not found"` — the same error as a nonexistent project.

This prevents cross-org access even if an FGA check would pass (e.g., due to configuration error).

Source: `frontends/ui/src/lib/authz/projects.ts:24`

## Anonymous mode

When `REQUIRE_AUTH=false`, the `resolveSession()` helper returns `null` and all project access checks are skipped. The `validateCollectionName()` function in the v1 proxy route blocks uploads to `proj_*` collections with a `403` when there is no session, but read operations may pass through depending on backend configuration.

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:84`

## Member management

- **List**: Fetches all org users, then queries FGA for memberships matching each project permission slug. Returns a merged list with user details (name, email, role).
- **Add**: Calls `workos.authorization.assignRole()` with `organizationMembershipId`, `resourceExternalId`, and `roleSlug`.
- **Remove**: Finds the role assignment by querying `listRoleAssignmentsForResource()`, then calls `workos.authorization.removeRoleAssignment()`.

Source: `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`

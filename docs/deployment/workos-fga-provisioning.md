# WorkOS FGA provisioning (resource types)

GRID's fine-grained authorization uses WorkOS FGA **roles + resource hierarchy**
(the same model the BFF already uses via `workos.authorization.check`). Resource
types are environment-scoped and are provisioned via the WorkOS management API /
dashboard (not via the runtime Node SDK), so they are recorded here and applied per
environment — Staging first, Production before go-live (mirrors
[`workos-provisioning.md`](workos-provisioning.md)).

## Resource-type hierarchy

```
Organization (system)
  └── Project        roles: project-viewer | project-editor | project-admin
                     permissions: project:view | project:edit | project:manage | project:chat
        └── Document  inherits access from its parent Project
                      (reserved: per-file grants / review roles — ADR-0023)
```

## Current state

| Environment | organization | project | document |
|---|---|---|---|
| **Staging** (`environment_01KEF0YG238CSMNF731TEG010E`) | ✅ existing | ✅ existing | ✅ **provisioned 2026-07-13** (`authz_resource_type_01KXEMYF6KDS2P0RQSRY0AYP7B`, parent = `project`) |
| **Production** (`environment_01KEF0YGNYDFAFAS77EZEFQ839`) | ✅ existing | ✅ existing | ⛔ **TODO before go-live** |

The `document` resource type in Staging was created with parent type `project`, so a
document is addressable as an FGA resource that inherits its project's roles.

## How it was / is provisioned

Create the `document` resource type as a child of `project` in the target
environment (WorkOS dashboard → Authorization → Resource Types, or the management
API). Name `Document`, slug `document`, parent type `project`. Idempotent: creating
it when it already exists is a no-op.

Verify:

```
# via the WorkOS dashboard (Authorization → Resource Types), or list resource types
# for the environment and confirm document.parentTypeIds == [project].
```

## Runtime usage

- Default access is decided at the **project** level (`document` inherits `project`),
  so existing documents need no per-file resource and no backfill.
- Per-file grants (a document shared with, or restricted from, specific members) will
  register a `document` resource instance (external id = document uuid, parent =
  project) on upload and assign/clear roles on it — a later step (ADR-0023).

## Who consumes it

- **BFF** — `@/lib/authz/file-access` (`checkFileAccess`, cached) and the internal
  endpoint `POST /api/internal/file-access`.
- **file-gateway** — delegates to that internal endpoint (`GATEWAY_POLICY_MODE=bff`),
  or calls WorkOS FGA directly (`GATEWAY_POLICY_MODE=workos`).

# WorkOS provisioning, 8 Oct 2026

The product owner gave the go-ahead to provision WorkOS through the connector (8 Oct, about 06:00 UTC).

## Method

Additive only. The repo's `provision:authz --apply` *sets* each role's permission list to the catalog's, which can also remove permissions. develop had moved past this branch's base (`a7d30a14b` against `94dca7324`), so a full reconcile from here could take away a permission a newer develop relies on. I read each environment, diffed it against the catalog of the stack top (`stack/t1d`: PR #838 plus ticket 1, dumped to JSON), and wrote only what was missing. develop's `catalog.ts` is unchanged since `94dca7324`, and no gap-fix branch touches it.

## Diff and what was written

| Environment | Missing | Written | Read back |
|---|---|---|---|
| Staging (`environment_01KEF0YG238CSMNF731TEG010E`) | permission `org:downloads:view`; `admin` lacked it | `createPermission` (`permission_01M4D1MT87FED04MRHSS7FHT74`), `updateRole admin` with its 16 existing permissions plus the new one | `admin` holds 17, `org:downloads:view` among them; every other role unchanged |
| Production (`environment_01KEF0YGNYDFAFAS77EZEFQ839`) | the same | `createPermission` (`permission_01M4D1P15XW0P6RBDHT2AAX2X8`), the same `updateRole` | `admin` holds 17; project roles (viewer, contributor, editor, admin) match the catalog |

Nothing was removed and no other role was touched.

## Not done by hand, on purpose

Audit-log schemas (the Papierkorb, download-log, screening, ticket 1 and AI Act actions) are reconciled on every deploy by `deploy/pulumi/src/app/audit-schemas-job.ts`, which runs `provision-workos-audit-schemas.mjs --apply` (create or update only). They arrive with the code that emits them.

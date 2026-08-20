# Rolling out agent-authored documents

What a deployer has to do, in order, to ship the change that lets Piloti file a
report and a diagram into a project. Written after replaying the whole migration
chain against a throwaway PostgreSQL 16.13, so the preconditions below are the
ones the database actually enforced, not the ones the code implies.

One correction to an earlier claim of mine: these migrations are **not**
unexercised. `scripts/rls-test-db.sh` applies the full chain to a throwaway
Postgres on every frontend CI change, so the forward path has been running
routinely. What had never been exercised is what this page adds — the guards
under dirty data, and the down path.

Design: [`../superpowers/specs/2026-08-20-agent-authored-documents-design.md`](../superpowers/specs/2026-08-20-agent-authored-documents-design.md).
Roles: [`../database/row-level-security.md`](../database/row-level-security.md).

## 0. Before anything — check for duplicate sibling folder names

Migration `0063` adds `uniq_project_folders_parent_name`, and nothing has ever
stopped two folders in the same parent sharing a name. The migration **raises and
aborts** with the full list rather than deduplicating, because deleting a folder
row cascades through `documents_folder_id_project_id_fkey` and would unfile real
documents. Run this against staging and production first:

```sql
SELECT project_id,
       COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) AS parent,
       name, count(*)
FROM project_folders
GROUP BY 1, 2, 3
HAVING count(*) > 1;
```

Empty result → proceed. Any rows → rename them in the app first. The migration
will not do it for you, and you do not want it to.

## 1. The migration chain needs cluster roles that already exist

`0031` refuses to run unless three cluster-level roles are provisioned, and it
checks three separate properties with three separate errors. All three were hit
in order during the replay, which is the fastest way to learn the contract:

| Precondition | The error if it is missing |
|---|---|
| roles `grid_app_owner`, `grid_app_platform`, `grid_app_rw` exist | *"row-level security roles are missing … They are cluster-level objects and are deliberately not created by this migration."* |
| `grid_app_platform` holds **BYPASSRLS** | *"exists but does not hold BYPASSRLS. Cross-tenant work would silently see nothing."* |
| `grid_app_rw` is a **member of** `grid_app_platform` | *"Without the membership the platform step-up (SET LOCAL ROLE) is rejected and every background sweep goes quiet."* |

These are pre-existing requirements, not new ones — but a fresh environment
(a staging rebuild, a new region) hits them before it reaches `0063`, and the
failure looks like the new work rather than like provisioning.

## 2. Apply the migrations

`0063` → `0064` → `0065`, in order, as part of the ordinary chain. Verified: the
full 66-migration history applies clean on an empty database once §1 holds.

What they create, and what each is for:

| Object | Purpose |
|---|---|
| `documents.authored_by` (`'user'` default), `authored_by_producer`, `authored_by_run_id` | who wrote the bytes, what produced them, in which run |
| CHECK `documents_authorship_requires_provenance` | a non-`user` row must name **both** its producer and its run — a machine-written file that cannot say what wrote it is unauditable |
| `documents_agent_authored_idx` (partial) | "everything Piloti wrote in this project" as a point query |
| `uniq_project_folders_parent_name` | the fixed `Berichte` folder is get-or-create; this is what makes the race correct |
| `uniq_documents_authored_run_producer_per_project` | idempotency as a **constraint**, not a lookup. `0065` drops `0064`'s narrower index, which could not represent a diagram's SVG + PDF pair |

Verified against the real database, not inferred:

- an agent row without producer or run is **refused** by the CHECK;
- the same `(producer, run, project)` twice is **refused** by the unique index;
- a *different* producer with the same run is **accepted** — this is what lets one
  diagram file both its SVG and its PDF;
- two `'user'` rows sharing a run id are **accepted** — the partial predicate
  leaves human uploads alone;
- a duplicate sibling folder name is **refused**.

## 3. Register the audit schema — this one fails silently if skipped

Every deployment path now runs the reconcile for you. Check that it did:

| Path | What runs it | Where to look |
|---|---|---|
| Kubernetes (Pulumi) | Job `grid-app-audit-schemas`, per deploy, when `requireAuth` is on. **The frontend does not wait for it**, so a rollout can serve filing requests for as long as the Job takes. | `kubectl get job grid-app-audit-schemas` — within 5 minutes of finishing, `ttlSecondsAfterFinished` reaps it |
| Docker Compose / Coolify | one-shot service `grid-audit-schemas`; `frontend` waits on it, so a failure stops the stack instead of serving a Piloti that files nothing | the deploy log for that container |

By hand, from `frontends/ui` — for a fresh environment, a key the deployment does
not hold, or to check for drift without writing:

```bash
WORKOS_API_KEY=sk_… npm run provision:audit-schemas            # read-only drift check
WORKOS_API_KEY=sk_… npm run provision:audit-schemas -- --apply
```

`document.generated` and its `agent_run` **and `answer_artifact`** targets must
exist in WorkOS **before the first real emit.** A schema that is present but
STALE fails exactly like a missing one: migration 0066 added `answer_artifact`
to that action's targets, so an environment provisioned before it rejects every
emit — check reports `DRIFT`, not `MISSING`, and both are fatal here. Its failure
mode is the worst kind:

`fileGeneratedDocument` uses the **throwing** audit emitter on purpose — a
document whose audit record does not exist must not be presented as filed. So an
unregistered schema means WorkOS rejects the event, the emit throws, the document
is **unfiled** (row and object deleted), and the user sees a report with no file
and no error. That is not hypothetical: this exact failure shipped once during
development from a single unregistered metadata key, and made the feature a
complete no-op while every test stayed green.

Nothing in CI can catch it, because the registration lives in WorkOS and not in
the repository — `schemas.spec.ts` only proves the registry is internally
consistent, never that the environment matches it. **Verify after deploy** by
filing one report and confirming a `document.generated` event appears in the
audit log.

## 4. Rollback, and what it will refuse to do

The down migrations guard themselves — **but only if you invoke psql so that a
raised exception actually stops it.** This is the correction that matters most on
this page, because getting it wrong looks like success:

```bash
psql -v ON_ERROR_STOP=1 --single-transaction -f 0063_agent_authored_documents.down.sql
```

Without `ON_ERROR_STOP=1`, psql **prints the guard's refusal and carries on**,
dropping `authored_by_run_id`, the CHECK and both indexes anyway — precisely the
state the guard exists to prevent, announced as it happens and ignored. The
guards are advisory to the script, not to the server. `--single-transaction`
makes the file atomic, so a mid-file failure cannot leave the schema half
reversed.

With that invocation, verified with data present:

- `0065` down **refuses** if any run has filed more than one document into one
  project — the SVG + PDF pair that `0064`'s index cannot represent.
- `0063` down **refuses** while any `authored_by <> 'user'` row exists: *"Dropping
  the columns would leave them looking like files a human uploaded and stands
  behind, with no record of what wrote them or in which run."*

So rollback is clean **only before anyone uses the feature**. Verified: with no
agent rows, all three down migrations apply cleanly, the columns disappear, and
re-applying `0063`–`0065` forward works — the change is fully reversible in that
window.

Once agent-authored documents exist, rolling back is an application-level task
first: delete those documents through the app so their objects and chunks go with
their rows, then migrate down. Deleting the rows in SQL would strand objects in
SeaweedFS that no cascade can reach.

**Do NOT reach for the permission as a kill switch.** An earlier version of this
page suggested withdrawing `project:documents:write` to stop filing without
touching the schema. That is wrong and would have broken customers: it is the
same permission that authorizes a **human upload**
(`lib/documents/service.ts:589`), a delete (`:1152`) and a re-ingest (`:919`).
Withdrawing it stops the office putting its own files into its own project — a
far worse outage than the one it was meant to contain.

There is currently **no flag that disables filing alone**, and that gap is worth
closing before rollout rather than after: `lib/authz/feature-flags.ts` has no
entry for this capability, although the design's own commit plan said the filing
path would land behind one. Until it exists, the honest rollback under time
pressure is **redeploy the previous image and leave the schema in place** — the
columns are additive and nothing older reads them.

Two things are stranded by that path, and both should be expected rather than
discovered: with `uniq_project_folders_parent_name` still in place, the older
`createProjectFolder` (which gains its `23505` catch only on this branch) answers
a duplicate folder name with a 500; and already-filed documents lose their
„Von Piloti erstellt" line, so they read as ordinary human uploads.

## 5. After deploy — what to check

| Check | Why |
|---|---|
| File one report; confirm it appears under `Berichte` | the end-to-end path |
| Confirm a `document.generated` audit event exists | §3's silent failure |
| Confirm the report renders **grey / „Von Piloti erstellt"**, never green | provenance must not read as evidence |
| Confirm it is **Unvergeben** | nobody is responsible until somebody says so |
| Ask a question the report would answer; confirm the answer does **not** cite it | the invariant the whole design is shaped around |

## 6. Known limits at ship

- **A report nobody re-opens is never filed.** There is no server-side completion
  signal; filing happens when a client fetches the report. The banner promises
  „wird abgelegt" and that promise holds for every report anyone opens.
- **Scheduled runs do not file.** Same root cause: no client, no fetch.
- Both are one fix — a backend completion callback into an internal BFF route.

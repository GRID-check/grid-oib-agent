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

`0063` → `0064` → `0065` → `0066`, in order, as part of the ordinary chain.
Verified: the full 67-migration history applies clean on an empty database once
§1 holds.

What they create, and what each is for:

| Object | Purpose |
|---|---|
| `documents.authored_by` (`'user'` default), `authored_by_producer`, `authored_by_ref`, `authored_by_ref_kind` | who wrote the bytes, what produced them, which one, and what kind of identifier that is |
| CHECK `documents_authorship_requires_provenance` | a non-`user` row must name **all three** — a machine-written file that cannot say what wrote it, or whose identifier nobody can resolve, is unauditable |
| `documents_agent_authored_idx` (partial) | "everything Piloti wrote in this project" as a point query |
| `uniq_project_folders_parent_name` | the fixed `Berichte` folder is get-or-create; this is what makes the race correct |
| `uniq_documents_authored_ref_producer_per_project` | idempotency as a **constraint**, not a lookup. `0065` drops `0064`'s narrower index, which could not represent a diagram's SVG + PDF pair; `0066` restates it under the renamed column |

`0066` also **backfills** `authored_by_ref_kind` from `authored_by_producer` —
`deep_research` → `agent_run`, `diagram_svg`/`diagram_pdf` → `answer_artifact` —
and **refuses to run** if any machine-authored row names a producer it has no
kind for, rather than writing a plausible guess into the record the feature
exists to make truthful. If you have added a producer, add it to that CASE in the
same change.

Verified against the real database, not inferred:

- an agent row missing its producer, its reference or its reference **kind** is
  **refused** by the CHECK;
- the same `(producer, reference, project)` twice is **refused** by the unique
  index — for both kinds of reference;
- a *different* producer with the same reference is **accepted** — this is what
  lets one diagram file both its SVG and its PDF;
- two `'user'` rows sharing a reference are **accepted** — the partial predicate
  leaves human uploads alone;
- a duplicate sibling folder name is **refused**;
- `0066` over rows written by the `0065` build backfills the kind correctly per
  producer and leaves human rows untouched.

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

## 3a. Provision the authorization catalog — filing is refused until you do

`project:documents:generate` is a NEW permission and nothing holds it until the
catalog is applied. It is required **in addition to** `project:documents:write`
at the filing seam and is deliberately **not** satisfied by the legacy
`project:edit` umbrella, so this step is not optional for an environment that
wants the feature on:

```bash
WORKOS_API_KEY=sk_… npm run provision:authz            # read-only drift check
WORKOS_API_KEY=sk_… npm run provision:authz -- --apply
```

`--apply` creates the permission and adds it to the built-in `project-editor`
and `project-admin` roles. Until it has run, filing is refused for everyone
except org admins (who bypass per-project FGA by the named `org-admin-bypass`
rule) — the report is still delivered, and the success banner says the filing
failed. A **custom** project role provisioned before this change never gains the
permission automatically; grant it there by hand, or leave it withheld, which is
the supported way for a tenant to say "Piloti may answer here, not write".

Unlike §3 this one is visible: `provision:authz` reports it as drift, and CI runs
the read-only check.

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

- `0066` down **refuses** while any machine-authored row carries a reference kind
  other than `agent_run` — rolling back renames the column to
  `authored_by_run_id` and drops the kind, so a filed diagram would go back to
  claiming a run it cannot name.
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

**Do NOT reach for `project:documents:write` as a kill switch.** An earlier
version of this page suggested withdrawing it to stop filing without touching the
schema. That is wrong and would have broken customers: it is the same permission
that authorizes a **human upload** (`lib/documents/service.ts`,
`uploadDocument`), a delete (`deleteDocument`) and a whole-project re-index
(`reindexProject`). Withdrawing it stops the office putting its own files into
its own project — a far worse outage than the one it was meant to contain.

There are now two levers that stop filing alone, and they answer different
questions. Pick by who is pulling.

| Who | Lever | What it does | What it costs |
|---|---|---|---|
| **A tenant** that wants Piloti to answer but not write | withhold `project:documents:generate` | Filing is refused for that role, on every producer, before a byte is rendered. Uploads, deletes and re-ingests are untouched. | Put the people on a **custom** project role that omits the permission. Do **not** edit the built-in `project-editor` / `project-admin` roles: they are in `lib/authz/catalog.ts`, and editing them in WorkOS makes `provision:authz --check` fail in CI. |
| **The operator** who has to stop filing everywhere, now | `GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED=false` (or, with `GRID_ENFORCE_FEATURE_FLAGS=true`, untarget the per-org `agent-authored-documents` flag) | Filing is refused for every organization and every producer, at the one seam, before any permission is read. | A config change and a restart (K8s: the stack key `grid-oib:agentAuthoredDocumentsEnabled`), or — under flag enforcement — a dashboard change and no deploy at all. |

Both refuse **before** anything is rendered, stored or charged, so neither leaves
a half-filed document behind. What a reader sees is what a refused quota already
looked like: the report is still delivered in the chat, and the success banner
carries `filingFailed` rather than a file
(`docs/api/bff-routes.md`, Deep Research). Note the honest limit of that: the
starting banner's „wird abgelegt" line is **not** gated on either lever, so with
filing switched off the promise is still made and then reported broken. That is
the same behaviour a withheld `project:documents:write` has always had, and
gating the disclosure would mean plumbing a per-project permission into the chat
client before the run starts.

Rolling the **image** back is still available and is still the right move when
the problem is not filing itself — the columns are additive and nothing older
reads them.

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
| Move a test user to a project role without `project:documents:generate`; confirm they can still upload a file and that a run files nothing | the lever this feature was missing, exercised once rather than assumed |

## 6. Known limits at ship

- **A report nobody re-opens is never filed.** There is no server-side completion
  signal; filing happens when a client fetches the report. The banner promises
  „wird abgelegt" and that promise holds for every report anyone opens.
- **Scheduled runs do not file.** Same root cause: no client, no fetch.
- Both are one fix — a backend completion callback into an internal BFF route.

# Promoting `develop` to `prod`

The checklist for moving staging to production when the two have drifted far
apart. A promotion is normally a merge and an image pin
([`cd.md`](cd.md)); after weeks of drift it is those two steps plus four that
have to happen *before* the door opens, because 28 migrations and an embedding
change do not roll back with the image.

Written 2026-09-17 against the gap below. The mechanism does not change, so
reuse the list; re-measure the numbers.

## Where the two stand

| | `prod` | `develop` |
|---|---|---|
| Branch tip | `d576b5f3` (2026-08-26) | `6013dca8` (2026-09-17) |
| Deployed image | `sha-8d588ad2e…` | `sha-<each develop push>` |
| Last deploy | run 259, green | run 432, green |

- **802 commits** on `develop` that `prod` does not have.
- **28 migrations**, `0063` → `0091`.
- **151 release notes** — tasks and automation, document versions and the
  publish door, the files workspace, diagrams, deep-research reliability.
- **The merge is clean.** Dry-run on 2026-09-17: 2750 files, no conflicts.

## 1. Pick a sha that has all three images

Prod pins **one** tag for backend, frontend and web (`grid-oib:imageTag`); the
prod job sets no config and resolves no per-service refs. Publish Images on
`develop` is **incremental**, so most develop tips have only some of the three.
`6013dca8` built `grid-web` alone — pinning prod to it puts the backend and the
frontend into `ImagePullBackOff`.

- [ ] Actions → **Publish Images** → *Run workflow* on `develop`. A dispatch
      builds all three regardless of the paths filter.
- [ ] Confirm all three build jobs succeeded, and note the sha the run used.
- [ ] Confirm **CI OK** and **Security OK** are green on that same sha. Nothing
      re-checks them on a `prod` push — `ci.yml` does not run there.

## 1b. Prove the prod deploy can still authenticate

**This is what broke the 2026-09-17 promotion.** Every gate ahead of the apply —
typecheck, `validate-crs.mjs`, the CrossGuard policy pack — builds its plan from
stack config and never touches the cluster, so all three pass against a dead
credential and the failure lands *after* the merge, at `pulumi up`:

```
error: configured Kubernetes cluster is unreachable: unable to load schema
information from the API server: the server has asked for the client to
provide credentials
```

That is a 401, not a network problem. The kubeconfig in the `grid-oib/prod` ESC
environment was a Control-Center token, and those expire within two weeks
([`kubernetes.md`](kubernetes.md) §2b). Prod deploys at promotion cadence, so
the credential is dead more often than it is alive.

- [ ] Open the stored kubeconfig and use it once before you merge —
      `esc env open matthiasbigl/grid-oib/prod` for
      `pulumiConfig.grid-oib:kubeconfig`, then `kubectl get ns` with it. A 401
      here costs you a minute; a 401 after the merge leaves `prod` carrying a
      promotion it has not deployed.
- [ ] If it fails, mint the **non-expiring ServiceAccount token** from
      `kubernetes.md` §2b and `esc env set … --secret` it. Do not re-download a
      Control-Center kubeconfig: that is the same failure with a two-week fuse.
- [ ] Check the stack has no **pending operations** from an interrupted update.
      They surface as `Attempting to deploy or update resources with N pending
      operations from previous deployment`, and a pending CREATE can only be
      cleared by an **interactive** `pulumi refresh` — CI cannot do it.

## 2. Preflight the production database

Six of the 28 migrations `RAISE EXCEPTION` rather than guess. Three of those
read columns that exist in prod today, so they are the ones that can abort the
`grid-app-migrate` Job mid-rollout. Run them read-only first — an aborted
migration Job is a half-deployed cluster, and finding out at 02:00 is a choice
you make now.

```bash
kubectl -n grid exec -it grid-pg-1 -- psql -U postgres grid_app
```

**A. Duplicate sibling folder names** (`0063` adds `uniq_project_folders_parent_name`):

```sql
SELECT project_id,
       COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) AS parent,
       name, count(*)
FROM project_folders GROUP BY 1, 2, 3 HAVING count(*) > 1;
```

Rows → rename them in the app first. The migration will not dedupe for you:
deleting a folder cascades and unfiles real documents.

**B. Soft-deleted documents** (`0077` drops `documents.deleted_at`):

```sql
SELECT count(*) FROM documents WHERE deleted_at IS NOT NULL;
```

Non-zero → decide per row. Dropping the column makes those documents visible
again. Delete them through the application (which also erases the stored object
and the quota charge) or `SET deleted_at = NULL`.

**C. Two live documents under one name** (`0074`, widened by `0083`):

```sql
SELECT organization_id, collection_name, filename, count(*)
FROM documents WHERE deleted_at IS NULL
GROUP BY 1, 2, 3 HAVING count(*) > 1;
```

Rows → re-upload ghosts. Only the newest of each group still has passages in
the retrieval index; delete the rest through the app, then re-upload once.

The other three guards (`0064`, `0066`, `0083`) read `authored_by*`, which
`0063` creates. Prod has no machine-authored rows yet, so they cannot trip on
this promotion. They will on the next one.

Also true of this chain, and not reversible by redeploying the old image:

- `0071` deletes the retired Piloti house skills; `0088` drops standard
  delivery; `0077` drops a column. `.down.sql` files exist for each, but a
  rollback is a deliberate act, not the image pin going back.

- [ ] A, B and C return nothing, or the rows are resolved.
- [ ] A **fresh backup exists and has been looked at**. Prod runs
      `pgBackupsEnabled=true`, nightly at 02:00, 30-day retention — verify the
      most recent one completed rather than trusting the schedule.
- [ ] Remember `protectDataResources: true`: Pulumi refuses to delete or
      replace the Postgres cluster and the storage StatefulSets, so the apply
      cannot take the data tier with it.

## 3. Settle the retrieval index before the deploy, not during it

Two changes since August are coupled, and neither is a deploy step:

- **The embedding model moved** off the NVIDIA embedder to
  `openai/text-embedding-3-large` (release note `embed-model-migration`).
  Collections carrying a fingerprint refuse a mismatched model; collections
  written before fingerprints existed are adopted **silently** and retrieve
  garbage. Prod does not pin `grid-oib:embedModel`, so it takes the default.
- **The OIB corpus left the repository** (`7d183927`, "the corpus belongs to
  the operator"). The backend image no longer ships `data/oib/*.pdf`; the
  platform owner supplies them through the admin upload path or the
  bind-mounted directory.

- [ ] Establish which model built prod's current collections. If they predate
      the switch, plan the rebuild — delete the Chroma volume, re-ingest the
      base corpus and **every** project collection — as its own window.
- [ ] Have the corpus in hand before any rebuild. A rebuild without the PDFs
      leaves production with an empty base corpus and a working UI, which is
      the failure nobody notices for a day.
- [ ] Consider pinning `grid-oib:embedModel` on the prod stack, so the next
      default change is a decision instead of a surprise.

Detail: [`../technical-reference/document-ingestion.md`](../technical-reference/document-ingestion.md)
→ *Embedding-model changes invalidate stored vectors*.

## 4. Provision the production WorkOS environment

The authz catalog gained `project:documents:generate` (file agent-authored
documents) and grants it to roles. Prod runs its own WorkOS environment
(`prestigious-energy-03`), and `workos-drift.yml` only checks Staging — nothing
tells you prod is behind.

```bash
cd frontends/ui
WORKOS_API_KEY=sk_live_… npm run provision:authz            # read-only
WORKOS_API_KEY=sk_live_… npm run provision:authz -- --apply # writes
```

- [ ] Run the check, read the drift, then apply. `--apply` writes the catalog
      into WorkOS — a one-way door under [`AGENTS.md`](../../AGENTS.md); do it
      deliberately, not as part of a scripted step.
- [ ] `npm run provision:workos-env` (check) for redirect URIs and the rest of
      the environment identity.

Runbook: [`workos-provisioning.md`](workos-provisioning.md).

## 5. Review the deltas you are deliberately keeping

No new **required** config key entered the program since prod's tip — the keys
added are all optional (`vlmModel`, `posthogHost`, `posthogProjectToken`,
`vectorReconcileSchedule`, `clickhouseStorageSize`), so the prod stack file
needs nothing beyond the pin. What differs between the stacks differs on
purpose:

| Key | dev | prod | Why |
|---|---|---|---|
| `storageClass` | `single-replica` | `premium` | 3 storage replicas for durable data |
| `pgInstances` | 1 | 3 | HA |
| `protectDataResources` | false | true | refuses to delete/replace the data tier |
| `useStagingIssuer` | — | false | real Let's Encrypt certs |
| `err2issueEnabled` | true | false | a repo-write token is not a prod posture |
| `dnsZoneBaseline` | true | false | prod zone records are not swept |
| `seaweedfsImage` | (default) | `3.80` | prod pins the storage engine |
| `loadBalancerIp` | `…209.191` | `…209.196` | separate clusters |

- [ ] Nothing in that table changes in this promotion unless you decide it does.

## 6. The promotion

```bash
git fetch origin develop prod
git switch -c release/promote-<date> origin/prod
git merge origin/develop
# bump the pin — the merge does NOT do it for you:
#   grid-oib:imageTag: sha-<the sha from step 1>
$EDITOR deploy/pulumi/Pulumi.prod.yaml
```

`develop`'s copy of `Pulumi.prod.yaml` still pins `e70a14d6` — **older** than
what prod runs. The merge keeps prod's line (verified), so an unedited merge
deploys the current image, not the new one. The pin is the promotion.

- [ ] PR titled `chore(release): promote develop to prod (…)` — the repo
      squash-merges the title, and the Conventional PR title job blocks a prose
      one.
- [ ] Merge to `prod`. `deploy.yml`'s `deploy-prod` job runs: preview →
      `validate-crs.mjs` → CrossGuard policy pack → `pulumi up`, behind the
      `production` GitHub environment's required reviewers.
- [ ] Confirm that environment still has reviewers on it. Without them the job
      runs unreviewed.

## 7. After the apply

- [ ] `kubectl -n grid get jobs` — `grid-app-migrate` **Completed**, not
      `BackoffLimitExceeded`. This is where a missed step 2 lands.
- [ ] `kubectl -n grid get pods` — no `ImagePullBackOff` (step 1), no crash
      loops in backend, frontend, web, `agent-worker`.
- [ ] Sign in; ask a question and get a cited answer; upload a file and see it
      ingest; run a task; publish a document version; render a diagram. Those
      are the surfaces the 151 notes moved.
- [ ] TLS and DNS unchanged: `app.piloti.at` serving a real cert, the Envoy
      LoadBalancer still on `45.144.209.196`.

## 8. If it goes wrong

- **Image-level**: pin `grid-oib:imageTag` back to `sha-8d588ad2e…` and push.
  Same gates, same gated rollout.
- **Schema-level**: the migrations do not come back with the image. `.down.sql`
  exists for every migration in this chain, but `0077` dropped a column and
  `0071` deleted rows — restoring those is the backup from step 2, not a
  redeploy.
- `pulumi cancel` abandons an in-flight update; it does not revert one.

## 9. Close the ratchet

This list exists because three weeks of drift turned a merge into a project.
The costs above scale with the gap, and two of them (the migration guards, the
index rebuild) scale worse than linearly.

- [ ] Promote on a cadence, not when someone notices.
- [ ] `develop`'s `Pulumi.prod.yaml` pin drifts **backwards** relative to
      `prod`, because the pin is bumped on the prod branch and never merged
      back. Either merge `prod` into `develop` after a promotion, or stop
      keeping a live value in a file only the other branch edits.
- [ ] Nothing watches the prod kubeconfig's lifetime, and the first thing that
      notices is a failed apply on an already-merged promotion. A non-expiring
      ServiceAccount token removes the clock; until prod has one, §1b is the
      check standing in for it.

# Continuous Deployment (Pulumi + GitHub Actions)

Branch-to-environment CD, gated on the full CI pipeline.

```
develop ──(green CI push run)──▶ deploy.yml ──▶ pulumi up  dev  stack ──▶ staging domain
prod    ──(promotion PR, reviewers)──▶ deploy.yml ──▶ pulumi up  prod stack ──▶ production domain
```

CI builds each image only when GHCR has no image with the same inputs, and tags
all three images `sha-<commit>` once every check on the commit has passed
([ci.md](../contributing/ci.md#images-and-deploys)). So every commit CI passed
has all three images, every deploy pins all three to the commit it deploys, and
a commit CI failed cannot be deployed by accident.

- **State + secrets**: [Pulumi Cloud](https://app.pulumi.com). Stack state lives
  there, and the app secrets live in the **ESC environment `grid-oib/<stack>`**,
  imported by the stack file's `environment:` block — not in GitHub and not as
  committed ciphertext. `Pulumi.<stack>.yaml` holds only non-secret config (so
  config changes stay reviewable in the PR diff); after the ESC migration it
  contains no `secure:` blocks.
- **The only GitHub secret** the pipeline needs is `PULUMI_ACCESS_TOKEN`.
- **Gating**: `deploy.yml` runs on `workflow_run` of **CI**, for a run that
  concluded `success`, was a `push` (not a pull request whose branch happens to
  be called `develop`) and came from this repository. A green push run of CI
  means every check passed and the commit's images are tagged, so there is
  nothing left to poll. A **cancelled** run is a commit superseded while queued:
  the newer commit's run covers it (it diffs against the last green commit) and
  deploys instead. A **failed** run deploys nothing, and the next green commit
  deploys everything since.
- **What GitHub shows**: each deploy job is a deployment to its GitHub
  environment, with the URL the stack reports (output `appUrl`), so the
  repository's Deployments page and each deployed commit link to the running
  app. The run summary lists the commit and the three image refs it pinned.
- **The Pulumi CLI** is the release of the `@pulumi/pulumi` SDK that
  `deploy/pulumi/package-lock.json` pins, not `latest`. Dependabot bumps the
  SDK, and the CLI follows in the same reviewed diff; staging and prod always
  run the same one.
- **Reused PR results**: a push whose tree a green pull request run already
  tested, on top of a green parent, skips its checks and still builds and tags
  the images, so it deploys like any other green push. How the reuse is decided:
  [ci.md](../contributing/ci.md#how-a-ci-run-decides-what-to-run).

## One-time setup

### 1. Pulumi Cloud
```bash
cd deploy/pulumi
pulumi login                     # Pulumi Cloud
pulumi stack init matthiasbigl/grid-oib/dev
pulumi stack init matthiasbigl/grid-oib/prod
```
Stacks are named `<org>/<project>/<stack>` and every command in this guide, in
`deploy/pulumi/README.md`, and in `deploy.yml` uses that one fully-qualified
identity (`matthiasbigl/grid-oib/dev` for staging) — there is no second stack.
Create a Pulumi **access token** (Pulumi Cloud → Settings → Access Tokens).

### 2. Populate each stack's config
Edit the non-secret placeholders in `Pulumi.dev.yaml` / `Pulumi.prod.yaml`
(`storageClass`, `baseDomain`, `letsEncryptEmail`, `workosClientId`).

**Secrets live in a Pulumi ESC environment** (imported via the stack file's
`environment:` block), not in the committed file — rationale in
[pulumi-cloud-feature-audit.md](pulumi-cloud-feature-audit.md):
```bash
pulumi stack select matthiasbigl/grid-oib/dev
# First-time migration of file-based secrets into ESC:
pulumi config env init --stack dev --keep-config   # creates the grid-oib/dev environment
# …then delete the now-duplicated `secure:` blocks from Pulumi.dev.yaml —
# `--keep-config` leaves them behind and stack config OVERRIDES ESC, so the
# secrets only really move once they are gone.
pulumi preview --stack dev   # must be a no-op: same values, now via ESC
# Setting/changing a secret afterwards:
pulumi env edit grid-oib/dev                        # add under values.pulumiConfig as fn::secret
```
Commit the updated `Pulumi.dev.yaml` (plaintext + `environment:` import only).

### 3. GitHub Environments (Settings → Environments)
Create **`staging`** (and later `production`). On each, add the secret
`PULUMI_ACCESS_TOKEN` (used for the gate previews and the apply). On **`production`**, add **required reviewers** so a prod deploy
pauses for manual approval.

Restrict each environment to the branch it deploys (**Deployment branches and
tags → Selected branches**): `develop` for `staging`, `prod` for `production`.
An environment secret is then unreadable from any other branch's workflow run,
including a workflow file someone edits on a feature branch. Delete the
repository-level `PULUMI_ACCESS_TOKEN` once both environments hold their own:
a repository secret reaches every workflow on every branch.

Optional, and better than any stored token: exchange the job's GitHub OIDC
token for a short-lived Pulumi token with
[`pulumi/auth-actions`](https://www.pulumi.com/docs/pulumi-cloud/access-management/oidc/client/github/).
It needs the GitHub issuer registered in Pulumi Cloud (Settings → OIDC Issuers,
with a policy limited to this repository and environment), `id-token: write` on
the deploy jobs, and one step in place of the secret; after that there is no
`PULUMI_ACCESS_TOKEN` left to leak or rotate.

### 4. Branch protection (Settings → Branches)
For `develop`, require the status checks **`CI OK`** and **`Conventional PR
title`**. For `prod`, require the promotion PR's `CI OK`. Do not require
`Security OK`: the security scans a change can fail are inside `CI OK`, the
weekly Security run gates nothing, and a required check that never reports
blocks every PR.

### 5. DNS
Point `app.<domain>` / `s3.<domain>` (prod) and `app.dev.<domain>` / `s3.dev.<domain>`
(staging) at each cluster's Gateway LoadBalancer IP
(`kubectl -n envoy-gateway-system get svc`). Keep `useStagingIssuer: true` until
DNS resolves and a staging cert issues, then flip prod to `false`.

## Runner → cluster reachability
Only the **apply** needs the cluster. The **gates** (typecheck, CRD-schema
validation, CrossGuard) run on Blacksmith/GitHub-hosted runners and only need
Pulumi Cloud — the plan they check is built from stack config, so they pass with
a kubeconfig pointing at an unreachable API (see
[`deploy/pulumi/README.md`](../../deploy/pulumi/README.md) → *Validation*). The
**apply** runs on the same runner (`pulumi up --yes` right after the gates),
which therefore **must reach the cluster API endpoint** (public endpoint +
credentials in the kubeconfig is fine; if it is ever private, the apply needs a
self-hosted runner inside the cluster network).

Every update against the Pulumi Cloud backend is recorded in the console —
stack → **Activity** — with full logs and diffs, regardless of where the CLI
ran. (The Pulumi-hosted **Deployments** path was evaluated and reverted; see
[pulumi-cloud-feature-audit.md](pulumi-cloud-feature-audit.md).)

## Deploy-time gates
Before `pulumi up` touches the cluster, `deploy.yml` plans once and checks that
plan twice:
- **`scripts/validate-crs.mjs`** — schema-validates every CustomResource against
  the real upstream CRD schemas (tsc cannot type `apiextensions.CustomResource`).
  KEDA's `keda.sh/v1alpha1` resources use the CRDs of the release the program
  installs, including every tier's `TriggerAuthentication` and `ScaledObject`.
  That release is one constant, `KEDA_CHART_VERSION` in
  `deploy/pulumi/src/platform/keda.ts` (the chart is pinned to it, and the
  script reads it from there), so the plan is always checked against the
  operator it will meet. Like CNPG, these schemas are fetched once and cached
  under `deploy/pulumi/.schemas-cache/`, keyed by release URL and kind set. A
  schema download or validation failure blocks deployment; `ALLOW_SKIP` does not
  bypass a registered validator. Upgrading KEDA is changing that constant: read
  the release notes for `fallback` and the `postgresql` scaler first.
- **CrossGuard policy pack** (`deploy/pulumi/policy`, `--policy-pack ./policy`) —
  rollout safety (surge-only updates, readiness soaks, progress deadlines,
  shutdown budgets), CPU/memory bounds on every container, and pull-policy
  correctness for moving tags. A `mandatory` violation fails the plan.
  Run it locally with `cd deploy/pulumi && npm run policy`.

The apply itself then runs on the same runner (`pulumi up --yes`), deploying the
same commit the gates validated — the image pins were set before the preview,
and the update is recorded in the Pulumi Cloud console's **Activity** tab with
the full diff and logs. The policy pack does not re-run on the apply; the GHA
preview is the policy checkpoint, and drift between gate and apply is the
accepted residual (see
[pulumi-cloud-feature-audit.md](pulumi-cloud-feature-audit.md)).

## Image pinning

`deploy.yml` pins one ref per service
([`resolve-image-refs.sh`](../../deploy/pulumi/scripts/resolve-image-refs.sh)):

- after a green CI run, all three are the commit's `sha-<40-hex>` tag, which
  the workflow verifies GHCR has before it pins anything;
- an operator rollback (dispatch with `imageTag`) pins all three to that tag,
  verified the same way;
- a bare dispatch (no `imageTag`) pins each service to the newest commit on
  develop's first-parent line whose `sha-<commit>` tag GHCR has (a manifest
  `HEAD` per commit, up to 200 back). That is the newest commit CI passed.

Then the **downgrade guard**: each resolved commit must be the deployed commit
or a descendant of it, where "deployed" is the stack output `deployedImages`
that every `pulumi up` records. A resolved image older than the running one
fails the job with both refs named; only an operator rollback may go
backwards, and it logs a warning. A deployed ref that is not a `sha-` tag, or a
commit the checkout does not know, is a warning, not a failure. Each service's
move is logged as `<service>: <deployed ref> -> <resolved ref>`.

The committed stack file cannot say what is deployed: CI's `pulumi config set`
never reaches git, so `pulumi config get grid-oib:backendImage` on a fresh
checkout is empty and `imageTag` reads `latest` whatever is running. That is why
the guard reads the stack output.

Images used to be built per service only when that service's paths changed, so
a commit could have one image and not the others, and this section was about
picking a different commit for each service. A merge train broke it: queued
publishes were dropped, the survivor diffed only against its own parent, and
the changes of five merged pull requests never reached an image. Images are now
named by their inputs and tagged per green commit, so that state cannot arise.

## Rolling out ADR-0071

[ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)
moved Word, presentation, `.xls` and `.ods` indexing onto the PDF the BFF
converts. The two tiers must not be skewed the wrong way round:

- **New backend, old BFF**: the old BFF sends no `extraction_ref`, so the
  backend refuses those files as `office_rendition_required` and marks them
  failed.
- **New BFF, old backend**: harmless. The old backend ignores the unknown
  `extraction_ref` field and reads the original as it used to.

A single `pulumi up` rolls `frontend` and `aiq-agent` in parallel, so the first
case can last as long as the frontend's surge rollout. Office uploads in that
window fail with a retryable reason. After the deploy, open the affected files
and use "Erneut lesen"; it converts again and ingests through the new path.

Closing the window means a frontend-only deploy first, and the pipeline has no
such step: a manual dispatch pins all three images, and a local `pulumi up`
from a fresh checkout does not know the deployed pins (see "Image pinning").
Pick a quiet moment instead, or accept the retries.

Gotenberg must be running (`gotenbergEnabled`, default on) before the new
backend takes traffic. With it off, every Word and presentation upload fails.

## Rolling back
Deploys pin every service to an immutable `sha-<40-hex>` image tag, so a
rollback is a deploy of an older tag — not a revert. It is also the only way a
service moves to an older commit: an automatic deploy that resolves one fails
the downgrade guard.

1. Actions → **Deploy (staging)** → *Run workflow*.
2. Set **`imageTag`** to the previous good build's tag: `sha-` + the full sha
   of any `develop` commit whose CI push run passed. A rollback pins **all
   three** services to that tag, after verifying GHCR has it for all three.
3. It goes through the identical gates and the identical gated rollout — surge,
   readiness soak, drain. Nothing special-cases a rollback.

For a change to the deployment *program* itself (not just the image), check out
the previous commit and `pulumi up` from there. `pulumi cancel` only abandons an
in-flight update; it does not revert one.

Note that `protectDataResources` (default true on prod) makes Pulumi refuse to
delete or replace the Postgres cluster and the storage StatefulSets, so a
rollback can never quietly take the data tier with it.

## Workflow gotchas

Traps this pipeline has actually hit. Each one broke a real run — the code that
avoids them looks odd without the reason, so don't "simplify" it back.

- **A new custom-resource group needs a plan validator too.** Adding KEDA's
  ingest autoscaler without registering `keda.sh/v1alpha1` let the manifest
  tests pass but stopped staging at `no validator wired`. The regression suite
  now sends the ingest module's emitted resources through the same validator
  CLI that deployment runs. Register a validator when adding a CR group;
  setting `ALLOW_SKIP=1` only hides the missing check.

- **A shallow checkout with `persist-credentials: false` cannot diff a push.**
  `paths-filter` compares against the diff base (the PR's base on a pull request,
  `github.event.before` on a push); that commit is absent from a depth-1 clone,
  so the action falls back to `git fetch` — which has no
  token and dies with `could not read Username for 'https://github.com'`. The
  "Detect changes" job therefore uses `fetch-depth: 0`: the base commit is
  already local, so nothing is fetched and no credential is persisted. Applies
  to any step that reads history (diffing, `git describe`, changelog
  generation), not just this one.
- **A failed "Detect changes" publishes nothing at all.** All three build jobs
  `needs: changes`, so one broken filter job skips the whole fleet — and the
  chained deploy then skips too (`workflow_run` sees `conclusion: failure`).
  When staging looks stale, check that job first; the images for that sha may
  simply never have been built.
- **There is no `/repos/{owner}/{repo}/packages/...` REST endpoint.** It 404s.
  Packages live under `/orgs/{org}/...` or `/users/{user}/...`, which differ by
  owner type and need pagination over every sha ever published. The rollback
  check and the image resolver ask GHCR itself instead
  (`find-published-tag.sh`) — a manifest `HEAD` with a scoped pull token,
  the same lookup the kubelet performs. It needs `packages: read` on the job
  token, which `deploy.yml` declares.
- **The Actions run list is not a record of what was built.** Its filters
  (`?branch=develop&status=success`) are served from a search index with
  limits, and on 09-28 it twice returned a list without the newest backend
  build: the deploy pinned a 09-11 backend, the UI spoke wire v2 to it, and
  every chat hung. Resolve images from git history and the registry, which is
  what `resolve-image-refs.sh` does, and never from that list.
- **GHCR repository paths are lowercase; `$GITHUB_REPOSITORY_OWNER` is not.**
  The owner login is `GRID-check`, `docker/metadata-action` lowercases the image
  name on push, and containerd rejects a mixed-case reference outright
  (`repository name must be lowercase`). Anything composing an image ref from
  the owner must fold the case first — an uppercase ref reaches the cluster as
  an unpullable image, not as a workflow error.

## Day-to-day
- Merge to `develop` → staging deploys automatically once green.
- Fast-forward/merge `develop` → `prod` → production deploys after approval.
- Roll back: see above.

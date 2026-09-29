# Continuous Deployment (Pulumi + GitHub Actions)

Branch-to-environment CD, gated on the full CI pipeline.

```
develop ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  dev  stack ──▶ staging domain
prod    ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  prod stack ──▶ production domain
```

On `develop`, Publish Images rebuilds only the images whose files changed (a
blog-post commit rebuilds just `grid-web`); deploy.yml pins exactly those
services at the new `sha-<commit>` and leaves the rest on their previously
deployed image. `release/**` pushes, version tags and manual runs build and pin
all three images.

- **State + secrets**: [Pulumi Cloud](https://app.pulumi.com). Stack state lives
  there, and the app secrets live in the **ESC environment `grid-oib/<stack>`**,
  imported by the stack file's `environment:` block — not in GitHub and not as
  committed ciphertext. `Pulumi.<stack>.yaml` holds only non-secret config (so
  config changes stay reviewable in the PR diff); after the ESC migration it
  contains no `secure:` blocks.
- **The only GitHub secret** the pipeline needs is `PULUMI_ACCESS_TOKEN`.
- **Gating**: `deploy.yml` triggers on **Publish Images** completing successfully,
  then re-checks that both aggregate gates (`CI OK` **and** `Security OK`) are green
  on the exact commit before it touches the cluster. That re-check is its own
  `gate` job, and it has three outcomes rather than two: green → deploy; a
  **failed** CI/Security run → the gate fails, loudly, because a commit that
  should have shipped did not; a **cancelled** one → the gate passes and the
  deploy is *skipped*, because cancelled means the commit was superseded by a
  newer push (the concurrency group killed its CI) and the newer tip brings its
  own chain. A merge train used to paint that third case red, which is how a
  real deploy failure stops being noticed.

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

### 4. Branch protection (Settings → Branches)
For `develop` and `prod`, require the status checks **`CI OK`** and
**`Security OK`**. This is what makes "only after the whole pipeline passes" real —
without it, removing `continue-on-error` only fails jobs, it doesn't block merges.

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

## Partial deploys (per-service images)

`publish-images.yml` has a "Detect changes" job (dorny/paths-filter) that gates
the three image builds on `develop`: an image rebuilds only when files it
depends on changed (backend / frontend / web filters; blog content lives under
`frontends/web/src/content/**`, inside the web filter, so a blog-post commit
rebuilds only `grid-web`). `release/**` pushes, version tags and manual
`workflow_dispatch` always build all three.

`deploy.yml` pins **per service**
([`resolve-image-refs.sh`](../../deploy/pulumi/scripts/resolve-image-refs.sh)):

- a service the triggering Publish Images run built (its `Build & push <service>
  image` job succeeded) is pinned to the commit's `sha-<40-hex>` tag;
- a service it did **not** build is pinned to the newest commit on develop's
  first-parent line, at or before the deployed one, whose `sha-<commit>` tag
  GHCR actually has (a manifest `HEAD` per commit, up to 200 commits back). A
  commit whose publish failed has no tag and is stepped over. A bare dispatch
  (no `imageTag`) resolves all three this way.

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

The gates are unchanged — CI + Security green, tag-shape validation, preflight,
plan validation and the policy pack all still run for every deploy. Manual
rollback dispatches (operator-supplied `imageTag`) still pin **all three**
services to that tag, after the workflow verifies the tag is published for
every image — see "Rolling back".

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
from a fresh checkout does not know the deployed pins (see "Partial deploys").
Pick a quiet moment instead, or accept the retries.

Gotenberg must be running (`gotenbergEnabled`, default on) before the new
backend takes traffic. With it off, every Word and presentation upload fails.

## Rolling back
Deploys pin every service to an immutable `sha-<40-hex>` image tag, so a
rollback is a deploy of an older tag — not a revert. It is also the only way a
service moves to an older commit: an automatic deploy that resolves one fails
the downgrade guard.

1. Actions → **Deploy (staging)** → *Run workflow*.
2. Set **`imageTag`** to the previous good build's tag (`sha-` + the full commit
   sha; find it in that commit's Publish Images run). A rollback pins **all
   three** services to that tag — the workflow first verifies the tag is
   published for **all three** images, so a rollback to a commit whose Publish
   Images run built only some images fails fast with a clear error instead of
   rolling the others into ImagePullBackOff. Single-tag rollbacks are therefore
   restricted to commits that built all three images; roll back an older
   **partial** state by pinning the exact per-service refs via the stack config
   instead.
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

- **A shallow checkout with `persist-credentials: false` cannot diff a push.**
  `paths-filter` compares against `github.event.before`; that commit is absent
  from a depth-1 clone, so the action falls back to `git fetch` — which has no
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

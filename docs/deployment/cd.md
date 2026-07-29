# Continuous Deployment (Pulumi + GitHub Actions)

Branch-to-environment CD, gated on the full CI pipeline.

```
develop ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  dev  stack ──▶ staging domain
prod    ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  prod stack ──▶ production domain
```

- **State + secrets**: [Pulumi Cloud](https://app.pulumi.com). Stack state lives
  there, and the app secrets live in the **ESC environment `grid-oib/<stack>`**,
  imported by the stack file's `environment:` block — not in GitHub and not as
  committed ciphertext. `Pulumi.<stack>.yaml` holds only non-secret config (so
  config changes stay reviewable in the PR diff); after the ESC migration it
  contains no `secure:` blocks.
- **The only GitHub secret** the pipeline needs is `PULUMI_ACCESS_TOKEN`.
- **Gating**: `deploy.yml` triggers on the **CI** workflow completing successfully,
  then re-checks that both aggregate gates (`CI OK` **and** `Security OK`) are green
  on the exact commit before it touches the cluster.

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
same commit the gates validated — the image tag was pinned before the preview,
and the update is recorded in the Pulumi Cloud console's **Activity** tab with
the full diff and logs. The policy pack does not re-run on the apply; the GHA
preview is the policy checkpoint, and drift between gate and apply is the
accepted residual (see
[pulumi-cloud-feature-audit.md](pulumi-cloud-feature-audit.md)).

## Rolling back
Deploys are pinned to an immutable `sha-<40-hex>` image tag, so a rollback is a
deploy of an older tag — not a revert:

1. Actions → **Deploy (staging)** → *Run workflow*.
2. Set **`imageTag`** to the previous good build's tag (`sha-` + the full commit
   sha; find it in that commit's Publish Images run).
3. It goes through the identical gates and the identical gated rollout — surge,
   readiness soak, drain. Nothing special-cases a rollback.

For a change to the deployment *program* itself (not just the image), check out
the previous commit and `pulumi up` from there. `pulumi cancel` only abandons an
in-flight update; it does not revert one.

Note that `protectDataResources` (default true on prod) makes Pulumi refuse to
delete or replace the Postgres cluster and the storage StatefulSets, so a
rollback can never quietly take the data tier with it.

## Day-to-day
- Merge to `develop` → staging deploys automatically once green.
- Fast-forward/merge `develop` → `prod` → production deploys after approval.
- Roll back: see above.

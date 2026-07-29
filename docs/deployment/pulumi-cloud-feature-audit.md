# Pulumi Cloud feature audit — what we use, what we should use

Date: 2026-07-29 · Plan: **Individual** (org `matthiasbigl`, $0) · Sources: pulumi.com/docs + /pricing as of this date

## What we use today

| Surface | Our usage |
|---|---|
| **Stacks** | Two stacks (`dev`, `prod`) on the Pulumi Cloud backend: state storage, update history, and the stack-level secrets encryption key. Config is **file-based for plaintext, ESC-based for secrets**: `deploy/pulumi/Pulumi.<stack>.yaml` is committed (non-secret values + an `environment:` import) and CI deploys from the checked-out file. |
| **CI/CD** | Our own GitHub Actions workflow (`.github/workflows/deploy.yml`): typecheck → CrossGuard policy pack + CRD schema validation on the plan → the apply delegated to **Pulumi Deployments** via `pulumi up --remote`. Auth is a **long-lived `PULUMI_ACCESS_TOKEN`** repo secret (OIDC issuer evaluated and declined, 2026-07-29). |
| **CrossGuard** | Policy pack in `deploy/pulumi/policy`, run **client-side** in CI (`--policy-pack ./policy`), not org-managed. |
| **Environments (ESC)** | `grid-oib/dev` holds the dev stack's secrets (adopted 2026-07-29, see below). |
| **Deployments** | Saved deployment settings on `dev` (GitHub source, branch `develop`, folder `deploy/pulumi`, push-to-deploy off); applies are triggered from GHA with `pulumi up --remote` and from the console via Click-to-Deploy. |
| **Resources / Insights** | Whatever the stack state shows by default; no Discovery accounts, no saved searches. |

Why the other tabs were empty before 2026-07-29: **Environments** lists only ESC environments (we never created one); **Deployments** lists only stacks with *deployment settings* configured (we deployed from GHA, so nothing registered); **Resources** populates from stack state plus Insights Discovery accounts (we have the former, not the latter).

## What each unused surface is

- **ESC (Environments, Secrets, Configuration).** Central YAML-defined environments holding config + secrets, composable via imports, versioned, with an SDK/`pulumi env run` for injecting values into any command. A stack imports environments via an `environment:` block in `Pulumi.<stack>.yaml`; the env's `pulumiConfig:` section surfaces as ordinary stack config (secrets arrive encrypted, exactly like `pulumi config set --secret`). Explicit stack-file values win over env values on conflict.
- **Pulumi Deployments.** Managed runners that execute `up/preview/refresh/destroy` on Pulumi-hosted (or self-hosted) compute, triggered by git push, Click-to-Deploy in the console, REST API, schedules, or webhooks. Per-stack *deployment settings* define source repo/branch/path, pre-run commands, env vars, and credentials (via ESC/OIDC). This is what fills the Deployments tab.
- **Insights / Resources.** Resource Search over everything Pulumi knows (IaC state + Discovery scans) with a query syntax and AI assist; Discovery scans AWS/Azure/GCP/OCI accounts for **unmanaged** resources and can import them into IaC.
- **OIDC Issuers.** Pulumi Cloud accepts an external OIDC id_token (GitHub Actions, GitLab, EKS, GKE) and exchanges it for a short-lived Pulumi access token — eliminating stored long-lived tokens. On Individual, only the `personal` token type is issuable (sufficient for a single-user org).
- **Deployments OIDC (outbound).** The reverse direction: Pulumi-issued OIDC tokens exchanged for AWS/Azure/GCP credentials during a deployment. **Not applicable to us** — our only credential is a kubeconfig for a managed k0s provider; there is no cloud IAM to federate with.
- **Neo.** Pulumi's AI assistant in the console/CLI (infrastructure Q&A, generate/fix programs).

## Plan gating that matters (Individual, $0)

| Feature | Individual? | Notes |
|---|---|---|
| Stacks, state, unlimited updates/history | ✅ | what we use |
| ESC environments | ✅ | unlimited environments, **max 25 secrets**, 10K open-API calls/mo free |
| OIDC Issuers (inbound, GitHub→Pulumi) | ✅ | `personal` token type only |
| Pulumi Deployments | ✅ | **500 workflow minutes/month** shared with Insights |
| Neo | ✅ | 5M tokens/mo (console assistant); PR reviews are Team+ |
| Resource search / Discovery | ⚠️ partial | 1 Discovery "primary account"; full search is listed as a Team feature |
| Webhooks, org access tokens, org-managed policy packs | ❌ Team ($40/mo) | |
| Drift detection, TTL stacks, Review Stacks, scheduled deployments, audit logs | ❌ Enterprise ($400/mo) | |

## Decisions taken (2026-07-29)

### 1. OIDC Issuer for GitHub Actions — declined

Owner decision: keep the long-lived `PULUMI_ACCESS_TOKEN` repo secret for now.
It still authenticates the GHA gate previews and the remote apply. Revisit if
rotation pain shows up.

### 2. ESC for the stack secrets — adopted (secrets only)

Secrets move out of the committed `Pulumi.dev.yaml` into the ESC environment
**`grid-oib/dev`**, imported via the stack file's `environment:` block;
non-secret config stays in the repo file so config changes remain reviewable
in PR diffs (explicit stack-file values win over env values on conflict).
Migration is one command, encrypted end-to-end:

```bash
cd deploy/pulumi
pulumi config env init --stack dev --keep-config   # creates grid-oib/dev, moves all config
# then delete the now-duplicated `secure:` blocks from Pulumi.dev.yaml and commit
pulumi preview --stack dev                          # expect a no-op plan
```

14 secrets fit the 25-secret Individual cap. When `prod` gets real secrets,
give it its own `grid-oib/prod` environment and factor the ~4 values that are
genuinely identical across stacks into a shared `grid-oib/common` import to
stay under the cap (14 + 14 would exceed it).

### 3. Pulumi Deployments — adopted as the apply executor

The compromise that keeps our gates: **GHA plans + gates, Pulumi Deployments
applies.** `deploy.yml` is unchanged through typecheck, CRD-schema validation,
and the CrossGuard preview; the apply step is
`pulumi up --remote --remote-inherit-settings --remote-git-commit <gated sha>`,
which runs the update on Pulumi's managed runner for the exact commit the
gates validated and is recorded in the console's **Deployments** tab with live
logs. The immutable image tag travels via `--remote-env GRID_IMAGE_TAG=…` plus
a `--remote-pre-run-command` that `pulumi config set`s it (console
Click-to-Deploy runs fall back to `sha-<HEAD>` of the checkout, so the manual
path stays self-consistent). The `--remote*` flags are experimental: the CLI
only registers them with `PULUMI_EXPERIMENTAL=true` set (the workflow's apply
step exports it).

Prerequisite (one-time, console): stack `dev` → Settings → Deploy — GitHub
source `GRID-check/grid-oib-agent`, branch `develop`, Pulumi.yaml folder
`deploy/pulumi`, **push-to-deploy OFF** (GHA orchestrates; Click-to-Deploy
stays available).

Accepted residuals:

- The CrossGuard pack no longer re-runs on the apply plan itself (Pulumi's
  runner executes a plain `up`); the GHA preview is the policy checkpoint.
  Between gate and apply, only operator-side cluster drift could alter the
  plan — `--remote-git-commit` removes any code drift.
- Deploys consume the 500 free workflow minutes/month (ours take several
  minutes each; ample headroom today).
- The job-summary resource diff (`pulumi/actions` `comment-on-summary`) is
  gone; the diff lives in the deployment's console logs instead.

### 4. Insights Discovery — not applicable

Discovery scans AWS/Azure/GCP/OCI accounts. Our estate is one managed k0s cluster plus in-cluster services; there is no cloud account to scan. The Resources tab already shows our IaC resources from stack state — that is all we get here on Individual, and it is enough.

### 5. Enterprise features — note and move on

Drift detection + remediation, TTL stacks, Review Stacks (per-PR ephemeral environments), scheduled deployments, and audit logs are Enterprise ($400/mo). Review Stacks would be genuinely nice for PR previews of this stack; not worth the tier alone. No action.

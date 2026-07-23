# Continuous Deployment (Pulumi + GitHub Actions)

Branch-to-environment CD, gated on the full CI pipeline.

```
develop ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  dev  stack ──▶ staging domain
prod    ──(CI OK + Security OK)──▶ deploy.yml ──▶ pulumi up  prod stack ──▶ production domain
```

- **State + secrets**: [Pulumi Cloud](https://app.pulumi.com). Stack state and every
  `--secret` config value are encrypted there; the app secrets live **in the stack
  config** (committed encrypted in `Pulumi.<stack>.yaml`), not in GitHub.
- **The only GitHub secret** the pipeline needs is `PULUMI_ACCESS_TOKEN`.
- **Gating**: `deploy.yml` triggers on the **CI** workflow completing successfully,
  then re-checks that both aggregate gates (`CI OK` **and** `Security OK`) are green
  on the exact commit before it touches the cluster.

## One-time setup

### 1. Pulumi Cloud
```bash
cd deploy/pulumi
pulumi login                     # Pulumi Cloud
pulumi stack init grid-check/dev
pulumi stack init grid-check/prod
```
Create a Pulumi **access token** (Pulumi Cloud → Settings → Access Tokens).

### 2. Populate each stack's config
Edit the non-secret placeholders in `Pulumi.dev.yaml` / `Pulumi.prod.yaml`
(`storageClass`, `appDomain`, `s3Domain`, `letsEncryptEmail`, `workosClientId`),
then set the secrets once per stack (they encrypt into the committed file):
```bash
pulumi stack select grid-check/dev     # then again for prod
pulumi config set --secret grid-oib:kubeconfig            "$(cat /path/to/kubeconfig)"
pulumi config set --secret grid-oib:pgAppPassword         "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:seaweedfsSecretKey    "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:gridInternalApiToken  "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:gridAdminToken        "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:openrouterApiKey      "sk-or-..."
pulumi config set --secret grid-oib:tavilyApiKey          "tvly-..."
pulumi config set --secret grid-oib:workosApiKey          "sk_..."
pulumi config set --secret grid-oib:workosCookiePassword  "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:jobPayloadKek         "$(openssl rand -base64 32)"
```
Commit the updated `Pulumi.dev.yaml` / `Pulumi.prod.yaml` (secrets are ciphertext).

### 3. GitHub Environments (Settings → Environments)
Create **`develop`** and **`production`**. On each, add the secret
`PULUMI_ACCESS_TOKEN`. On **`production`**, add **required reviewers** so a prod
deploy pauses for manual approval.

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
The `deploy` job runs on Blacksmith/GitHub-hosted runners, so the **cluster API
endpoint must be reachable from them** (public endpoint + credentials in the
kubeconfig is fine). If the API is private, change `runs-on:` in `deploy.yml` to a
**self-hosted runner inside the cluster network** — nothing else changes.

## Day-to-day
- Merge to `develop` → staging deploys automatically once green.
- Fast-forward/merge `develop` → `prod` → production deploys after approval.
- Roll back: `pulumi stack select grid-check/<stack> && pulumi up` on a previous
  commit, or `pulumi cancel` / redeploy.

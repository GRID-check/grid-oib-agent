# Grid OIB — Kubernetes deployment (Pulumi)

TypeScript Pulumi program that deploys the entire Grid OIB stack to a Kubernetes
cluster: the `aiq-agent` backend, the Next.js frontend/BFF, the purger and
workflow-scheduler workers, plus CloudNativePG Postgres, a Dragonfly cache, and
SeaweedFS object storage — behind ingress-nginx with automatic Let's Encrypt TLS.

> Operator walkthrough (prereqs, DNS, day-2, scaling roadmap):
> [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).

## What it creates

| Layer | Resources |
|-------|-----------|
| Platform | namespace `grid`, cert-manager + Let's Encrypt `ClusterIssuer`, ingress-nginx |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`), Dragonfly, SeaweedFS StatefulSet + bucket-init Job |
| App | `aiq-agent` StatefulSet (+ PVC), `frontend` Deployment + HPA, `purger`, `workflow-scheduler`, a one-shot `drizzle-kit migrate` Job |
| Edge | TLS Ingress for the app (`appDomain`) and the public S3 endpoint (`s3Domain`) |

## Prerequisites

- Pulumi CLI + Node 20+.
- A kubeconfig for the target cluster.
- The provider's block **StorageClass** name (Lightbits). Find it with
  `kubectl get storageclass`.
- Images published to a registry (the `publish-images` GitHub Actions workflow
  pushes them to GHCR on merge to `develop`).

## Quick start

```bash
cd deploy/pulumi
npm install
pulumi stack init prod

# Non-secret config is templated in Pulumi.prod.yaml — edit the placeholders
# (storageClass, appDomain, s3Domain, letsEncryptEmail, imageTag, …).

# Secrets (encrypted into the stack):
pulumi config set --secret grid-oib:kubeconfig           "$(cat ~/.kube/grid-config)"
pulumi config set --secret grid-oib:pgAppPassword        "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:seaweedfsSecretKey   "$(openssl rand -base64 24)"
pulumi config set --secret grid-oib:gridInternalApiToken "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:gridAdminToken       "$(openssl rand -hex 32)"
pulumi config set --secret grid-oib:openrouterApiKey     "sk-or-..."
pulumi config set --secret grid-oib:tavilyApiKey         "tvly-..."
pulumi config set --secret grid-oib:workosApiKey         "sk_live_..."
pulumi config set --secret grid-oib:workosCookiePassword "$(openssl rand -hex 32)"

pulumi preview
pulumi up
```

Then point DNS for `appDomain` and `s3Domain` at the ingress-nginx external IP
(`kubectl -n ingress-nginx get svc`), and once TLS issues, flip
`useStagingIssuer` to `false` and `pulumi up` again.

## Configuration

All keys live under the `grid-oib:` namespace. Non-secret keys have sensible
defaults (see `src/config.ts`); the required ones are `storageClass`,
`appDomain`, `s3Domain`, `letsEncryptEmail`, and the secrets above. The agent's
vertical-scaling knobs (`backendRequestsCpu/Memory`, `backendLimits*`,
`backendDaskWorkers`, `backendDaskThreads`, `backendMaxActiveJobs*`) are the
primary way to give the agent more capacity today.

## Layout

```
index.ts                 wiring + stack outputs
src/config.ts            typed config (every knob + secret)
src/platform/            provider, namespace, cert-manager, ingress-nginx
src/data/                postgres (CNPG), dragonfly, seaweedfs
src/app/                 config (Secret + env), migrations Job, backend,
                         frontend (+HPA), workers, ingress
```

## Notes

- **State-safe secrets:** every secret is a `pulumi.Output` sourced from
  `--secret` config, so it stays encrypted in state and is only materialised
  inside the `grid-secrets` Kubernetes Secret.
- **Migrations** run once in a Job (not per frontend pod) so replicas never race.
- **SeaweedFS** is intentionally the proven single-node topology on a durable
  PVC; the scale-out path is documented in the operator guide.

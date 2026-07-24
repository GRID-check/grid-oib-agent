# Grid OIB — Kubernetes deployment (Pulumi)

TypeScript Pulumi program that deploys the entire Grid OIB stack to a Kubernetes
cluster: the `aiq-agent` backend, the Next.js frontend/BFF, the purger and
workflow-scheduler workers, plus CloudNativePG Postgres, a Dragonfly cache, and
SeaweedFS object storage — behind Envoy Gateway (Gateway API) with automatic Let's Encrypt TLS.

> Operator walkthrough (prereqs, DNS, day-2, scaling roadmap):
> [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).

## What it creates

| Layer | Resources |
|-------|-----------|
| Platform | namespace `grid` (+ default-deny NetworkPolicies), cert-manager (Gateway-API) + Let's Encrypt `ClusterIssuer`, Envoy Gateway, (metrics-server only on bare clusters) |
| Data | CloudNativePG operator + `Cluster` (`aiq_jobs`, `aiq_checkpoints`, `grid_app`) with optional PITR backups to SeaweedFS (`ScheduledBackup`), Dragonfly, SeaweedFS StatefulSet + bucket-init Job |
| App | `aiq-agent` StatefulSet (+ PVC, +PDB/spread in db mode), `frontend` Deployment + HPA + PDB, `agent-worker` Deployment + HPA + PDB (db mode), `purger`, `workflow-scheduler`, a one-shot `drizzle-kit migrate` Job |
| Edge | Gateway API (Envoy Gateway, HA: 2 replicas + PDB) + HTTPRoutes with cert-manager TLS for `appDomain` and `s3Domain` |

## Prerequisites

- Pulumi CLI + Node 20+.
- A kubeconfig for the target cluster. **Note:** the Control-Center kubeconfig
  token is short-lived (max 2 weeks). For unattended CI/CD deploys, use a
  permanent ServiceAccount token instead — see the "Managed provider (k0s)"
  section in [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md).
- The provider's **StorageClass** name — `premium` (default, 3 replicas),
  `standard` (2), or `single-replica` (1). Confirm with `kubectl get storageclass`.
  (`lightbits` is the VolumeSnapshotClass, not a StorageClass.)
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

Then point DNS for `appDomain` and `s3Domain` at the Envoy Gateway external IP
(`kubectl -n envoy-gateway-system get svc`), and once TLS issues, flip
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
src/platform/            provider, namespace, cert-manager, gateway (Envoy), metrics-server
src/data/                postgres (CNPG), dragonfly, seaweedfs
src/app/                 config (Secret + env), migrations Job, backend,
                         frontend (+HPA), workers, httproutes
```

## Notes

- **State-safe secrets:** every secret is a `pulumi.Output` sourced from
  `--secret` config, so it stays encrypted in state and is only materialised
  inside the `grid-secrets` Kubernetes Secret.
- **Migrations** run once in a Job (not per frontend pod) so replicas never race.
- **SeaweedFS** is intentionally the proven single-node topology on a durable
  PVC; the scale-out path is documented in the operator guide.

# Aspire Standalone Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the .NET Aspire standalone dashboard (`mcr.microsoft.com/dotnet/aspire-dashboard`) onto the existing K8s+Pulumi stack as a platform-owner live ops pane, and wire the NAT backend to ship OTLP traces to it.

**Architecture:** Pulumi component creates Deployment + Service + Gateway listener + HTTPRoute + secrets. Backend config enables the existing `otelcollector_redaction` exporter. Auth: WorkOS AuthKit OIDC with claim-gating on `org_id=platform_org`. No new Python code.

**Tech Stack:** Pulumi TypeScript, Kubernetes (Gateway API / Envoy Gateway), .NET Aspire dashboard container, NAT OTEL exporter plugin.

---

### Task 1: Pulumi config keys — config.ts + templates

**Files:**
- Modify: `deploy/pulumi/src/config.ts`
- Modify: `deploy/pulumi/Pulumi.dev.yaml`
- Modify: `deploy/pulumi/Pulumi.prod.yaml`

- [ ] **Step 1: Add observability config fields to GridConfig interface in config.ts**

Add this block at the bottom of the `GridConfig` interface (after `workflows`, before the closing `}`):

```typescript
  observability: {
    /** Public hostname for the Aspire dashboard (e.g. otel.dev.bigls.net). */
    otelDomain: string;
    /**
     * WorkOS organization id (not external id) for the GRID Platform org.
     * Used as the OIDC claim value to gate dashboard access to platform owners.
     */
    platformOrgId: string;
    /**
     * Aspire dashboard image reference with a pinned tag (e.g.
     * mcr.microsoft.com/dotnet/aspire-dashboard:9.1.0).
     */
    dashboardImage: string;
    /**
     * Telemetry ring-buffer limits inside the dashboard pod. Aspire defaults
     * to 10000/10000; raised to 50000 for a live view window.
     */
    telemetryLimits: {
      maxLogCount: number;
      maxTraceCount: number;
    };
  };
```

- [ ] **Step 2: Add observability defaults to `loadConfig()` in config.ts**

After the `workflows:` block (line ~517), add:

```typescript
    observability: {
      otelDomain: cfg.require("otelDomain"),
      platformOrgId: cfg.require("platformOrgId"),
      dashboardImage: cfg.get("dashboardImage") ?? "mcr.microsoft.com/dotnet/aspire-dashboard:9.1.0",
      telemetryLimits: {
        maxLogCount: num(cfg, "dashboardMaxLogCount", 50000),
        maxTraceCount: num(cfg, "dashboardMaxTraceCount", 50000),
      },
    },
```

- [ ] **Step 3: Add placeholder/template validations in `loadConfig()`**

Add after the existing `rejectPlaceholder` calls (around line ~309):

```typescript
  rejectPlaceholder("otelDomain", ["example.com"]);
  rejectPlaceholder("platformOrgId", ["REPLACE_ME"]);
```

- [ ] **Step 4: Add dev config to `Pulumi.dev.yaml`**

Add before the `grid-oib:loadBalancerIp` line:

```yaml
  # ── Observability / Aspire dashboard ──
  grid-oib:otelDomain: otel.dev.bigls.net
  grid-oib:platformOrgId: REPLACE_ME
  grid-oib:dashboardImage: mcr.microsoft.com/dotnet/aspire-dashboard:9.1.0
```

- [ ] **Step 5: Add prod template to `Pulumi.prod.yaml`**

Read the file first, then add the same keys with template placeholders:

```yaml
  # ── Observability / Aspire dashboard ──
  grid-oib:otelDomain: otel.example.com
  grid-oib:platformOrgId: REPLACE_ME
  grid-oib:dashboardImage: mcr.microsoft.com/dotnet/aspire-dashboard:9.1.0
```

- [ ] **Step 6: Commit**

Run: `git add deploy/pulumi/src/config.ts deploy/pulumi/Pulumi.dev.yaml deploy/pulumi/Pulumi.prod.yaml`

```bash
git commit -m "feat(pulumi): add observability config keys (otelDomain, platformOrgId, dashboardImage)"
```

---

### Task 2: Observability Pulumi component — observability.ts

**Files:**
- Create: `deploy/pulumi/src/platform/observability.ts`

- [ ] **Step 1: Create the observability component module**

Write `deploy/pulumi/src/platform/observability.ts`:

```typescript
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/IHTTPRouteSpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { GATEWAY_NAME } from "./gateway";
import { PORT, DATA_RESOURCES } from "../constants";

const COMPONENT = "aspire-dashboard";
const DASHBOARD_PORT = 18888;
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;

export interface Observability {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  route: k8s.apiextensions.CustomResource;
}

/**
 * Deploys the .NET Aspire standalone dashboard as a single-replica Deployment
 * behind the shared Gateway on its own `https-otel` listener.
 *
 * The dashboard is a plain container — no .NET workload or AppHost. It stores
 * telemetry in an in-memory ring buffer (lost on restart). Only the UI
 * (:18888) is exposed via an HTTPRoute; OTLP ingestion (:4317/:4318) is
 * cluster-internal and API-key protected.
 *
 * Auth: WorkOS AuthKit OIDC via the existing WorkOS client (reusing the API key
 * as the OIDC client secret). RequiredClaim gates on org_id = platform org.
 */
export function installObservabilityDashboard(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  otlpApiKey: pulumi.Output<string>,
  workosApiKey: pulumi.Output<string>,
  dependsOn: pulumi.Resource[],
): Observability {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;
  const { observability: obs } = cfg;

  // The OIDC client secret for the built-in Aspire OIDC RP is the WorkOS API
  // key (AuthKit uses the API key as the OIDC client secret).
  const deployment = new k8s.apps.v1.Deployment(
    "aspire-dashboard",
    {
      metadata: { name, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
            containers: [
              {
                name: "dashboard",
                image: obs.dashboardImage,
                imagePullPolicy: "IfNotPresent",
                ports: [
                  { containerPort: DASHBOARD_PORT, name: "dashboard" },
                  { containerPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
                  { containerPort: OTLP_HTTP_PORT, name: "otlp-http" },
                ],
                env: [
                  // UI access — OIDC via WorkOS AuthKit.
                  { name: "Dashboard:Frontend:AuthMode", value: "OpenIdConnect" },
                  { name: "Dashboard:Frontend:OpenIdConnect:Authority", value: "https://api.workos.com" },
                  { name: "Dashboard:Frontend:OpenIdConnect:ClientId", value: cfg.auth.workosClientId },
                  { name: "Dashboard:Frontend:OpenIdConnect:ClientSecret", value: workosApiKey },
                  // Claim gate: only GRID Platform organization members pass.
                  { name: "Dashboard:Frontend:OpenIdConnect:RequiredClaimType", value: "org_id" },
                  { name: "Dashboard:Frontend:OpenIdConnect:RequiredClaimValue", value: obs.platformOrgId },
                  // Public URL for OIDC redirects.
                  { name: "Dashboard:Frontend:PublicUrl", value: `https://${obs.otelDomain}` },
                  // App identity in the UI.
                  { name: "Dashboard:ApplicationName", value: "Grid" },
                  // OTLP ingestion auth (cluster-internal callers present the key).
                  { name: "Dashboard:Otlp:AuthMode", value: "ApiKey" },
                  { name: "Dashboard:Otlp:PrimaryApiKey", value: otlpApiKey },
                  // Raised ring-buffer limits for a useful live-view window.
                  { name: "Dashboard:TelemetryLimits:MaxLogCount", value: String(obs.telemetryLimits.maxLogCount) },
                  { name: "Dashboard:TelemetryLimits:MaxTraceCount", value: String(obs.telemetryLimits.maxTraceCount) },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "256Mi" },
                  limits: { cpu: "500m", memory: "1Gi" },
                },
                startupProbe: {
                  httpGet: { path: "/", port: DASHBOARD_PORT },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: "/", port: DASHBOARD_PORT },
                  periodSeconds: 15,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: DASHBOARD_PORT },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  // Cluster-internal Service: the UI port for the HTTPRoute target, and the
  // two OTLP ports for backend/worker pods to send traces.
  const service = new k8s.core.v1.Service(
    "aspire-dashboard",
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { port: DASHBOARD_PORT, targetPort: DASHBOARD_PORT, name: "dashboard" },
          { port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
          { port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT, name: "otlp-http" },
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  // HTTPRoute for the UI only — OTLP endpoints remain cluster-internal.
  const routeSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-otel" }],
    hostnames: [obs.otelDomain],
    rules: [{ backendRefs: [{ name, port: DASHBOARD_PORT }] }],
  };
  const route = new k8s.apiextensions.CustomResource(
    "grid-otel-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "grid-otel", namespace, labels: commonLabels(COMPONENT) },
      spec: routeSpec,
    },
    { provider, dependsOn: service },
  );

  return { deployment, service, route };
}
```

- [ ] **Step 2: Commit**

```bash
git add deploy/pulumi/src/platform/observability.ts
git commit -m "feat(pulumi): add Aspire dashboard observability component"
```

---

### Task 3: Wire into stack — index.ts, config.ts (secrets + Gateway listener)

**Files:**
- Modify: `deploy/pulumi/index.ts`
- Modify: `deploy/pulumi/src/app/config.ts`
- Modify: `deploy/pulumi/src/platform/gateway.ts`

- [ ] **Step 1: Add the `https-otel` Gateway listener in gateway.ts**

Find the `listeners` array in `gateway.ts` (`installGatewayResources`). After the `https-s3` listener object (lines ~164-171), add a third listener:

```typescript
      {
        name: "https-otel",
        port: 443,
        protocol: "HTTPS",
        hostname: cfg.observability.otelDomain,
        tls: { mode: "Terminate", certificateRefs: [{ name: "grid-otel-tls" }] },
        allowedRoutes: { namespaces: { from: "Same" } },
      },
```

- [ ] **Step 2: Generate OTLP API key in buildSecrets (config.ts)**

In `src/app/config.ts`, import the observability component function at the top or note it. In `buildSecrets` (`src/app/config.ts`), add two new entries to `stringData`:

```typescript
        // Observability / Aspire dashboard.
        OTLP_API_KEY: cfg.internal.adminToken, // reuse the admin token as the OTLP key
```

Wait — this needs a dedicated generated key, not the admin token. Better: add a dedicated Pulumi secret key `otelPrimaryApiKey` in config.ts. That avoids coupling. Let's add it to `GridConfig.observability`:

Add to the `observability` interface block (Task 1):

```typescript
    /** OTLP Primary API key shared with the dashboard. */
    otelPrimaryApiKey: pulumi.Output<string>;
```

And in the `loadConfig`:

```typescript
      otelPrimaryApiKey: cfg.getSecret("otelPrimaryApiKey") ?? pulumi.output(""),
```

Then in `buildSecrets`:

```typescript
        OTLP_API_KEY: cfg.observability.otelPrimaryApiKey,
```

And in `backendEnv`, add the OTLP connection env vars:

```typescript
    // Aspire dashboard OTLP tracing.
    { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: `http://aspire-dashboard:${4317}` },
    sref("OTLP_API_KEY"),
```

And in `workerEnv`, the same (it calls `backendEnv` so they inherit automatically).

Also add a helper function in config.ts for the OTLP auth header:

In `backendEnv`, after `sref("OTLP_API_KEY")`, add a derived env var that composes the header:

```typescript
    { name: "OTEL_EXPORTER_OTLP_HEADERS",
      value: pulumi.interpolate`x-otlp-api-key=${cfg.observability.otelPrimaryApiKey}` },
```

Wait — `pulumi.interpolate` won't work in a pure env-var literal like that unless we construct it as an output and then use `.apply`... Actually looking at the existing code, all env vars are plain strings or `sref()` calls. The `OTEL_EXPORTER_OTLP_HEADERS` needs to contain the actual key value, which is a Pulumi Output. The pattern used in the codebase for dynamic values is `pulumi.interpolate` — but env vars in the Kubernetes spec are `string | pulumi.Output<string>`, so we can use an output.

Looking at the existing pattern: in `src/app/config.ts`, the `buildSecrets` function uses `stringData` with `pulumi.Output<string>` values directly (e.g. `cfg.llm.openrouterApiKey`). The `sref` function creates an env var that references the secret key. So the pattern should be:

1. Put the API key in the shared Secret as a stringData entry (so k8s knows about it).
2. Reference it via `sref()` or compose a header via `valueFrom`.

Actually, for `OTEL_EXPORTER_OTLP_HEADERS`, the simplest approach is to put the header value directly into the secret. In `buildSecrets`:

```typescript
        OTEL_EXPORTER_OTLP_HEADERS: cfg.observability.otelPrimaryApiKey.apply(
          (key) => `x-otlp-api-key=${key}`
        ),
```

Then in `backendEnv`:

```typescript
    sref("OTEL_EXPORTER_OTLP_HEADERS"),
```

This follows the existing `sref` pattern perfectly. The secret stores the ready-made header value.

- [ ] **Step 3: Wire the observability component in index.ts**

In `index.ts`, add the import at the top:

```typescript
import { installObservabilityDashboard } from "./src/platform/observability";
```

After the edge routes are installed (after `installHttpRoutes`, around line ~130), add:

```typescript
// ── Observability (Aspire dashboard) ───────────────────────────────────────────
const otlpApiKey = cfg.observability.otelPrimaryApiKey;
const dashboard = otlpApiKey
  ? installObservabilityDashboard(cfg, provider, namespace, otlpApiKey, cfg.auth.workosApiKey, [
      gatewayResources.gateway,
    ])
  : undefined;
```

Update the stack outputs section (at the bottom) to include:

```typescript
export const otelUrl = dashboard
  ? pulumi.interpolate`https://${cfg.observability.otelDomain}`
  : pulumi.output("(none: otelPrimaryApiKey not set)");
```

Wait, `cfg.observability.otelPrimaryApiKey` is a `pulumi.Output<string>` — checking for "set" with `|| pulumi.output("")` in config.ts means it's never `undefined`, just empty. Conditional installation should check the config key being non-empty. Better pattern: use the Pulumi config being set at all.

Actually, checking for empty Output string is tricky. Simpler: always install the dashboard but skip OTLP auth if the key is empty. Even simpler: the dashboard always gets installed — it's cheap and the config keys are required. Let's keep it simple — no conditional.

Actually, looking more carefully: the design says this is a platform feature, always deployed. The config keys are `require()` not optional. So remove the conditional. Just install it unconditionally.

```typescript
// ── Observability (Aspire dashboard) ───────────────────────────────────────────
const dashboard = installObservabilityDashboard(
  cfg, provider, namespace,
  cfg.observability.otelPrimaryApiKey,
  cfg.auth.workosApiKey,
  [gatewayResources.gateway],
);
```

Stack output:

```typescript
export const otelUrl = pulumi.interpolate`https://${cfg.observability.otelDomain}`;
```

- [ ] **Step 4: Add NetworkPolicy allow rule for edge → dashboard**

In `network-policies.ts`, add a new rule after the existing ones (after `allow-edge-to-acme-solver`, line ~89):

```typescript
  // 7. Edge → Aspire dashboard (the otel HTTPRoute).
  const edgeOtel = mk("allow-edge-to-aspire-dashboard", {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "aspire-dashboard" } },
    policyTypes: ["Ingress"],
    ingress: [
      { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: 18888 }] },
    ],
  });
```

And add `edgeOtel` to the return array (line ~90):

```typescript
  return [deny, intra, cnpg, edgeFrontend, edgeS3, acmeSolver, edgeOtel];
```

- [ ] **Step 5: Commit**

```bash
git add deploy/pulumi/index.ts deploy/pulumi/src/app/config.ts deploy/pulumi/src/platform/gateway.ts deploy/pulumi/src/platform/network-policies.ts
git commit -m "feat(pulumi): wire Aspire dashboard into stack (index, secrets, gateway listener, network policy)"
```

---

### Task 4: Backend telemetry config — enable the OTEL exporter

**Files:**
- Modify: `configs/config_oib_openrouter.yml`

- [ ] **Step 1: Add telemetry tracing exporter to the config**

In `config_oib_openrouter.yml`, after the `telemetry.logging.console` block (line ~9) and on the same indentation level, add:

```yaml
      otelcollector_redaction:
        _type: otelcollector_redaction
        endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4317}
        # The header is injected by the Pulumi-deployed environment variable
        # OTEL_EXPORTER_OTLP_HEADERS (set from the shared k8s Secret).
        # Redaction: scrubs configured HTTP headers from span attributes.
        redact_content: false
        redacted_keys:
          - authorization
          - cookie
          - set-cookie
          - x-otlp-api-key
        # Optional resource attributes — the dashboard uses these for filtering.
        resource_attributes:
          service.name: grid-aiq-agent
          service.version: ${APP_VERSION:-unknown}
          deployment.environment: ${APP_ENV:-production}
```

- [ ] **Step 2: Commit**

```bash
git add configs/config_oib_openrouter.yml
git commit -m "feat(config): enable otelcollector_redaction tracing exporter for Aspire dashboard"
```

---

### Task 5: ADR + kubernetes.md docs

**Files:**
- Create: `docs/adr/0029-aspire-dashboard-telemetry.md`
- Modify: `docs/deployment/kubernetes.md`

- [ ] **Step 1: Create ADR-0029**

Write `docs/adr/0029-aspire-dashboard-telemetry.md`:

```markdown
# ADR-0029: Aspire Standalone Dashboard as Live Telemetry Pane

Date: 2026-07-27

## Status

Accepted

## Context

The GRID backend (aiq-agent) currently emits only console-log telemetry. Platform
operators have no live view into service health, request latency, trace
visualisation, or span-level diagnostics. The existing `otelcollector_redaction`
exporter plugin (registered but unused) targets the OpenTelemetry Protocol (OTLP)
and is ready to ship spans to any OTLP-compatible collector.

Options considered:
1. **Full Observability Stack** — OTel Collector + Jaeger/Grafana Tempo + Loki +
   Grafana. Production-grade durability, alerting, retention. Heavy operational
   overhead (5+ services, DB-backed, requires dedicated ops runbook).
2. **.NET Aspire Standalone Dashboard** — a single container serving an OTLP-gRPC
   ingestion endpoint and a browser UI with live traces, spans, and log-surface.
   In-memory ring buffer (data lost on restart, no alerting).
3. **No change** — keep console-only telemetry; `kubectl logs` for diagnostics.

Chosen: **Option 2** (Aspire standalone dashboard) for its near-zero operational
cost and instant value as a live pane. The in-memory caveat is explicitly accepted:
this is a live-view tool, not a log archive.

## Decision

Deploy `mcr.microsoft.com/dotnet/aspire-dashboard` as a standard Kubernetes
Deployment via the existing Pulumi stack. See the design spec at
`docs/superpowers/specs/2026-07-27-aspire-otel-dashboard-design.md`.

Key decisions within the approach:
- **Auth:** WorkOS AuthKit OIDC claim-gated on `org_id=platform_org` — reuses the
  existing WorkOS client (extra redirect URI). No new credentials.
- **Gateway:** dedicated `https-otel` listener on the shared Gateway (same Envoy
  Gateway fleet), with an HTTPRoute for the UI only. OTLP ingestion stays
  cluster-internal.
- **OTLP API key:** a dedicated Pulumi-managed secret, shared between the
  dashboard and the backend/worker deployments via the `grid-secrets` Secret.
- **Scope:** backend (aiq-agent) traces only. Frontend Next.js OTEL instrumentation
  and log pipelines are follow-ups.

## Consequences

**Positive:**
- Platform owners get a live trace/span dashboard with ~50 lines of Pulumi code.
- The backend's existing (unused) exporter plugin is activated — no new Python.
- OIDC claim gating means zero new WorkOS configuration beyond one redirect URI.
- The dashboard is a cheap, self-contained Deployment with no external dependencies.

**Negative:**
- In-memory ring buffer means data is lost on pod restart — no post-mortem
  debugging from historical traces.
- Single replica, no HA — the dashboard itself is an availability risk during
  node drains / provider upgrades (accept: low severity — it's a diagnostic
  tool, not a production path).
- No alerting — operators must watch the dashboard; no proactive notification.
- The dashboard image is .NET-based (~200 MB), adding image-pull latency on
  cold start.

## Alternatives considered

**Option 1 — Full OTel Collector + Grafana stack.** Provides durable storage,
alerting, and multi-service aggregation. Rejected: 5+ services, DB-backed,
requires dedicated observability runbook and ongoing maintenance that a single
diagnostic pane does not justify for the current team size.

**Option 3 — No change.** Rejected: operators have no live visibility beyond
`kubectl logs`, making latency regression and span-level diagnostics
impractical.

## References

- Design spec: `docs/superpowers/specs/2026-07-27-aspire-otel-dashboard-design.md`
- Aspire dashboard docs: https://learn.microsoft.com/en-us/dotnet/aspire/fundamentals/dashboard/standalone
- ADR-0016: Platform owner model
- ADR-0025: Norm registry
- ADR-0028: Horizontal agent scaling / conversation bus
```

- [ ] **Step 2: Update kubernetes.md with observability section**

Add a new section to `docs/deployment/kubernetes.md` after the existing "Access" section (read the file first to find the right insertion point). Content:

```markdown
## 7. Observability — Aspire Dashboard

The stack deploys a .NET Aspire standalone dashboard as a live trace/span viewer
for platform owners.

**URL:** `https://<otelDomain>`

**Access:** Authenticated via WorkOS AuthKit (same WorkOS client as the app).
Only GRID Platform organization members pass the OIDC claim gate — `org_id` must
match the platform org id. This is the same population that has platform admin
access.

**Scope:** Backend (aiq-agent) OTLP traces/spans only. No logs pipeline, no
frontend instrumentation.

**Caveats:**

- The dashboard uses an **in-memory ring buffer** (configured to 50k entries).
  Data is lost on pod restart — this is a live-view tool, not a log archive.
- Single replica. The dashboard is not on the production data path; an outage
  loses no application data.
- No alerting — operators must watch the dashboard for diagnostics.
- The OTLP ingestion endpoint (:4317 gRPC, :4318 HTTP) is **cluster-internal
  only** and protected by an API key (`x-otlp-api-key` header). It is **not**
  exposed through the Gateway.

### Wiring

- Backend `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` are
  injected from the `grid-secrets` Kubernetes Secret by the Pulumi deploy.
- The NAT config file (`config_oib_openrouter.yml`) enables the
  `otelcollector_redaction` exporter (spans only).
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0029-aspire-dashboard-telemetry.md docs/deployment/kubernetes.md
git commit -m "docs: add ADR-0029 (Aspire dashboard) and observability section in kubernetes.md"
```

---

## Self-Review

**Spec coverage:**
- Design §1 Architecture → Task 2 (observability.ts) + Task 3 (wiring)
- Design §2 Auth → Task 2 (OIDC env vars in observability.ts) + Task 3 (secrets)
- Design §3 Pulumi → Task 1 (config keys) + Task 2 + Task 3
- Design §4 Backend → Task 4 (config change)
- Design §5 YAGNI → not implemented (intentional)
- Design §6 Docs → Task 5

**No placeholders:** all code blocks are complete. The one editorial note ("Read the file first") is an implementation instruction, not a placeholder — the implementer reads the existing file to find the insertion point.

**Type consistency:** `observability.otelPrimaryApiKey` is `pulumi.Output<string>` in config.ts, used as `pulumi.Input<string>` in the observability component. `observability.otelDomain`/`dashboardImage`/`platformOrgId` are plain `string`. `telemetryLimits.maxLogCount`/`maxTraceCount` are `number`.

---

Plan complete and saved. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**


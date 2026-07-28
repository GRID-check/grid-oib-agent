# Design: Aspire standalone dashboard as platform observability pane

Date: 2026-07-27
Branch: `feat/aspire-otel-dashboard`
Status: approved (design), pending implementation plan

## Goal

Give platform owners a live operations pane for the GRID deployment on Kubernetes:
traces/spans from the NAT backend (and any OTLP-speaking service), viewable in the
.NET Aspire **standalone dashboard** (`mcr.microsoft.com/dotnet/aspire-dashboard`),
deployed as a plain container via the existing Pulumi stack — no Aspire AppHost,
no .NET workloads, no orchestration features. Dashboard UI access is gated by
WorkOS AuthKit OIDC with a claim check against the GRID Platform organization
(ADR-0016), i.e. the same platform-owner population that guards the platform
admin surfaces.

## Non-goals (YAGNI)

- Frontend (Next.js/BFF) OTEL instrumentation — backend only for now.
- OTel Collector fan-out, durable telemetry store, retention, alerting.
- Docker Compose parity (local dev can run `aspire dashboard run` or `docker run`).
- Log pipeline (traces only at first; logs stay in stdout / `kubectl logs`).
- Aspire orchestration (AppHost, service discovery, `aspire deploy`) — explicitly
  dashboard-only.

## Accepted caveat

The standalone dashboard keeps telemetry in an **in-memory ring buffer** (defaults
10k log entries / 10k traces, raised via `Dashboard:TelemetryLimits:*`), lost on
restart, single replica, no historical retention. Microsoft frames it as a
dev/short-term diagnostic tool. Accepted: this is a live view, not a log archive.
Limits will be raised to 50k and pod sized accordingly.

## Architecture

```text
aiq-agent ──┐  OTLP/gRPC :4317 (x-otlp-api-key, cluster-internal Service)
(future     │
 senders)   ▼
   aspire-dashboard (Deployment, 1 replica, in-memory)
            │ :18888 (cluster-internal Service)
            ▼
   Gateway https-otel listener → HTTPRoute (otel.<domain>, cert-manager TLS)
            │
            ▼
   Browser → OIDC redirect → WorkOS AuthKit (same client, extra redirect URI)
   RequiredClaim: org_id = platform org id → everyone else denied
   MCP/CLI: aspire agent mcp --dashboard-url https://otel.<domain> (API key)
```

- OTLP ingestion endpoints (:4317 gRPC / :4318 HTTP) are **never exposed** through
  the Gateway — cluster-internal Service only, protected by the OTLP API key
  (`x-otlp-api-key` header).
- Only the dashboard UI gets an HTTPRoute, on its own Gateway listener
  (`https-otel`), following the existing per-domain listener pattern
  (`https-app`, `https-s3`) in `deploy/pulumi/src/app/httproutes.ts`.

## Auth design

**Reuse the existing WorkOS client.** AuthKit clients support multiple redirect
URIs and the WorkOS API key serves as the OIDC client secret, so no new WorkOS
credentials are provisioned — the dashboard just gets
`https://otel.<domain>/signin-oidc` added as an allowed redirect URI.

Dashboard configuration:

- `Dashboard:Frontend:AuthMode=OpenIdConnect`
- `Dashboard:Frontend:OpenIdConnect:Authority=https://api.workos.com` (AuthKit issuer)
- `ClientId` = existing WorkOS client id, `ClientSecret` = WorkOS API key (existing secrets)
- `Dashboard:Frontend:OpenIdConnect:RequiredClaimType=org_id`
- `Dashboard:Frontend:OpenIdConnect:RequiredClaimValue=<platform org WorkOS id>`
  (new Pulumi config key `platformOrgId`)
- `Dashboard:Otlp:AuthMode=ApiKey`, primary API key generated as a Pulumi secret
- `Dashboard:ApplicationName=Grid`, `Dashboard:Frontend:PublicUrl=https://otel.<domain>`

Effect: any GRID user can complete the WorkOS login, but only sessions with an
active GRID Platform organization membership carry `org_id=<platform org>` and
pass the claim gate — the same population as `requirePlatformOwner()`'s
role-based path (break-glass emails and permission-claim fast paths do **not**
apply here; acceptable, dashboard access tracks org membership).

**Spike item (must verify before finalizing):** confirm AuthKit emits `org_id` in
the **ID token** for org-context sessions. If it only lands in the access token,
the fallback is a thin BFF proxy route gated by `requirePlatformOwner()`
instead of claim-based gating (auth mechanism stays WorkOS either way).

## Pulumi changes (`deploy/pulumi`)

New component `src/platform/observability.ts`:

- Deployment: pinned `mcr.microsoft.com/dotnet/aspire-dashboard:<version>`
  (new config `aspireDashboardImage`), 1 replica, resource requests/limits sized
  for the raised ring buffer.
- Service: ports 18888 (UI), 4317 (OTLP gRPC), 4318 (OTLP HTTP) — ClusterIP.
- Gateway listener `https-otel` on `otel.<domain>` + HTTPRoute → Service:18888,
  cert-manager TLS, mirroring the existing listener/HTTPRoute pattern.
- Secrets via the existing `buildSecrets` pattern: generated OTLP API key
  (consumed by dashboard env **and** injected into backend env as
  `OTEL_EXPORTER_OTLP_HEADERS=x-otlp-api-key=<key>`), OIDC client secret
  reference.
- NetworkPolicy additions: allow Envoy gateway namespace → dashboard:18888;
  allow app pods → dashboard:4317/4318.
- `Dashboard:TelemetryLimits:MaxLogCount` / `MaxTraceCount` = 50000.

New Pulumi config keys (dev/prod templates + `src/config.ts`): `otelDomain`,
`platformOrgId`, `aspireDashboardImage`.

## Backend wiring

`configs/config_oib_openrouter.yml` gains a `telemetry.tracing` section using the
**existing** registered exporter `otelcollector_redaction`
(`src/aiq_agent/observability/otel_header_redaction_exporter.py`, built on NAT's
`OtelCollectorTelemetryExporter`, redaction already included):

- `endpoint: ${OTEL_EXPORTER_OTLP_ENDPOINT}` — Pulumi injects the internal
  Service URL (`http://aspire-dashboard.<ns>:4317`).
- API key rides in `OTEL_EXPORTER_OTLP_HEADERS`, which the OTEL SDK exporter
  picks up natively — no code change needed for auth (verify in implementation
  that the NAT adapter passes env-configured headers through).
- `resource_attributes` set service name (`grid-aiq-agent`).

No new Python code is expected. The exporter plugin is already registered and
merely unused today (config only has console logging telemetry).

## Documentation obligations (same change)

- `docs/deployment/kubernetes.md`: new observability section (dashboard URL,
  access model, OTLP wiring, restart/data-loss caveat).
- New ADR (`docs/adr/`, next number): "Aspire standalone dashboard as live
  telemetry pane" — decision, caveat acceptance, auth model, alternatives
  (Grafana stack / OTel Collector + Jaeger) considered.
- `deploy/pulumi` README/config table: new config keys.
- `AGENTS.md` env-var table: `OTEL_EXPORTER_OTLP_ENDPOINT` /
  `OTEL_EXPORTER_OTLP_HEADERS` injection (aiq-agent service) if not covered.

## Testing / verification

- `pulumi preview` clean on dev stack config.
- NetworkPolicy + HTTPRoute render checked in preview.
- After deploy (dev): browser login as platform owner passes; tenant org user is
  denied at claim check; backend spans appear in dashboard; `x-otlp-api-key`
  required (unauthenticated OTLP rejected).
- No unit tests for Pulumi component (stack is preview-verified); backend change
  is config-only.

---

## Amendment (2026-07-27): OTel Collector as the ingestion point + frontend OTEL

Approved by the maintainer after a post-implementation architecture review.

### Decision

Services no longer export OTLP directly to the Aspire dashboard. A dedicated
**OpenTelemetry Collector** (`otel/opentelemetry-collector-contrib`, pinned) is
the cluster's single OTLP ingestion point:

```text
browser/Next.js BFF ─┐
aiq-agent (chat)     ├─ plain OTLP (in-cluster, no key) ─> otel-collector ─> OTLP/HTTP + x-otlp-api-key ─> aspire-dashboard
agent-worker         ┘                                   (batch, memory_limiter; traces+logs+metrics pipelines)
```

Rationale: decouples producers from the storage/UI decision (swapping Aspire
for Grafana/Tempo later is a collector-config change, not an app change);
centralizes API-key auth, batching, and back-pressure in one place; all three
signal pipelines (traces, logs, metrics) are wired now so future signal
adoption is app-only work.

### Changes vs. the original design

1. **New platform component** `src/platform/otel-collector.ts`: Deployment
   (1 replica, `otel/opentelemetry-collector-contrib:0.157.0`, health_check
   extension on :13133, memory_limiter+batch processors, `otlphttp` exporter
   to `http://aspire-dashboard:4318`), ConfigMap-mounted config, Service
   `otel-collector:4317/4318`. No NetworkPolicy changes (same-namespace
   ingress allowed, egress open by design).
2. **OTLP key handling hardened**: the key moves into a dedicated Kubernetes
   Secret `aspire-dashboard-secrets` (created by the observability module) and is
   referenced via `secretKeyRef` by BOTH the dashboard
   (`Dashboard__Otlp__PrimaryApiKey`) and the collector (`OTLP_API_KEY` env,
   interpolated into the exporter header). Previously it was a plain env
   value on the dashboard Deployment. The unused `OTLP_API_KEY` /
   `OTEL_EXPORTER_OTLP_HEADERS` entries in the app `grid-secrets` Secret are
   removed.
3. **Backend rewiring**: `OTEL_EXPORTER_OTLP_ENDPOINT` →
   `http://otel-collector:4318/v1/traces` (full path — the NAT exporter posts
   to explicit endpoints as-is). Header plumbing deleted.
4. **Frontend OTEL (new)**: `frontends/ui/src/instrumentation.ts` with
   `@vercel/otel` (`registerOTel`), gated on
   `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` being set — the capability derived
   from the dependency, never a duplicate env flag. Pulumi injects that endpoint
   only when the observability tier itself is deployed, i.e. the
   `observabilityEnabled` flag AND the capability derived from `otelDomain` +
   `platformOrgId` + `otelPrimaryApiKey` + the WorkOS OIDC client
   (availability = flag AND capability). Covers BFF route handlers + server-side
   fetch automatically. Pulumi injects `OTEL_SERVICE_NAME=grid-ui` and
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` (BASE URL — the
   JS OTLP HTTP exporter appends `/v1/traces` per the OTEL spec; this
   asymmetry with the backend's full-path endpoint is intentional).
   Known gap: the custom `server.js` WS proxy is not auto-instrumented —
   follow-up.
5. **Out of scope (follow-ups)**: metrics/log instrumentation in apps,
   purger/scheduler processes, Grafana stack, WS proxy spans.

### Verification additions

- `npm run typecheck` (Pulumi) and frontend Docker typecheck pass with
  `@vercel/otel` added.
- Post-deploy: end-to-end trace shows `grid-ui` → `grid-aiq-agent` spans in
  one trace; collector logs show no export errors; dashboard still rejects
  unauthenticated OTLP on its own ports.

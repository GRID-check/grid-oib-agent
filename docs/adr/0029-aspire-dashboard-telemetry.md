# ADR-0029: Aspire Standalone Dashboard as Live Telemetry Pane

Date: 2026-07-27

## Status

Accepted

## Context

The GRID backend (aiq-agent) emitted only console-log telemetry. Platform
operators had no live view into service health, request latency, trace
visualisation, or span-level diagnostics. The existing
`otelcollector_redaction` exporter plugin (`src/aiq_agent/observability/otel_header_redaction_exporter.py`,
registered but previously unused) targets OTLP and is ready to ship spans to
any OTLP-compatible receiver.

Options considered:

1. **Full observability stack** — OTel Collector + Jaeger/Grafana Tempo + Loki +
   Grafana. Production-grade durability, alerting, retention. Heavy operational
   overhead (5+ services, DB-backed, dedicated ops runbook).
2. **.NET Aspire standalone dashboard** — a single container serving OTLP
   ingestion endpoints and a browser UI with live traces, spans, and log
   surface. In-memory ring buffer (data lost on restart, no alerting).
3. **No change** — keep console-only telemetry; `kubectl logs` for diagnostics.

Chosen: **Option 2** for its near-zero operational cost and instant value as a
live pane. The in-memory caveat is explicitly accepted: this is a live-view
tool, not a log archive.

## Decision

Deploy `mcr.microsoft.com/dotnet/aspire-dashboard` as a standard Kubernetes
Deployment via the existing Pulumi stack
(`deploy/pulumi/src/platform/observability.ts`). Design spec:
`docs/superpowers/specs/2026-07-27-aspire-otel-dashboard-design.md`.

Key decisions within the approach:

- **Auth:** WorkOS AuthKit OIDC claim-gated on `org_id = <platform org>` —
  reuses the existing WorkOS client. No new credentials, no BFF proxy, no
  static token.
- **Gateway:** dedicated `https-otel` listener on the shared Envoy Gateway
  with an HTTPRoute for the UI only. OTLP ingestion stays cluster-internal.
- **OTLP API key:** a dedicated Pulumi-managed secret, shared between the
  dashboard (`Dashboard:Otlp:PrimaryApiKey`) and the backend/worker pods via
  the `grid-secrets` Secret (`x-otlp-api-key` header).
- **Scope:** backend (aiq-agent) + agent-worker traces only. The two Python
  tiers share the NAT config and get per-tier `service.name` via
  `OTEL_SERVICE_NAME` (`grid-aiq-agent` / `grid-agent-worker`). Frontend
  Next.js / workflow-scheduler OTEL instrumentation and a log pipeline are
  follow-ups.

## Verified deployment facts

These were established by reading the dashboard configuration reference and
the installed NAT/OTel SDK source — they are NOT obvious from the standalone
dashboard quickstart and cost real debugging time if missed:

1. **Container OTLP ports are 18889/18890, not 4317/4318.** The docs' docker
   example maps host ports (`-p 4317:18889`). Inside the container the
   listeners default to `http://localhost:18889` (gRPC) and
   `http://localhost:18890` (HTTP). We rebind them to the conventional ports
   via `ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL=http://0.0.0.0:4317` and
   `ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL=http://0.0.0.0:4318`.
2. **OIDC RP settings live under `Authentication:Schemes:OpenIdConnect:*`**
   (Authority/ClientId/ClientSecret). The `Dashboard:Frontend:OpenIdConnect:*`
   section only carries the claim gate (`RequiredClaimType/Value`) and display
   claim mappings. Settings placed there are silently ignored.
3. **WorkOS AuthKit's OIDC issuer is per-client:**
   `https://api.workos.com/user_management/<client_id>` — there is NO
   discovery document at the `api.workos.com` root (verified: 404; the
   per-client path serves `.well-known/openid-configuration`).
4. **Behind a TLS-terminating proxy, `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true`
   is required.** Without it the OIDC `redirect_uri` is built as `http://` and
   the callback fails. The Gateway terminates TLS; Envoy forwards
   `X-Forwarded-*`.
5. **The NAT exporter uses OTLP/HTTP and posts to the endpoint as-is.** The
   plugin does not expose the `protocol` knob (default `http`), and the OTel
   SDK only appends `/v1/traces` to env-var-derived endpoints — an endpoint
   the config passes explicitly must include the full path:
   `http://aspire-dashboard:4318/v1/traces`.
6. **The API-key header reaches the exporter via env fallback.** The plugin
   passes `headers=None`, so the OTel SDK reads
   `OTEL_EXPORTER_OTLP_HEADERS` (`x-otlp-api-key=<key>`) from the
   secret-backed env var — that is the only injection path.
7. **`project` is a required field** on NAT's `OtelCollectorTelemetryExporter`
   and becomes `service.name`. The redaction mixin's fields are
   `redaction_enabled`/`redaction_attributes`/`redaction_headers`; there are
   no `redact_content`/`redacted_keys` fields.
8. **Env-var config keys use `__` as the hierarchy delimiter**
   (`Dashboard__Otlp__AuthMode`), per the dashboard docs.

## Consequences

**Positive:**

- Platform owners get a live trace/span dashboard with ~150 lines of Pulumi.
- The backend's existing exporter plugin is activated — no new Python.
- OIDC claim gating means zero new WorkOS configuration beyond one redirect
  URI (`https://<otelDomain>/signin-oidc`, registered in the WorkOS dashboard).
- Chat tier and worker tier appear as distinct resources
  (`grid-aiq-agent` / `grid-agent-worker`).
- The dashboard is a cheap, self-contained Deployment with no external
  dependencies.

**Negative:**

- In-memory ring buffer (50k log/trace entries) — data is lost on pod restart;
  no post-mortem debugging from historical traces.
- Single replica, no HA — the dashboard itself is an availability risk during
  node drains / provider upgrades (accepted: it's a diagnostic tool, not a
  production path).
- No alerting — operators must watch the dashboard.
- Frontend, workflow-scheduler and purger emit no telemetry (Node, no OTEL
  instrumentation) — follow-up if needed.
- The dashboard image is .NET-based (~200 MB), adding image-pull latency on
  cold start.

## Alternatives considered

**Option 1 — Full OTel Collector + Grafana stack.** Durable storage, alerting,
multi-service aggregation. Rejected: 5+ services, DB-backed, dedicated
observability runbook that a single diagnostic pane does not justify at the
current team size. The OTLP boundary means we can add a collector later
without touching app code.

**Option 3 — No change.** Rejected: no live visibility beyond `kubectl logs`.

## References

- Design spec: `docs/superpowers/specs/2026-07-27-aspire-otel-dashboard-design.md`
- Dashboard standalone: https://aspire.dev/dashboard/standalone/
- Dashboard configuration: https://aspire.dev/dashboard/configuration/
- ADR-0016: Platform owner model
- ADR-0028: Horizontal agent scaling / conversation bus

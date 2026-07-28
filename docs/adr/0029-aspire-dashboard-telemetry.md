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
  static token. (Enforced at the Gateway, not inside the dashboard — see
  Amendment 2.)
- **Gateway:** dedicated `https-otel` listener on the shared Envoy Gateway
  with an HTTPRoute for the UI only. OTLP ingestion stays cluster-internal.
- **Ingestion:** an **OpenTelemetry Collector** (`otel-collector` Service) is
  the cluster's single OTLP ingestion point. Producers send plain OTLP
  in-cluster; the collector alone holds the ingestion key and is the only
  client of the dashboard's OTLP ports. See the amendment below.
- **OTLP API key:** a Pulumi-managed value materialised exactly once, in the
  dedicated Kubernetes Secret `aspire-dashboard-secrets` (keys `otlp-api-key`,
  `client-secret`), referenced via `secretKeyRef` by the dashboard
  (`Dashboard:Otlp:PrimaryApiKey`) and the collector's exporter header, and by
  the Gateway SecurityPolicy for the OIDC client secret (that key name is fixed
  by the SecurityPolicy API). Nothing sensitive appears as a plain env value on
  a pod spec.
- **Scope:** traces from all three app tiers — Next.js BFF (`grid-ui`),
  aiq-agent (`grid-aiq-agent`), and agent-worker (`grid-agent-worker`). The
  collector carries traces+logs+metrics pipelines so future signal adoption
  is app-only work. Metrics/log instrumentation, purger/scheduler, and the
  `server.js` WS proxy are follow-ups.

## Amendment (2026-07-27): OTel Collector as ingestion point + frontend OTEL

Added after a post-implementation architecture review, before first deploy.

**Problem with the initial cut:** services exported OTLP directly to the
dashboard — the API key was plumbed into every producer, and the storage/UI
decision was baked into app config. The Aspire dashboard is a live ops pane,
not a production observability backend (ring buffer, no retention/alerting).

**Change:** a dedicated `otel/opentelemetry-collector-contrib` Deployment
(`deploy/pulumi/src/platform/otel-collector.ts`) receives OTLP gRPC+HTTP from
all producers and exports via `otlphttp` to the dashboard with the
`x-otlp-api-key` header. Processors: `memory_limiter` + `batch`; the
`health_check` extension backs the probes. Pipelines for **traces, logs, and
metrics** are all wired now.

**Why this is the right long-term shape:**

- Producers are decoupled from the backend choice — swapping Aspire for a
  Grafana/Tempo stack later is a collector-config change, not an app change.
- API-key auth, batching, and back-pressure live in exactly one place.
- The frontend gap is closed: `frontends/ui/src/instrumentation.ts` registers
  `@vercel/otel`, gated on `OTEL_EXPORTER_OTLP_ENDPOINT` being set — the
  capability derived from the dependency, never a second env flag. Pulumi
  injects that endpoint only when the tier itself is enabled, so the whole
  feature follows the house rule **availability = flag AND capability**: the
  `observabilityEnabled` flag is the product decision, and the capability is
  derived from `otelDomain` + `platformOrgId` + `otelPrimaryApiKey` + the
  WorkOS OIDC client. Missing any of them skips the collector, the dashboard,
  the `https-otel` listener, and the producers' OTLP env (with a `preview`
  warning naming what is missing) rather than shipping a dashboard nobody can
  log into. Result when enabled: end-to-end traces `grid-ui` →
  `grid-aiq-agent`. Known gap: the custom `server.js` WS proxy is not
  auto-instrumented (follow-up).
- Endpoint asymmetry (intentional): the frontend gets the BASE URL
  (`http://otel-collector:4318`, JS exporter appends `/v1/traces` per spec);
  the Python NAT exporter posts to explicit endpoints as-is, so the backend
  keeps the full path.

## Amendment 2 (2026-07-28): OIDC moves to the Gateway

Added after the first deploy: **nobody could sign in to the dashboard.**

**What was wrong.** The dashboard's relying party is ASP.NET Core's stock
`OpenIdConnectHandler`, which sends only spec-standard authorization
parameters. WorkOS's `/user_management/authorize` is *not* a spec-complete
OIDC authorization endpoint — it requires a non-standard connection selector
(`provider=authkit`, or `connection_id`/`organization_id`/`domain_hint`).
Without one it 302s to `error.workos.com/sso/invalid-connection-selector`, so
the user never reaches a login screen. Reproduce in one line:

```bash
curl -s -o /dev/null -w '%{redirect_url}\n' \
  "https://api.workos.com/user_management/authorize?client_id=$CID\
&redirect_uri=https%3A%2F%2F$OTEL_DOMAIN%2Foauth2%2Fcallback\
&response_type=code&scope=openid+profile&state=x&nonce=y"
# -> https://error.workos.com/sso/invalid-connection-selector
# add &provider=authkit -> 302 to the AuthKit hosted login UI
```

Scope variations (`openid`, `+email`, `+offline_access`) make no difference,
and `organization_id` fails separately because the platform org has no SSO
connection (SSO connections are a paid WorkOS add-on; AuthKit itself is free).

**Why fact #3 below did not catch it.** It verified that a discovery document
*exists* at the per-client path. It does — but it is minimal (`issuer`,
`authorization_endpoint`, `token_endpoint`, `jwks_uri`,
`response_types_supported`; no `scopes_supported`, no `claims_supported`, no
`end_session_endpoint`). Publishing a discovery document is not the same as
being usable by a stock RP, and no actual authorization request was ever made.

**Change.** Authentication and the `org_id` gate move out of the dashboard and
onto the Envoy Gateway, as a `SecurityPolicy` targeting the `grid-otel`
HTTPRoute (`deploy/pulumi/src/platform/observability.ts`,
`otelSecurityPolicySpec`). The dashboard runs `AuthMode=Unsecured` and is
reachable only from the Gateway (`allow-edge-to-aspire-dashboard`
NetworkPolicy). Three stages, in Envoy's fixed filter order
(OAuth2=8 → JWTAuthn=9 → RBAC=301):

1. `oidc` — browser redirect flow against WorkOS; `forwardAccessToken: true`
   replays the WorkOS access token upstream as `Authorization: Bearer`.
2. `jwt` — verifies it against the per-client JWKS
   (`https://api.workos.com/sso/jwks/<client_id>`).
3. `authorization` — `defaultAction: Deny`, allowing only `org_id =
   <platformOrgId>`.

**Why this works where the dashboard could not.** Envoy's OAuth2 filter builds
its authorization redirect by parsing the query string already present on
`authorization_endpoint` and then overwriting only the standard parameters
(`source/extensions/filters/http/oauth2/filter.cc`,
`buildAutorizationQueryParams`). So pinning
`authorizationEndpoint: .../authorize?provider=authkit` carries the selector
into every authorization request. Nothing bindable under
`Authentication:Schemes:OpenIdConnect:*` can do the same — the ASP.NET
property that could (`AdditionalAuthorizationParameters`) is .NET 9+, and the
pinned dashboard image ships ASP.NET 8.0.29.

**Why the Gateway rather than an auth proxy.** Envoy Gateway is already the
edge, so this adds no pod, no image to digest-pin or trivy-scan, and no new
secret: an `oauth2-proxy` deployment would have added all three to solve the
same problem. It also stays entirely inside free tiers (Envoy Gateway is OSS;
AuthKit is free to 1M MAU; no SSO connection needed), and the gate now runs
*before* any byte reaches the dashboard rather than inside a third-party
container.

**Second trap, found while wiring this up.** WorkOS's token endpoint returns
`{user, organization_id, access_token, refresh_token, …}` with **no
`expires_in`**. Envoy falls back to `defaultTokenTTL` and hard-fails the login
when that resolves to `<= 0` ("No default or explicit access token expiration
found in the token exchange response", `oauth2/oauth_client.cc`) — which is the
default. `defaultTokenTTL: 5m` is therefore required, not tuning: without it
every sign-in dies immediately *after* a successful code exchange. It must stay
at or below the WorkOS session access-token lifetime. The absent `id_token` is
harmless (Envoy treats it as optional), so `forwardIDToken` is not used.

**Trade-off, and a bug it caused.** The dashboard pod no longer authenticates
for itself, so its network isolation becomes the only thing between an
in-namespace pod and the telemetry UI. The first cut of this amendment claimed
the pod was "reachable only from the Gateway" and cited
`allow-edge-to-aspire-dashboard`. **That was wrong**, and a security review
caught it: `allow-same-namespace` selects every pod on every port, and
NetworkPolicy allows are additive, so the narrower edge rule subtracted
nothing. For the window between the two commits, any pod in `grid` — including
the internet-facing BFF and the LLM agent workers — could read every tenant's
traces over `:18888` with no credential, where previously the dashboard's own
OIDC gate would have refused them.

Fixed by making the isolation real rather than assumed:

- `allow-same-namespace` now excludes the dashboard (`NotIn` on
  `app.kubernetes.io/name`), because NetworkPolicy has no deny rule — not
  selecting the pod is the only way to withhold a blanket allow.
- `allow-collector-to-aspire-dashboard` grants the one legitimate in-namespace
  client (otel-collector → 4318).
- `loadConfig` refuses `observabilityEnabled` together with
  `networkPolicies=false`, so the isolation cannot be turned off underneath the
  tier.

The residual accepted risk is narrower than the collector's: a rogue
in-namespace pod can still *inject* spans into the collector's unauthenticated
receivers, but it can no longer *read* the store.

**One-time WorkOS setup** changes from `https://<otelDomain>/signin-oidc` to
**`https://<otelDomain>/oauth2/callback`** (Envoy's callback path).

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
   *(Facts 2 and 4 are superseded by Amendment 2 — the dashboard no longer
   runs an OIDC RP. They are kept because they are correct about the dashboard
   and would matter again if auth ever moved back into the pod.)*

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
  URI (`https://<otelDomain>/oauth2/callback`, registered in the WorkOS
  dashboard — Envoy's callback path; see Amendment 2).
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

## Security hardening (enterprise audit, 2026-07-28)

Applied after an adversarial review pass:

- The OTLP key is a hard dependency, not an optional one: a stack without
  `otelPrimaryApiKey` (or without the WorkOS OIDC client, `otelDomain`, or
  `platformOrgId`) does not deploy the tier at all — `pulumi preview` warns and
  skips it — instead of deploying an unauthenticated dashboard or one with a
  broken login.
- All sensitive values (OTLP key, WorkOS OIDC client secret) ride in the
  `aspire-dashboard-secrets` Secret via `secretKeyRef`; no plain env values.
- Both observability pods run with `automountServiceAccountToken: false`
  (no K8s API access needed) and `runAsNonRoot`.
- Both images are **digest-pinned** in `deploy/pulumi/src/config.ts`
  (`aspire-dashboard@sha256:d71f…` = 13.4.2, `opentelemetry-collector-contrib@sha256:f2f0…`
  = 0.157.0); upgrades are deliberate config changes, not mutable-tag surprises.
- `.github/workflows/security.yml` has an `image-scan` job (trivy,
  HIGH/CRITICAL, `--ignore-unfixed`) that extracts the pinned digests from
  the Pulumi config and blocks on fixable findings. **This makes the pins
  self-maintaining**: when the pinned dashboard falls behind on .NET runtime
  or base-OS patches, the check fails and forces a deliberate bump (the
  9.1.0 pin this ADR was written against shipped ASP.NET 8.0.15 and
  Azure Linux `openssl`, which is how 13.4.2 / ASP.NET 8.0.29 on the
  `azurelinux/distroless/base` minimal base was selected). Findings that
  live *inside* the upstream image and no bump can clear go in
  `.trivyignore.yaml` as **time-boxed** exceptions (justification +
  `expired_at`), so the gate returns red instead of ignoring a CVE forever.
- The dashboard container also listens on `:18891` (MCP) and serves the
  Telemetry HTTP API (`/api/telemetry/*`, API-key auth, key auto-generated
  when unset). Neither is published: the Service exposes only 18888 plus the
  two OTLP ports, the HTTPRoute targets 18888, and the NetworkPolicies admit
  only the edge (18888) and the collector (4318). Note `:18891` is absent from
  the Service but still dialable by pod IP — its own API key is what protects
  it, which is why the dashboard being excluded from `allow-same-namespace`
  matters for that surface too.

### Residual risks (accepted, documented)

- **Trace payloads contain user content** (prompts, retrieved snippets, LLM
  responses — that is the point of the tool) and span URLs can carry
  **presigned S3 query strings**. Blast radius is bounded by the OIDC
  claim gate (platform-org members only), the in-memory-only store, and the
  ring-buffer limits. Do NOT widen dashboard access without re-evaluating.
- **Plaintext OTLP in-cluster** (no mTLS between producers → collector →
  dashboard). Acceptable on a private cluster network; a service mesh would
  be the upgrade path if the cluster threat model changes.
- **Shared WorkOS client** for the dashboard OIDC: the dashboard uses the
  same AuthKit client as the app (issuer is per-client). A dedicated WorkOS
  app/client for observability would shrink the blast radius of the shared
  secret — follow-up, not a blocker.
- **Collector receivers are unauthenticated** (plain OTLP). Reachability is
  bounded to same-namespace pods by the NetworkPolicy posture; a rogue
  in-namespace pod could inject spans. Accepted: namespace workload identity
  is already the trust boundary. This acceptance covers span *injection*
  (integrity) only — bulk *read* of the store is not accepted, which is why the
  dashboard is excluded from the intra-namespace allow (Amendment 2).
- **Safe SPOFs**: dashboard and collector are single-replica with no durable
  storage. A restart loses the ring buffer. Both hops only have the
  `exporterhelper` defaults behind them (`sending_queue`, in-memory, 1000
  requests; `retry_on_failure`, 5s→30s backoff up to 300s) — the collector's
  `batch` processor groups telemetry, it does not make delivery reliable — so
  telemetry is dropped once those limits are exhausted. Telemetry loss never
  affects request serving.

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

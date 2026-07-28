import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import type { ISecurityPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/SecurityPolicySpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { GATEWAY_NAME } from "./gateway";

const COMPONENT = "aspire-dashboard";
const DASHBOARD_PORT = 18888;
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;

/** HTTPRoute name for the dashboard UI — the SecurityPolicy attaches to it. */
const OTEL_ROUTE_NAME = "grid-otel";
/**
 * Secret name. A constant rather than `secrets.metadata.name` because the
 * SecurityPolicy spec is a plain (typed) object, not a Pulumi resource input —
 * threading an Output through it would need a cast that defeats the typing.
 */
const SECRETS_NAME = "aspire-dashboard-secrets"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)

export interface Observability {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  route: k8s.apiextensions.CustomResource;
  /** Edge-enforced OIDC + org_id gate in front of the dashboard route. */
  securityPolicy: k8s.apiextensions.CustomResource;
  /**
   * Dedicated Secret holding the sensitive values:
   *   - `otlp-api-key`  — OTLP ingestion key (dashboard PrimaryApiKey +
   *                       collector exporter header), via `secretKeyRef`
   *   - `client-secret` — OIDC client secret read by Envoy Gateway (key name
   *                       fixed by the SecurityPolicy API — see
   *                       OIDC.ClientSecret). The dedicated dashboard client's
   *                       secret when provisioned, else the shared WorkOS API
   *                       key.
   * Neither ever appears as a plain env value on a pod spec (visible to anyone
   * with Deployment read RBAC).
   */
  secrets: k8s.core.v1.Secret;
}

/** Secret keys in the observability Secret. */
export const OTLP_API_KEY_SECRET_KEY = "otlp-api-key"; // pragma: allowlist secret (Secret key name, not a credential)
/**
 * Envoy Gateway requires the OIDC client secret under exactly this key
 * (`OIDC.ClientSecret`: "the client secret should be stored in the key
 * client-secret"). Do not rename.
 */
const OIDC_CLIENT_SECRET_KEY = "client-secret"; // pragma: allowlist secret (Secret key name fixed by the Envoy Gateway API, not a credential)

/**
 * Deploys the .NET Aspire standalone dashboard as a single-replica Deployment
 * behind the shared Gateway on its own `https-otel` listener.
 *
 * The dashboard is a plain container — no .NET workload or AppHost. It stores
 * telemetry in an in-memory ring buffer (lost on restart). Only the UI
 * (:18888) is exposed via an HTTPRoute; OTLP ingestion (:4317/:4318) is
 * cluster-internal and API-key protected.
 *
 * Auth is NOT done by the dashboard: the container runs `AuthMode=Unsecured`
 * and every request is authenticated + authorized at the edge by the
 * SecurityPolicy below (see `otelSecurityPolicySpec`).
 *
 * That makes the pod's network isolation load-bearing, not incidental: a
 * request that reaches :18888 without traversing the Gateway meets NO
 * credential check at all. `network-policies.ts` therefore excludes this pod
 * from the wholesale `allow-same-namespace` allow (rule 2) and grants exactly
 * two callers — the Gateway on 18888 (rule 7) and otel-collector on 4318
 * (rule 8) — and `config.ts` refuses to deploy this tier with NetworkPolicies
 * disabled. Weakening any of those three re-opens an unauthenticated,
 * cross-tenant telemetry store; they are one control, not three conveniences.
 */
export function installObservabilityDashboard(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  otlpApiKey: pulumi.Output<string>,
  /**
   * OIDC client secret for the Gateway SecurityPolicy: the dedicated dashboard
   * client's secret when one is provisioned, otherwise the shared WorkOS API
   * key (see `observability.oidcClientSecret` in config.ts).
   */
  oidcClientSecret: pulumi.Output<string>,
  dependsOn: pulumi.Resource[],
): Observability {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;
  const { observability: obs } = cfg;

  // All sensitive values in one dedicated Secret — referenced via secretKeyRef
  // so they never land on a pod spec as plain values.
  const secrets = new k8s.core.v1.Secret(
    SECRETS_NAME,
    {
      metadata: { name: SECRETS_NAME, namespace, labels },
      stringData: {
        [OTLP_API_KEY_SECRET_KEY]: otlpApiKey,
        [OIDC_CLIENT_SECRET_KEY]: oidcClientSecret,
      },
    },
    { provider, dependsOn },
  );
  const fromSecret = (key: string): k8s.types.input.core.v1.EnvVarSource => ({
    secretKeyRef: { name: secrets.metadata.name, key },
  });

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
            // No K8s API access needed — don't hand the pod an API token.
            automountServiceAccountToken: false,
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
                  // Endpoints: the container's OTLP listeners default to
                  // 18889 (gRPC) / 18890 (HTTP) — the 4317/4318 in the docs'
                  // docker example are HOST ports in `-p 4317:18889`. Rebind
                  // to the conventional ports so the Service matches.
                  { name: "ASPIRE_DASHBOARD_OTLP_ENDPOINT_URL", value: "http://0.0.0.0:4317" },
                  { name: "ASPIRE_DASHBOARD_OTLP_HTTP_ENDPOINT_URL", value: "http://0.0.0.0:4318" },
                  // UI access: authentication and the org_id gate are enforced
                  // at the edge by the SecurityPolicy, not here. The dashboard
                  // CANNOT do this itself — its RP is ASP.NET's stock
                  // OpenIdConnect handler, which sends only spec-standard
                  // authorization parameters, while WorkOS's /authorize
                  // requires a non-standard connection selector
                  // (`provider=authkit`). Without it WorkOS 302s to
                  // error.workos.com/sso/invalid-connection-selector and the
                  // user never reaches a login screen. Nothing bindable under
                  // Authentication:Schemes:OpenIdConnect can add that
                  // parameter, so OIDC moved to the Gateway (which can — see
                  // `otelSecurityPolicySpec`).
                  { name: "Dashboard__Frontend__AuthMode", value: "Unsecured" },
                  // Public URL for the links the dashboard generates.
                  { name: "Dashboard__Frontend__PublicUrl", value: `https://${obs.otelDomain}` },
                  // TLS terminates at the Gateway; Envoy forwards X-Forwarded-*.
                  // Keeps generated absolute links on https:// rather than http://.
                  { name: "ASPNETCORE_FORWARDEDHEADERS_ENABLED", value: "true" },
                  // App identity in the UI.
                  { name: "Dashboard__ApplicationName", value: "Grid" },
                  // OTLP ingestion auth (only the collector presents the key).
                  { name: "Dashboard__Otlp__AuthMode", value: "ApiKey" },
                  { name: "Dashboard__Otlp__PrimaryApiKey", valueFrom: fromSecret(OTLP_API_KEY_SECRET_KEY) },
                  // Raised ring-buffer limits for a useful live-view window.
                  { name: "Dashboard__TelemetryLimits__MaxLogCount", value: String(obs.telemetryLimits.maxLogCount) },
                  { name: "Dashboard__TelemetryLimits__MaxTraceCount", value: String(obs.telemetryLimits.maxTraceCount) },
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
    { provider, dependsOn: [...dependsOn, secrets] },
  );

  // Cluster-internal Service: the UI port for the HTTPRoute target, and the
  // two OTLP ports consumed exclusively by the OTel Collector.
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
      metadata: { name: OTEL_ROUTE_NAME, namespace, labels: commonLabels(COMPONENT) },
      spec: routeSpec,
    },
    { provider, dependsOn: service },
  );

  const securityPolicy = new k8s.apiextensions.CustomResource(
    "grid-otel-security-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "SecurityPolicy",
      metadata: { name: "grid-otel-auth", namespace, labels: commonLabels(COMPONENT) },
      spec: otelSecurityPolicySpec(cfg),
    },
    { provider, dependsOn: [route, secrets] },
  );

  return { deployment, service, route, securityPolicy, secrets };
}

/**
 * Edge authN + authZ for the Aspire dashboard route (ADR-0029 amendment 2).
 *
 * Three cooperating stages, run by Envoy in this order (the filter order is
 * fixed by Envoy Gateway: OAuth2=8, JWTAuthn=9, RBAC=301):
 *
 *   1. `oidc`          — browser redirect flow against WorkOS AuthKit. On
 *                        success Envoy stores the tokens in cookies and, with
 *                        `forwardAccessToken`, replays the WorkOS access token
 *                        upstream as `Authorization: Bearer <jwt>`.
 *   2. `jwt`           — verifies that token against WorkOS's per-client JWKS.
 *   3. `authorization` — default-deny; allows only tokens whose `org_id` claim
 *                        is the GRID Platform org. This is the same gate the
 *                        dashboard's own `RequiredClaimValue` was meant to be,
 *                        moved to the edge where it actually runs.
 *
 * THE `provider=authkit` QUERY PARAMETER IS LOAD-BEARING. WorkOS's
 * `/user_management/authorize` is not a spec-complete OIDC authorization
 * endpoint: it demands a connection selector (`provider`, `connection_id`,
 * `organization_id` or `domain_hint`) and 302s to
 * `error.workos.com/sso/invalid-connection-selector` without one. Envoy's
 * OAuth2 filter builds its redirect by parsing the query string already
 * present on `authorizationEndpoint` and then overwriting only the standard
 * params (`client_id`, `response_type`, `scope`, `state`, `redirect_uri`,
 * `code_challenge*`) — so anything else there survives into the authorization
 * request. That is what makes a stock OIDC client work against AuthKit at all.
 * Do not "tidy" the parameter out of the endpoint.
 *
 * Endpoints are pinned explicitly rather than discovered: WorkOS's per-client
 * discovery document is minimal (no `scopes_supported`, no `claims_supported`,
 * no `end_session_endpoint`) and carries the bare authorize URL, which would
 * drop the selector above.
 *
 * One-time WorkOS setup: register `https://<otelDomain>/oauth2/callback` as a
 * redirect URI (`docs/deployment/kubernetes.md` §9).
 */
export function otelSecurityPolicySpec(cfg: GridConfig): ISecurityPolicySpec {
  const { observability: obs, auth } = cfg;
  // Prefer a dedicated AuthKit client when one is provisioned, so a dashboard
  // token and an app token are not interchangeable and dashboard access can be
  // revoked without touching the app. Falls back to the shared app client,
  // which is the state ADR-0029 records as a residual risk. Issuer AND JWKS are
  // both per-client, so all three must be derived from the same id — deriving
  // one of them from the other client is the subtle way to break this.
  const clientId = obs.oidcClientId || auth.workosClientId;
  const issuer = `https://api.workos.com/user_management/${clientId}`;
  const jwtProviderName = "workos";

  return {
    targetRefs: [
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: OTEL_ROUTE_NAME },
    ],
    oidc: {
      provider: {
        issuer,
        // See the doc comment: the `provider=authkit` selector must survive.
        authorizationEndpoint: "https://api.workos.com/user_management/authorize?provider=authkit",
        tokenEndpoint: "https://api.workos.com/user_management/authenticate",
      },
      clientID: clientId,
      // Key name fixed by the SecurityPolicy API — see OIDC_CLIENT_SECRET_KEY.
      clientSecret: { name: SECRETS_NAME },
      // `offline_access` so WorkOS issues a refresh token for the renewal below.
      scopes: ["openid", "profile", "email", "offline_access"],
      redirectURL: `https://${obs.otelDomain}/oauth2/callback`,
      logoutPath: "/logout",
      // Hands the access token to stage 2 (and 3) — without it there is no
      // token for the JWT filter to verify and the org_id gate cannot run.
      forwardAccessToken: true,
      // REQUIRED, not a tuning knob. WorkOS's token endpoint returns
      // {user, organization_id, access_token, refresh_token, ...} with NO
      // `expires_in`. Envoy falls back to this value and hard-fails the login
      // when the result is <= 0 ("No default or explicit access token
      // expiration found in the token exchange response" —
      // oauth2/oauth_client.cc). Leaving it unset means every sign-in dies
      // immediately after a successful code exchange.
      //
      // Must stay <= the AuthKit application's `accessTokenExpiry` (confirmed
      // 300s on this environment). Too long and Envoy keeps replaying a token
      // the JWT filter already rejects; too short only costs an early refresh.
      defaultTokenTTL: "5m",
      // Renew silently rather than bouncing the browser through a full
      // redirect every few minutes (which would also drop the dashboard's
      // Blazor SignalR connection). Envoy's default is already true — pinned
      // because the short TTL above makes the behaviour load-bearing.
      refreshToken: true,
    },
    jwt: {
      providers: [
        {
          name: jwtProviderName,
          issuer,
          remoteJWKS: { uri: `https://api.workos.com/sso/jwks/${auth.workosClientId}` },
        },
      ],
    },
    authorization: {
      // Fail closed: anything that is not an authenticated platform OWNER is
      // denied, including a request that somehow skipped stages 1-2.
      //
      // Membership of the platform org is deliberately NOT sufficient. That
      // was the old dashboard gate (`RequiredClaimType=org_id`) and it does
      // not match how the application itself decides platform access:
      // `isPlatformOwner` (frontends/ui/src/lib/authz/platform.ts) requires the
      // org AND (`org-platform-owner` role OR the platform:organizations:view
      // permission). Gating on the org alone would mean anyone added to the
      // platform org with WorkOS's default `member` role — an action that
      // grants nothing in the app, and so reads as harmless to whoever does it
      // — silently gains cross-tenant read of prompts, document snippets, LLM
      // output and presigned S3 URLs.
      //
      // Claims inside one principal are ANDed and rules are ORed, so the app's
      // `role || permission` becomes two rules that share the org_id claim.
      defaultAction: "Deny",
      rules: [
        {
          name: "platform-owner-by-role",
          action: "Allow",
          principal: {
            jwt: {
              provider: jwtProviderName,
              claims: [
                { name: "org_id", valueType: "String", values: [obs.platformOrgId] },
                // PLATFORM_OWNER_ROLE_SLUG in src/lib/authz/platform.ts.
                { name: "role", valueType: "String", values: ["org-platform-owner"] },
              ],
            },
          },
        },
        {
          name: "platform-owner-by-permission",
          action: "Allow",
          principal: {
            jwt: {
              provider: jwtProviderName,
              claims: [
                { name: "org_id", valueType: "String", values: [obs.platformOrgId] },
                // PLATFORM_PERMISSIONS.organizationsView in authz/permissions.ts.
                // StringArray: `permissions` is a JSON array in the token and
                // matches when it CONTAINS the value.
                {
                  name: "permissions",
                  valueType: "StringArray",
                  values: ["platform:organizations:view"],
                },
              ],
            },
          },
        },
      ],
    },
  };
}

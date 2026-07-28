import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import type { ISecurityPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/SecurityPolicySpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { ROLLOUT, gracefulShutdown, recreateRollout } from "./rollout";
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
/**
 * WorkOS permission that grants dashboard access — the same value the app uses
 * as `PLATFORM_PERMISSIONS.organizationsView`. Requested as an OAuth scope and
 * enforced as the authorization rule, so the two cannot drift apart.
 */
const PLATFORM_VIEW_PERMISSION = "platform:organizations:view";

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
   *   - `client-secret` — the Connect application's OIDC client secret, read by
   *                       Envoy Gateway (key name fixed by the SecurityPolicy
   *                       API — see OIDC.ClientSecret)
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
  /** The Connect application's OIDC client secret, for the SecurityPolicy. */
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
        // Single replica holding an in-memory telemetry ring buffer: two would
        // split the live view, so Recreate rather than a surge.
        ...recreateRollout(ROLLOUT.observability),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false,
            // No K8s API access needed — don't hand the pod an API token.
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
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
 * WHY A CONNECT APPLICATION AND NOT THE APP'S AUTHKIT CLIENT. The app's client
 * speaks WorkOS's `/user_management/*` endpoints, and those cannot serve this
 * flow — for two independent reasons, both verified against live WorkOS:
 *
 *   1. `/user_management/authorize` is not a spec-complete OIDC authorization
 *      endpoint. It demands a non-standard connection selector (`provider`,
 *      `connection_id`, `organization_id` or `domain_hint`) and 302s to
 *      `error.workos.com/sso/invalid-connection-selector` without one.
 *   2. Fatally: `/user_management/authenticate` reads client credentials ONLY
 *      from the request body, and answers
 *      `invalid_request: Missing required parameter: client_id` to an HTTP
 *      Basic header. Envoy Gateway hardcodes Basic auth for the token exchange
 *      (`internal/xds/translator/oidc.go`: "every OIDC provider supports basic
 *      auth") with no SecurityPolicy field to override it, so the flow always
 *      died at the callback with "OAuth flow failed."
 *
 * A Connect application's issuer — the environment's AuthKit domain — publishes
 * a complete discovery document (`scopes_supported`, `claims_supported`,
 * `id_token_signing_alg_values_supported`, RS256, and
 * `token_endpoint_auth_methods_supported` including `client_secret_basic`), so
 * a stock OIDC client works against it unmodified. No selector parameter, no
 * workaround. The application must be a CONFIDENTIAL client: a public
 * PKCE-only client has no secret, and `clientSecret` is required here.
 *
 * Endpoints are pinned rather than discovered so translation never depends on a
 * live fetch; they are the documented `/oauth2/*` paths under the issuer, and
 * discovery would resolve to the same values.
 *
 * One-time WorkOS setup: register `https://<otelDomain>/oauth2/callback` as a
 * redirect URI on that application (`docs/deployment/kubernetes.md` §9).
 */
export function otelSecurityPolicySpec(cfg: GridConfig): ISecurityPolicySpec {
  const { observability: obs } = cfg;
  // Every endpoint hangs off the one issuer, so there is no way for them to
  // drift onto different WorkOS applications.
  const issuer = obs.oidcIssuer;
  const jwtProviderName = "workos";

  return {
    targetRefs: [
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: OTEL_ROUTE_NAME },
    ],
    oidc: {
      provider: {
        issuer,
        authorizationEndpoint: `${issuer}/oauth2/authorize`,
        tokenEndpoint: `${issuer}/oauth2/token`,
      },
      clientID: obs.oidcClientId,
      // Key name fixed by the SecurityPolicy API — see OIDC_CLIENT_SECRET_KEY.
      clientSecret: { name: SECRETS_NAME },
      // `offline_access` buys the refresh token for the renewal below. The
      // permission scope is what carries the authorization decision: WorkOS
      // grants it only if the signing-in user's role actually holds that
      // permission, so requesting it here is what makes the rule below mean
      // something. It must also be assigned to the Connect application
      // ("Scopes" in the WorkOS dashboard) or it is silently not issued.
      scopes: ["openid", "profile", "email", "offline_access", PLATFORM_VIEW_PERMISSION],
      redirectURL: `https://${obs.otelDomain}/oauth2/callback`,
      logoutPath: "/logout",
      // Hands the access token to stage 2 (and 3) — without it there is no
      // token for the JWT filter to verify and the org_id gate cannot run.
      forwardAccessToken: true,
      // Safety net, kept deliberately. Envoy hard-fails a login when the token
      // response carries no `expires_in` and this is unset, because the default
      // resolves to 0 ("No default or explicit access token expiration found in
      // the token exchange response", oauth2/oauth_client.cc). WorkOS's
      // /user_management endpoint does omit it; whether the Connect token
      // endpoint does has not been verified, so the net stays.
      //
      // Only a fallback: a real `expires_in` always wins. Keep it <= the
      // AuthKit application's `accessTokenExpiry` (300s on this environment) —
      // too long and Envoy replays a token the JWT filter already rejects.
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
          remoteJWKS: { uri: `${issuer}/oauth2/jwks` },
        },
      ],
    },
    authorization: {
      // Fail closed: anything without the platform permission is denied,
      // including a request that somehow skipped stages 1-2.
      //
      // The gate is the permission, not membership of the platform org. Bare
      // membership was the old dashboard gate (`RequiredClaimType=org_id`) and
      // it does not match how the application decides platform access:
      // `isPlatformOwner` (frontends/ui/src/lib/authz/platform.ts) accepts the
      // `org-platform-owner` role OR this permission. Gating on the org alone
      // would mean anyone added to the platform org with WorkOS's default
      // `member` role — which grants nothing in the app, and so reads as
      // harmless to whoever does it — silently gained cross-tenant read of
      // prompts, document snippets, LLM output and presigned S3 URLs.
      //
      // One claim is enough here because the permission is doubly scoped: it
      // is issued only to this Connect application (per-application scope
      // assignment) and only to a user whose role in the selected organization
      // holds it. `org_id` would be belt-and-braces, but adding a claim that
      // may not be present in a Connect token risks locking everyone out for
      // no gain — revisit once a real token has been inspected.
      defaultAction: "Deny",
      rules: [
        {
          name: "platform-permission-only",
          action: "Allow",
          principal: {
            // `scopes` matches the space-delimited `scope`/`scp` claim per
            // RFC 6749, which is how granted permissions arrive on an OAuth
            // access token. This mirrors PLATFORM_PERMISSIONS.organizationsView
            // in frontends/ui/src/lib/authz/permissions.ts.
            jwt: { provider: jwtProviderName, scopes: [PLATFORM_VIEW_PERMISSION] },
          },
        },
      ],
    },
  };
}

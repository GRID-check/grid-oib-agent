import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import { GridConfig } from "../config";
import { EDGE_TIMEOUT, PORT, QDRANT } from "../constants";
import { GATEWAY_NAME } from "./gateway";
import { commonLabels } from "./namespaces";
import { OIDC_CLIENT_SECRET_KEY, platformOidcSecurityPolicySpec } from "./platform-oidc";

/**
 * Request headers dropped before a dashboard request reaches Qdrant.
 *
 * `Authorization`: the gate runs with `forwardAccessToken`, so Envoy's OAuth2
 * filter sets `Authorization: Bearer <WorkOS access token>` on every request,
 * and Envoy Gateway configures the JWT filter with `forward: true`
 * (`internal/xds/translator/jwt.go`), so verification does not remove it.
 * Qdrant reads that header as an API key: `AuthKeys::extract_key` in
 * `src/common/auth/mod.rs` (v1.19.2) takes `api-key` first and falls back to
 * `Authorization: Bearer`. Today the dashboard's own `api-key` header wins, so
 * the token does not shadow it; without a key the request fails as "Invalid
 * API key or JWT" instead of "Must provide an API key". Stripped anyway: it is
 * a platform credential for the Connect application, Qdrant has no use for it,
 * and a Qdrant that flipped that precedence or turned on `jwt_rbac` would start
 * judging every dashboard call by a token it did not issue.
 *
 * `Cookie`: Envoy's OAuth2 filter keeps the access token and the ID token in
 * the `BearerToken` and `IdToken` cookies, and strips only the HMAC, expiry,
 * refresh-token and flow cookies on the way upstream (`removeOAuthFlowCookies`
 * in `source/extensions/filters/http/oauth2/filter.cc`, Envoy `main` read
 * 2026-10-15). Qdrant reads no cookie (its auth looks at the two headers
 * above), so dropping the header costs nothing and keeps the same token out by
 * the other door.
 *
 * WHY A ROUTE FILTER IS AFTER THE GATE. A Gateway API `RequestHeaderModifier`
 * becomes the Envoy route's `request_headers_to_remove`
 * (`internal/gatewayapi/filters.go` -> `buildXdsRoute` in
 * `internal/xds/translator/route.go`). Envoy applies those in the router
 * filter, `finalizeRequestHeaders` in `source/common/router/router.cc`, just
 * before it picks the upstream; the router is the terminal HTTP filter, so it
 * runs after OAuth2 (order 9), JWTAuthn (10) and RBAC (301) in Envoy Gateway's
 * `newOrderedHTTPFilter`. Read in the upstream sources on 2026-10-15 (Envoy
 * Gateway and Envoy `main`, since the chart here is unpinned). Not verified
 * against a running Gateway: no cluster was reachable when this was written.
 * The check after enabling it is in the runbook's "Dashboard" section.
 */
const STRIPPED_REQUEST_HEADERS = ["Authorization", "Cookie"] as const;

/**
 * Qdrant's built-in web dashboard on a public host, behind the same
 * platform-operator gate as Langfuse (`platform-oidc.ts`). Only built when
 * `qdrantDashboardEnabled`; the listener (`gateway.ts`), the DNS host
 * (`dns.ts`) and the edge NetworkPolicy (rule 19) follow the same flag.
 *
 * The Qdrant server serves the dashboard at `/dashboard` on its REST port, and
 * the dashboard's JavaScript calls the REST API on the same origin
 * (`/collections`, `/cluster`, ...), so the route sends the whole host to the
 * `qdrant` Service on 6333. A bare `/` redirects to `/dashboard`: Qdrant
 * answers `/` with its version JSON, which is not what a person typing the
 * host wants.
 *
 * Operators only: no `alsoAdmit`. The analysts' observability permission opens
 * Langfuse, which shows traces; this opens raw read access to every office's
 * chunk text, and write access to whoever holds the admin key.
 *
 * NO API KEY AT THE EDGE. The gate decides who reaches the dashboard; Qdrant's
 * own key still decides what each call may do, and the operator types it into
 * the dashboard once (it keeps it in the browser). Injecting a key here would
 * mean a `RequestHeaderModifier` `set`, and Gateway API header modifiers take
 * literal values only, with no Secret reference: the key would sit in
 * plaintext in the HTTPRoute object, readable by anything that can list
 * routes, and in Pulumi state. It would also make every operator an admin
 * whatever they meant to do. The runbook says to paste `qdrantReadOnlyApiKey`
 * for looking and the read-write key only for a deliberate write.
 */
export function installQdrantDashboard(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): void {
  const dashboard = cfg.qdrant.dashboard;
  const labels = commonLabels(QDRANT.name);

  // The platform Connect application's client secret, in a Secret of its own.
  // Same client and same source (`otelOidcClientSecret`) as Langfuse's gate,
  // whose copy lives in `langfuse-secrets`; not that Secret, because the
  // dashboard must not need the Langfuse tier to be on, and the SecurityPolicy
  // can only reference a Secret in its own namespace.
  const oidcSecret = new k8s.core.v1.Secret(
    QDRANT.dashboard.oidcSecret,
    {
      metadata: { name: QDRANT.dashboard.oidcSecret, namespace, labels },
      stringData: { [OIDC_CLIENT_SECRET_KEY]: cfg.observability.oidcClientSecret },
    },
    { provider },
  );

  const routeSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: QDRANT.dashboard.listenerName }],
    hostnames: [dashboard.domain],
    rules: [
      {
        // Exactly `/`, which beats the catch-all below (an Exact match
        // outranks a prefix). 302, not 301: a browser caches a 301 for good,
        // and nothing here is permanent enough for that.
        matches: [{ path: { type: "Exact", value: "/" } }],
        filters: [
          {
            type: "RequestRedirect",
            requestRedirect: {
              path: { type: "ReplaceFullPath", replaceFullPath: QDRANT.dashboard.path },
              statusCode: 302,
            },
          },
        ],
      },
      {
        // Everything else: the dashboard's files and the REST API it calls.
        backendRefs: [{ name: QDRANT.name, port: PORT.qdrantHttp }],
        filters: [
          {
            type: "RequestHeaderModifier",
            requestHeaderModifier: { remove: [...STRIPPED_REQUEST_HEADERS] },
          },
        ],
        // A collection listing or a scroll over a large collection outlasts
        // Envoy's 15s default; same budget as the Langfuse and app routes.
        timeouts: { request: EDGE_TIMEOUT, backendRequest: EDGE_TIMEOUT },
      },
    ],
  };
  const securityPolicy = new k8s.apiextensions.CustomResource(
    "grid-qdrant-dashboard-security-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "SecurityPolicy",
      metadata: { name: QDRANT.dashboard.policyName, namespace, labels },
      spec: platformOidcSecurityPolicySpec(cfg, {
        routeName: QDRANT.dashboard.routeName,
        domain: dashboard.domain,
        secretName: QDRANT.dashboard.oidcSecret,
      }),
    },
    { provider, dependsOn: [oidcSecret] },
  );

  new k8s.apiextensions.CustomResource(
    "grid-qdrant-dashboard-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: QDRANT.dashboard.routeName, namespace, labels },
      spec: routeSpec,
    },
    // The policy first, the reverse of Langfuse's order. Envoy Gateway skips,
    // without error, a SecurityPolicy whose target route does not exist yet
    // (`resolveSecurityPolicyRouteTargetRef` in
    // `internal/gatewayapi/securitypolicy.go`, read 2026-10-15) and translates
    // every policy against every route on each pass, so the pass that first
    // sees the route already sees its gate. Pulumi deletes in reverse, so
    // turning the flag off removes the route before the gate as well.
    { provider, dependsOn: [...dependsOn, securityPolicy] },
  );
}

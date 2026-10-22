import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
// Compile-time spec typing from the upstream CRD schemas (see gateway.ts).
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import type { IBackendTrafficPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/BackendTrafficPolicySpec";
import type { IHTTPRouteFilterSpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/HTTPRouteFilterSpec";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import type { ICompression } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/Compression";
import type { IRetry } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/Retry";
import type { IRateLimitRule } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/RateLimitRule";
import type { IRateLimitSpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/RateLimitSpec";
import { GATEWAY_NAME } from "../platform/gateway";
import { EDGE_RATE_LIMIT, EDGE_RETRY, EDGE_TIMEOUT, PORT, SIGNED_INTERNAL_ROUTE } from "../constants";

/**
 * Retry policy applied to both public routes.
 *
 * The trigger list is the whole design. Envoy's own default trigger set
 * includes `unavailable` and `retriable-status-codes(503)` — retrying on a
 * status the upstream actually RETURNED. That is wrong here: the BFF routes are
 * not all idempotent (chat sends, ingest, workflow mutations are POSTs), and a
 * 503 produced by application code means the request was received and may have
 * had side effects. Replaying it risks a duplicate.
 *
 * The three triggers below are the ones where Envoy knows the upstream never
 * processed the request, so a retry cannot duplicate anything:
 *   - `connect-failure`        — the TCP connect itself failed (pod gone).
 *   - `refused-stream`         — HTTP/2 REFUSED_STREAM, i.e. explicitly not started.
 *   - `reset-before-request`   — the stream was reset before the request was sent
 *                                upstream. Note this is NOT plain `reset`, which
 *                                also fires after a response has begun — that
 *                                would replay a half-streamed chat answer.
 *
 * Setting `retryOn` at all is what narrows the defaults; leaving `retry` unset
 * entirely would mean no retries, and setting only `numRetries` would inherit
 * the unsafe default triggers.
 */
const edgeRetry: IRetry = {
  numRetries: EDGE_RETRY.numRetries,
  retryOn: { triggers: ["connect-failure", "refused-stream", "reset-before-request"] },
  perRetry: {
    // Backoff only — deliberately NO `perRetry.timeout`. That field caps each
    // attempt, and a cap here would silently override the 3600s streaming /
    // WebSocket budget the same policy sets below.
    backOff: { baseInterval: EDGE_RETRY.baseInterval, maxInterval: EDGE_RETRY.maxInterval },
  },
};

/**
 * Response compression for the landing site, Brotli preferred over gzip.
 *
 * `compressor`, not `compression`: the latter is deprecated since Envoy Gateway
 * v1.6, which introduced this field with the same item shape and made list
 * order the tie-break when a browser weighs both encodings equally (every
 * current browser sends `br` and `gzip` at q=1). A cluster still on EG < v1.6
 * prunes the unknown field silently, so the proof is a `content-encoding: br`
 * on the live site, not a green `pulumi up`.
 *
 * Envoy's default content-type list applies (HTML, CSS, JS, JSON, SVG, plain
 * text, XML), so fonts and WebP, which are compressed already, pass through
 * untouched. The filter also adds `Vary: Accept-Encoding` and weakens a strong
 * ETag on the bodies it rewrites, which is what caches need.
 *
 * Web only, on purpose. The app route streams chat and SSE through the BFF, and
 * a compressor can hold output back until its window fills, turning a token
 * stream into bursts. Nobody has measured what Envoy does to those streams, so
 * that route gets a compressor only after someone does.
 */
export const WEB_COMPRESSOR: ICompression[] = [{ type: "Brotli" }, { type: "Gzip" }];

/**
 * One per-client-IP rate limit rule (ADR-0040 layer L1).
 *
 * `sourceCIDR` with `type: Distinct` is what makes the bucket PER CLIENT rather
 * than one shared bucket for the whole range — `Exact` would give every caller
 * in it a single counter between them. Which address counts as "the client" is
 * decided by `clientIPDetection` on the ClientTrafficPolicy
 * (`platform/gateway.ts`); this rule is only as meaningful as that setting.
 *
 * `path` is optional and narrows the rule to a prefix. Rules are NOT mutually
 * exclusive: Envoy evaluates every matching rule and refuses if any one of them
 * is over, so a request to `/api/auth/x` counts against both the auth rule and
 * the catch-all. That is the intent — a narrow rule tightens a surface, it does
 * not exempt it from the route's overall budget.
 */
function perClientIpRule(
  cfg: GridConfig,
  requestsPerMinute: number,
  cidr: string,
  pathPrefix?: string,
): IRateLimitRule {
  return {
    clientSelectors: [
      {
        sourceCIDR: { value: cidr, type: "Distinct" },
        ...(pathPrefix ? { path: { type: "PathPrefix", value: pathPrefix } } : {}),
      },
    ],
    limit: { requests: requestsPerMinute, unit: "Minute" },
    // Ships observing, not enforcing. Every counter moves and every near-limit
    // metric is emitted; only the refusal is withheld. Turning this off is a
    // deliberate act taken with the would-have-blocked numbers in hand — see
    // `rateLimit.shadowMode` in config.ts.
    shadowMode: cfg.rateLimit.shadowMode,
  };
}

/**
 * Wrap rules into a `rateLimit` spec, or nothing at all when the feature is off.
 *
 * `type: "Global"` is redundant on current Envoy Gateway (the `global` field
 * alone is enough, and `type` is marked deprecated) but harmless, and it keeps
 * the policy valid against the older CRD schema — the chart tracks latest, so
 * the cluster may be ahead of or behind this program.
 *
 * Global, not Local: Local rate limits are per Envoy process, and the edge runs
 * 2 replicas behind one LoadBalancer, so a "30/min" local limit is really
 * 60/min — and changes meaning the moment the fleet scales.
 */
function edgeRateLimit(cfg: GridConfig, rules: IRateLimitRule[]): { rateLimit?: IRateLimitSpec } {
  if (!cfg.rateLimit.enabled) return {};
  return { rateLimit: { type: "Global", global: { rules } } };
}

/**
 * One budget, expressed for BOTH address families.
 *
 * A CIDR selector matches one family only: `0.0.0.0/0` never matches an IPv6
 * address, so on a dual-stack LoadBalancer an IPv6 client would walk past every
 * rule while the config read as covering "everyone". The two cannot be merged
 * into a single selector, so each budget becomes two rules with the same limit.
 *
 * They are independent buckets, which is correct: a client has one address, and
 * only one of the two rules can ever match it. On an IPv4-only cluster the v6
 * rule simply never fires — a few unused descriptors, and no way to be silently
 * uncovered the day the cluster gains an IPv6 address.
 */
function perClientRules(
  cfg: GridConfig,
  requestsPerMinute: number,
  pathPrefix?: string,
): IRateLimitRule[] {
  return [
    perClientIpRule(cfg, requestsPerMinute, "0.0.0.0/0", pathPrefix),
    perClientIpRule(cfg, requestsPerMinute, "::/0", pathPrefix),
  ];
}

/**
 * An RE2 pattern matching exactly the decimal integers from 0 to `max`, written
 * without leading zeros: what a `Content-Length` header may say for the edge
 * to forward it (`SIGNED_INTERNAL_ROUTE`). Gateway API can match a header by
 * regular expression but not by number, so the bound is spelled out digit by
 * digit: every shorter number, then every number of `max`'s length that is
 * smaller at its first differing digit, then `max` itself.
 */
export function decimalAtMost(max: number): string {
  if (!Number.isSafeInteger(max) || max < 0) throw new Error(`decimalAtMost: ${max} is not a non-negative integer`);
  const digits = String(max);
  const alternatives = ["0"];
  if (digits.length > 1) alternatives.push(`[1-9][0-9]{0,${digits.length - 2}}`);
  for (let i = 0; i < digits.length; i++) {
    const low = i === 0 ? 1 : 0;
    const high = Number(digits[i]) - 1;
    if (high < low) continue;
    const rest = digits.length - i - 1;
    alternatives.push(`${digits.slice(0, i)}[${low}-${high}]${rest > 0 ? `[0-9]{${rest}}` : ""}`);
  }
  if (max > 0) alternatives.push(digits);
  return `^(?:${alternatives.join("|")})$`;
}

/**
 * The signed internal routes (`SIGNED_INTERNAL_ROUTE`, where the reasons are):
 * a route of their own on the app host, which wins over the app route's `/`
 * for every path under the prefix (Gateway API's longest-prefix precedence).
 *
 * Two rules. The first forwards a request whose `Content-Length` is at most
 * the ceiling; it has a header match, so it takes precedence over the second
 * (Gateway API: more header matches first), which answers everything else
 * under the prefix with a 413 from Envoy itself (an `HTTPRouteFilter` direct
 * response). The 413 carries no `x-inbound-verdict`, so the Worker retries;
 * Cloudflare's 25 MiB inbound cap means a real mail never meets it.
 *
 * Its policy has no rate limit and no hour-long budget, and it is the only
 * policy that applies: the app route's catch-all bucket attaches to `grid-app`
 * and so never sees these requests.
 */
function installSignedInternalRoute(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): k8s.apiextensions.CustomResource {
  const { routeName, pathPrefix, maxBodyBytes, requestTimeout, refusalFilterName } = SIGNED_INTERNAL_ROUTE;
  const refusalSpec: IHTTPRouteFilterSpec = {
    directResponse: {
      statusCode: 413,
      contentType: "text/plain",
      body: {
        type: "Inline",
        inline: `A signed internal route takes a fixed-length body of at most ${maxBodyBytes} bytes.\n`,
      },
    },
  };
  const refusal = new k8s.apiextensions.CustomResource(
    "grid-signed-body-limit-filter",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "HTTPRouteFilter",
      metadata: { name: refusalFilterName, namespace, labels: commonLabels("frontend") },
      spec: refusalSpec,
    },
    { provider, dependsOn },
  );

  const path = { type: "PathPrefix" as const, value: pathPrefix };
  const routeSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-app" }],
    hostnames: [cfg.ingress.appDomain],
    rules: [
      {
        matches: [
          {
            path,
            headers: [{ type: "RegularExpression", name: "content-length", value: decimalAtMost(maxBodyBytes) }],
          },
        ],
        backendRefs: [{ name: "frontend", port: PORT.frontend }],
      },
      {
        matches: [{ path }],
        filters: [
          {
            type: "ExtensionRef",
            extensionRef: { group: "gateway.envoyproxy.io", kind: "HTTPRouteFilter", name: refusalFilterName },
          },
        ],
      },
    ],
  };
  const route = new k8s.apiextensions.CustomResource(
    "grid-app-signed-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: routeName, namespace, labels: commonLabels("frontend") },
      spec: routeSpec,
    },
    { provider, dependsOn: [...dependsOn, refusal] },
  );

  const policySpec: IBackendTrafficPolicySpec = {
    targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: routeName }],
    timeout: { http: { requestTimeout } },
    // Never-dispatched failures only, as on the app route: a retry cannot
    // deliver one mail twice (and the BFF would answer a duplicate anyway).
    retry: edgeRetry,
  };
  new k8s.apiextensions.CustomResource(
    "grid-app-signed-backend-traffic-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "BackendTrafficPolicy",
      metadata: { name: `${routeName}-timeouts`, namespace, labels: commonLabels("frontend") },
      spec: policySpec,
    },
    { provider, dependsOn: route },
  );
  return route;
}

/**
 * Gateway API HTTPRoutes (replacing the legacy Ingress resources):
 *   - appDomain → frontend:3000 (UI + BFF + WebSocket chat upgrades)
 *   - appDomain `/api/internal/signed/*` → frontend:3000, with its own body
 *     ceiling, timeout and no rate limit (`installSignedInternalRoute`)
 *   - s3Domain  → seaweedfs:8333 (browser presigned preview/download URLs)
 *   - webDomain → web:4321 (landing site + blog, frontends/web)
 *
 * Each route attaches to its dedicated HTTPS listener on the shared Gateway.
 * WebSocket upgrades pass through natively; Envoy Gateway streams large bodies
 * with no request-size cap, except on the signed routes, whose ceiling is a
 * header match rather than a buffer.
 */
export function installHttpRoutes(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): {
  app: k8s.apiextensions.CustomResource;
  signed: k8s.apiextensions.CustomResource;
  s3: k8s.apiextensions.CustomResource;
  web: k8s.apiextensions.CustomResource;
  httpsRedirect: k8s.apiextensions.CustomResource;
} {
  const appRouteSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-app" }],
    hostnames: [cfg.ingress.appDomain],
    rules: [{ backendRefs: [{ name: "frontend", port: PORT.frontend }] }],
  };
  const app = new k8s.apiextensions.CustomResource(
    "grid-app-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "grid-app", namespace, labels: commonLabels("frontend") },
      spec: appRouteSpec,
    },
    { provider, dependsOn },
  );
  const signed = installSignedInternalRoute(cfg, provider, namespace, dependsOn);

  // Envoy's default per-request timeout (15s) would cut long streaming chat
  // responses and WS sessions on the app route. Give upstream requests the same
  // 3600s budget as the client-side policy.
  const appBackendPolicySpec: IBackendTrafficPolicySpec = {
    targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "grid-app" }],
    timeout: { http: { requestTimeout: EDGE_TIMEOUT } },
    // Ride out the endpoint-programming race on every frontend rolling update
    // instead of surfacing it to the browser.
    retry: edgeRetry,
    // Three budgets, narrowest threat first:
    //   - `/api/auth/*` is the credential-stuffing surface, and no honest client
    //     touches it in a loop.
    //   - `/websocket` is where a reconnect storm turns into session resolution,
    //     FGA lookups and budget reads in the BFF — the amplification
    //     `server.js`'s own limiter was added for. Same number, so moving the
    //     limit here is a like-for-like swap rather than a behaviour change.
    //   - everything else gets a deliberately loose catch-all: a chat session is
    //     chatty (inbox polling, presence, conversation reads) and this rule
    //     exists to stop a runaway client, not to shape normal traffic.
    // The signed internal routes are not on this route and none of these
    // budgets reach them (`installSignedInternalRoute`).
    ...edgeRateLimit(cfg, [
      ...perClientRules(cfg, cfg.rateLimit.limits.appAuth, EDGE_RATE_LIMIT.paths.auth),
      ...perClientRules(cfg, cfg.rateLimit.limits.appWsUpgrade, EDGE_RATE_LIMIT.paths.ws),
      ...perClientRules(cfg, cfg.rateLimit.limits.app),
    ]),
  };
  new k8s.apiextensions.CustomResource(
    "grid-app-backend-traffic-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "BackendTrafficPolicy",
      metadata: { name: "grid-app-timeouts", namespace, labels: commonLabels("frontend") },
      spec: appBackendPolicySpec,
    },
    { provider, dependsOn: app },
  );

  // Envoy's default 15s request timeout applies here too — a presigned
  // download/preview of a large PDF (or a slow client) would be reset
  // mid-body. Same 3600s budget as the app route.
  const s3BackendPolicySpec: IBackendTrafficPolicySpec = {
    targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "grid-s3" }],
    timeout: { http: { requestTimeout: EDGE_TIMEOUT } },
    // Same race, and a presigned GET is idempotent besides.
    retry: edgeRetry,
    // One document preview fans out into many object GETs, so this budget is
    // generous by design. It bounds someone walking presigned URLs, not a user
    // opening a PDF.
    ...edgeRateLimit(cfg, perClientRules(cfg, cfg.rateLimit.limits.s3)),
  };

  const s3RouteSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-s3" }],
    hostnames: [cfg.ingress.s3Domain],
    rules: [{ backendRefs: [{ name: "seaweedfs", port: PORT.seaweedS3 }] }],
  };
  const s3 = new k8s.apiextensions.CustomResource(
    "grid-s3-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "grid-s3", namespace, labels: commonLabels("seaweedfs") },
      spec: s3RouteSpec,
    },
    { provider, dependsOn },
  );

  const webRouteSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-web" }],
    hostnames: [cfg.ingress.webDomain],
    rules: [{ backendRefs: [{ name: "web", port: PORT.web }] }],
  };
  const web = new k8s.apiextensions.CustomResource(
    "grid-web-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "grid-web", namespace, labels: commonLabels("web") },
      spec: webRouteSpec,
    },
    { provider, dependsOn },
  );

  new k8s.apiextensions.CustomResource(
    "grid-s3-backend-traffic-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "BackendTrafficPolicy",
      metadata: { name: "grid-s3-timeouts", namespace, labels: commonLabels("seaweedfs") },
      spec: s3BackendPolicySpec,
    },
    { provider, dependsOn: s3 },
  );

  // Landing site route. Static pages are served well inside Envoy's default 15s
  // request timeout, so unlike the app/s3 routes there is NO 3600s
  // requestTimeout here — the default budget is correct for prerendered HTML.
  // Retries stay: the same endpoint-programming race on every web rolling
  // update (surge-only, one pod at a time) would otherwise surface to visitors
  // as a failed page load.
  const webBackendPolicySpec: IBackendTrafficPolicySpec = {
    targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "grid-web" }],
    retry: edgeRetry,
    compressor: WEB_COMPRESSOR,
    // Prerendered marketing pages: a human reads a few per minute, a scraper
    // reads hundreds. This is the one route where the honest and abusive
    // patterns are far enough apart that a tight number is safe.
    ...edgeRateLimit(cfg, perClientRules(cfg, cfg.rateLimit.limits.web)),
  };
  new k8s.apiextensions.CustomResource(
    "grid-web-backend-traffic-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "BackendTrafficPolicy",
      metadata: { name: "grid-web-timeouts", namespace, labels: commonLabels("web") },
      spec: webBackendPolicySpec,
    },
    { provider, dependsOn: web },
  );

  // Plain HTTP answers with a permanent redirect to HTTPS, on every host the
  // port-80 listener serves. It answered 404 before: the listener existed only
  // for cert-manager's HTTP-01 challenge. Google's favicon service fetches
  // `http://<apex>`, and Claude's connector tile takes its icon from that
  // service, so the 404 left Piloti's connector with a blank globe. The ACME
  // solver's own route matches its token path Exactly, which outranks this
  // catch-all prefix, so certificate renewal keeps working.
  const httpsRedirectSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: "http" }],
    rules: [{ filters: [{ type: "RequestRedirect", requestRedirect: { scheme: "https", statusCode: 301 } }] }],
  };
  const httpsRedirect = new k8s.apiextensions.CustomResource(
    "grid-https-redirect-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: "grid-https-redirect", namespace, labels: commonLabels("gateway") },
      spec: httpsRedirectSpec,
    },
    { provider, dependsOn },
  );

  return { app, signed, s3, web, httpsRedirect };
}

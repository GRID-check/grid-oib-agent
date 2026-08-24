import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
// Compile-time spec typing from the upstream CRD schemas (@kubernetes-models,
// generated from the Gateway API / Envoy Gateway CRDs). `import type` only —
// erased at build, zero runtime/vendored footprint — but every `spec` below is
// checked field-by-field by `tsc`. apiVersion/kind/metadata stay validated at
// `pulumi up` against the live cluster CRDs (and by the deploy-pulumi job).
import type { IGatewaySpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/GatewaySpec";
import type { IGatewayClassSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/GatewayClassSpec";
import type { IEnvoyProxySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/EnvoyProxySpec";
import type { IClientTrafficPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/ClientTrafficPolicySpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { EDGE_SHUTDOWN, SURGE_ONLY_STRATEGY } from "./rollout";
import { EDGE_RATE_LIMIT, EDGE_TIMEOUT, LANGFUSE, PLATFORM_RESOURCES } from "../constants";

/** Stable names referenced by the cert-manager solver and the HTTPRoutes. */
export const GATEWAY_NAME = "grid-gateway";
export const GATEWAY_CLASS = "eg";

/**
 * Edge on the **Gateway API** (not the legacy Ingress API, and not the retired
 * ingress-nginx). Implementation: **Envoy Gateway** (CNCF, Gateway-API native).
 *
 * Chart unpinned: tracks the latest `gateway-helm`, which installs both the
 * Gateway API standard-channel CRDs and the Envoy Gateway CRDs by default
 * (`crds.enabled=true`).
 *
 * Ordering: the controller ships the CRDs, which cert-manager must see at
 * startup to enable its Gateway integration — so install the controller FIRST,
 * then cert-manager, then the Gateway/GatewayClass resources.
 */
export function installGatewayController(
  cfg: GridConfig,
  provider: k8s.Provider,
): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace(
    "envoy-gateway-ns",
    { metadata: { name: "envoy-gateway-system" } },
    { provider },
  );

  // The counter store's `requirepass`, for the rate limit service that talks to
  // it. It lives HERE, not in the app namespace, because the rate limit
  // Deployment the Envoy Gateway controller generates runs here — a
  // `secretKeyRef` cannot cross namespaces.
  const redisAuthSecret =
    cfg.rateLimit.enabled && cfg.rateLimit.storePassword
      ? new k8s.core.v1.Secret(
          "ratelimit-redis-auth",
          {
            metadata: { name: RATE_LIMIT_REDIS_AUTH_SECRET, namespace: ns.metadata.name },
            stringData: { [RATE_LIMIT_REDIS_AUTH_KEY]: cfg.rateLimit.storePassword },
          },
          { provider, dependsOn: ns },
        )
      : undefined;

  return new k8s.helm.v3.Release(
    "envoy-gateway",
    {
      chart: "oci://docker.io/envoyproxy/gateway-helm",
      // Unpinned: track the latest Envoy Gateway release.
      namespace: ns.metadata.name,
      // Install CRDs + controller with the chart's defaults, plus (optionally)
      // the global rate limit service. DO NOT override `values.crds` or set
      // `skipAwait`: cert-manager (installed next with enableGatewayAPI)
      // hard-fails at startup if the Gateway API CRDs aren't Established first,
      // and the default release-await guarantees that order. Touching
      // `config.envoyGateway` does not disturb any of that.
      //
      // Helm DEEP-merges these over the chart's own `config.envoyGateway`, so
      // adding `provider.kubernetes` below keeps the chart's
      // `provider.type: Kubernetes` rather than replacing the block.
      values: cfg.rateLimit.enabled
        ? { config: { envoyGateway: rateLimitConfig(cfg, redisAuthSecret !== undefined) } }
        : {},
    },
    { provider, dependsOn: [ns, ...(redisAuthSecret ? [redisAuthSecret] : [])] },
  );
}

/** Secret (in `envoy-gateway-system`) holding the counter store's password. */
const RATE_LIMIT_REDIS_AUTH_SECRET = "grid-ratelimit-redis-auth"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)
/**
 * Env var the upstream `envoyproxy/ratelimit` service reads its Redis password
 * from (`RedisAuth string \`envconfig:"REDIS_AUTH"\``). Also the Secret key, so
 * the two can never drift.
 */
const RATE_LIMIT_REDIS_AUTH_KEY = "REDIS_AUTH"; // pragma: allowlist secret (env var name, not a credential)

/**
 * The `EnvoyGateway` config fragment that turns on global rate limiting
 * (ADR-0040 layer L1).
 *
 * Without this the `BackendTrafficPolicy` rules in `app/httproutes.ts` are inert
 * — Envoy Gateway accepts them and the rate limit service they need is simply
 * not deployed. The two must move together, which is why the same
 * `cfg.rateLimit.enabled` flag gates both.
 *
 * `backend.type: Redis` names the DEDICATED counter store, never the ADR-0020
 * cache (`data/dragonfly.ts` explains why at length). The store lives in the
 * app namespace while the rate limit service runs here in
 * `envoy-gateway-system`, so this crosses a namespace boundary — and `grid` is
 * default-deny for ingress, so `platform/network-policies.ts` carries the allow
 * that makes this address reachable. Miss that rule and every lookup fails; the
 * fail-open default then means the limits silently do nothing.
 *
 * **The password does not go in `redis.url`.** `RateLimitRedisSettings` has
 * exactly three fields — `url`, `urlRef` and `tls` — and no password member;
 * Envoy Gateway renders `url` verbatim into the rate limit Deployment's
 * `REDIS_URL`, which the upstream `envoyproxy/ratelimit` service uses as a bare
 * `host:port` dial address, not as a URI. A `redis://:pw@host` there would be
 * parsed as a hostname. The password instead reaches the same container as
 * `REDIS_AUTH` (`envconfig:"REDIS_AUTH"`), injected through
 * `provider.kubernetes.rateLimitDeployment.container.env` — the one supported
 * seam for extra env on that generated Deployment.
 *
 * Getting this wrong is FAIL-OPEN, not an outage: an AUTH failure makes the
 * rate limit service error, and `failClosed` is false, so traffic flows
 * unlimited while the ADR-0029 pane shows the errors. Worth knowing when
 * reading a "limits stopped enforcing" report.
 */
function rateLimitConfig(cfg: GridConfig, withRedisAuth: boolean): Record<string, unknown> {
  return {
    rateLimit: {
      backend: {
        type: "Redis",
        redis: { url: `${EDGE_RATE_LIMIT.storeService}.${cfg.namespace}.svc.cluster.local:6379` },
      },
      // Fail open: a counter-store blip must degrade to "not limited", never to
      // "down". See the knob's comment for when to reconsider.
      failClosed: cfg.rateLimit.failClosed,
      // Short — this sits in front of every request.
      timeout: EDGE_RATE_LIMIT.timeout,
    },
    ...(withRedisAuth
      ? {
          provider: {
            type: "Kubernetes",
            kubernetes: {
              rateLimitDeployment: {
                container: {
                  env: [
                    {
                      name: RATE_LIMIT_REDIS_AUTH_KEY,
                      valueFrom: {
                        secretKeyRef: {
                          name: RATE_LIMIT_REDIS_AUTH_SECRET,
                          key: RATE_LIMIT_REDIS_AUTH_KEY,
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        }
      : {}),
  };
}

/**
 * GatewayClass `eg` (bound to the Envoy Gateway controller) + the Gateway with
 * an HTTP :80 listener (ACME HTTP-01 challenge) and per-host HTTPS :443
 * listeners for appDomain, s3Domain and the landing site (webDomain). TLS is
 * provisioned by cert-manager's Gateway shim: the annotation names the
 * ClusterIssuer, and cert-manager creates a Certificate for each listener's
 * `certificateRefs` secret.
 */
export function installGatewayResources(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  issuerName: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): { gatewayClass: k8s.apiextensions.CustomResource; gateway: k8s.apiextensions.CustomResource } {
  const gatewayClassSpec: IGatewayClassSpec = {
    controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
  };
  const gatewayClass = new k8s.apiextensions.CustomResource(
    "grid-gatewayclass",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: GATEWAY_CLASS, labels: commonLabels("gateway") },
      spec: gatewayClassSpec,
    },
    { provider, dependsOn },
  );

  // Managed-proxy infrastructure: Envoy Gateway defaults the generated Envoy
  // fleet to a SINGLE replica with no PDB — the whole cluster's front door
  // would ride on one pod on one node (a node drain = full outage for both
  // domains). Pin 2 replicas, a PDB, and spread them across nodes.
  //
  // The provider auto-assigns the LoadBalancer's external IP (Cilium) and, when
  // pinned via `k8s.at/managed-loadbalancer-ip`, keeps/reclaims it across a
  // service re-creation (released IPs stay reserved 14 days). Annotate the
  // generated Envoy Service with it so the DNS A-record target is stable.
  const envoyService = cfg.ingress.loadBalancerIp
    ? { annotations: { "k8s.at/managed-loadbalancer-ip": cfg.ingress.loadBalancerIp } }
    : undefined;
  const envoyProxySpec: IEnvoyProxySpec = {
    provider: {
      type: "Kubernetes",
      kubernetes: {
        ...(envoyService ? { envoyService } : {}),
        envoyDeployment: {
          replicas: 2,
          // Surge-only, one at a time — the same rule every app tier follows
          // (rollout.ts). Without it the generated Deployment inherits
          // `maxUnavailable: 25%`, which on a 2-replica fleet retires one proxy
          // the instant an EnvoyProxy/chart change lands: half the edge capacity
          // (and every connection it terminated) gone before the replacement is
          // serving. That is a user-visible "Connection Failed" on a change that
          // has nothing to do with the app.
          strategy: SURGE_ONLY_STRATEGY,
          // Requests AND limits on the data-plane fleet — the platform's
          // cluster-autoscaler prerequisite applies to the edge pods too.
          container: { resources: PLATFORM_RESOURCES.envoyProxy },
          pod: {
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    podAffinityTerm: {
                      topologyKey: "kubernetes.io/hostname",
                      labelSelector: {
                        matchLabels: { "gateway.envoyproxy.io/owning-gateway-name": GATEWAY_NAME },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        // maxUnavailable (not minAvailable): scales with replica count and can
        // never wedge a provider-initiated drain the way minAvailable can when
        // both replicas land on one node (same policy as scheduling.ts).
        envoyPDB: { maxUnavailable: 1 },
      },
    },
    // Drain open connections on the way out instead of resetting them. Pinned
    // rather than left to the chart's defaults — see EDGE_SHUTDOWN.
    shutdown: EDGE_SHUTDOWN,
  };
  const envoyProxyConfig = new k8s.apiextensions.CustomResource(
    "grid-envoy-proxy-config",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "EnvoyProxy",
      metadata: { name: "grid-envoy-proxy", namespace, labels: commonLabels("gateway") },
      spec: envoyProxySpec,
    },
    { provider, dependsOn },
  );

  const otelListeners: IGatewaySpec["listeners"] = cfg.observability.enabled
    ? [
        {
          name: "https-otel",
          port: 443,
          protocol: "HTTPS",
          hostname: cfg.observability.otelDomain,
          tls: { mode: "Terminate", certificateRefs: [{ name: "grid-otel-tls" }] },
          allowedRoutes: { namespaces: { from: "Same" } },
        },
      ]
    : [];

  // Langfuse UI (ADR-0044) — same arrangement as the Aspire listener above, and
  // absent for the same reason when the tier is off: no hostname to serve, and
  // an annotated Gateway would have cert-manager chasing a certificate for a
  // host with no backing Service.
  const langfuseListeners: IGatewaySpec["listeners"] = cfg.langfuse.enabled
    ? [
        {
          name: LANGFUSE.listenerName,
          port: 443,
          protocol: "HTTPS",
          hostname: cfg.langfuse.domain,
          tls: { mode: "Terminate", certificateRefs: [{ name: "grid-langfuse-tls" }] },
          allowedRoutes: { namespaces: { from: "Same" } },
        },
      ]
    : [];

  const gatewaySpec: IGatewaySpec = {
    gatewayClassName: GATEWAY_CLASS,
    // Attach the HA proxy-infrastructure config above.
    infrastructure: {
      parametersRef: { group: "gateway.envoyproxy.io", kind: "EnvoyProxy", name: "grid-envoy-proxy" },
    },
    listeners: [
      {
        // Open for the ACME HTTP-01 challenge (cert-manager attaches a temporary
        // HTTPRoute here).
        name: "http",
        port: 80,
        protocol: "HTTP",
        allowedRoutes: { namespaces: { from: "Same" } },
      },
      {
        name: "https-app",
        port: 443,
        protocol: "HTTPS",
        hostname: cfg.ingress.appDomain,
        tls: { mode: "Terminate", certificateRefs: [{ name: "grid-app-tls" }] },
        allowedRoutes: { namespaces: { from: "Same" } },
      },
      {
        name: "https-s3",
        port: 443,
        protocol: "HTTPS",
        hostname: cfg.ingress.s3Domain,
        tls: { mode: "Terminate", certificateRefs: [{ name: "grid-s3-tls" }] },
        allowedRoutes: { namespaces: { from: "Same" } },
      },
      {
        // Landing site (frontends/web) — apex host (e.g. dev.piloti.at).
        name: "https-web",
        port: 443,
        protocol: "HTTPS",
        hostname: cfg.ingress.webDomain,
        tls: { mode: "Terminate", certificateRefs: [{ name: "grid-web-tls" }] },
        allowedRoutes: { namespaces: { from: "Same" } },
      },
      // Aspire dashboard UI — only when the observability tier is deployed
      // (ADR-0029). Otherwise there is no hostname to serve and cert-manager
      // would chase a certificate for a host with no backing Service.
      ...otelListeners,
      // Langfuse UI — only when that tier is deployed (ADR-0044).
      ...langfuseListeners,
    ],
  };
  const gateway = new k8s.apiextensions.CustomResource(
    "grid-gateway",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "Gateway",
      metadata: {
        name: GATEWAY_NAME,
        namespace,
        labels: commonLabels("gateway"),
        annotations: { "cert-manager.io/cluster-issuer": issuerName } as { [k: string]: pulumi.Input<string> },
      },
      spec: gatewaySpec,
    },
    { provider, dependsOn: [gatewayClass, envoyProxyConfig] },
  );

  // Long-lived WebSocket chat upgrades. `streamIdleTimeout` is the per-stream
  // idle timer that actually governs an open-but-idle WS (Envoy default ~5min),
  // the one that would otherwise sever a quiet chat mid-session; `idleTimeout`
  // is the connection-level timer and never fires while a stream is active, but
  // keep it raised too for consistency.
  const clientTrafficPolicySpec: IClientTrafficPolicySpec = {
    targetRefs: [{ group: "gateway.networking.k8s.io", kind: "Gateway", name: GATEWAY_NAME }],
    timeout: { http: { idleTimeout: EDGE_TIMEOUT, streamIdleTimeout: EDGE_TIMEOUT } },
    // ── ADR-0040 layer L0 ──
    //
    // Client-IP detection FIRST, because everything per-IP rests on it: the edge
    // rate limit rules (`app/httproutes.ts`), the WS-upgrade limiter in
    // `server.js`, and any access log anyone ever reads. Leaving it unset does
    // not disable per-IP limiting — it silently redefines "client" as whatever
    // address Envoy's downstream connection carries. If a SNATing load balancer
    // sits in front, that is ONE address for the entire internet, and a limit
    // meant as "30 per client" becomes "30 for everybody" with nothing to show
    // for it but a fail-open counter.
    //
    // `numTrustedHops: 0` (the default) keeps Envoy's own downstream address,
    // which is correct when the LoadBalancer preserves the source IP. The knob
    // exists so a stack that sits behind a proxy can say so. Confirm against a
    // live cluster before believing any per-IP number.
    clientIPDetection: { xForwardedFor: { numTrustedHops: cfg.ingress.xffNumTrustedHops } },
    // A blunt backstop under the request-rate limits: bounds file descriptors
    // and memory when a client opens connections it never drives. 0 disables.
    ...(cfg.ingress.maxConnectionsPerProxy > 0
      ? {
          connection: {
            connectionLimit: {
              value: cfg.ingress.maxConnectionsPerProxy,
              // Delay the close a touch so a burst of rejects cannot become a
              // tight accept/close loop against the proxy.
              closeDelay: "1s",
            },
          },
        }
      : {}),
  };
  new k8s.apiextensions.CustomResource(
    "grid-client-traffic-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "ClientTrafficPolicy",
      metadata: { name: "grid-ws-timeouts", namespace, labels: commonLabels("gateway") },
      spec: clientTrafficPolicySpec,
    },
    { provider, dependsOn: gateway },
  );

  return { gatewayClass, gateway };
}

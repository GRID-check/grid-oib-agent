import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
// CRD-generated compile-time schemas (@kubernetes-models/*, generated from the
// upstream CRDs). `import type` only — erased at runtime, so the deploy-time
// footprint is unchanged; but every spec below is checked field-by-field
// against the real Gateway API / Envoy Gateway schemas by `tsc`.
import type { IGatewaySpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/GatewaySpec";
import type { IGatewayClassSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/GatewayClassSpec";
import type { IEnvoyProxySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/EnvoyProxySpec";
import type { IClientTrafficPolicySpec } from "@kubernetes-models/envoy-gateway/gateway.envoyproxy.io/v1alpha1/ClientTrafficPolicySpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";

/** Stable names referenced by the cert-manager solver and the HTTPRoutes. */
export const GATEWAY_NAME = "grid-gateway";
export const GATEWAY_CLASS = "eg";
/** cert-manager needs the Gateway's namespace for its HTTP-01 solver parentRef. */

/**
 * Edge on the **Gateway API** (not the legacy Ingress API, and not the retired
 * ingress-nginx). Implementation: **Envoy Gateway** (CNCF, Gateway-API native).
 *
 * Split into two steps because of ordering: the controller ships the Gateway
 * API CRDs, which cert-manager must see at startup to enable its Gateway
 * integration. So install the controller FIRST, then cert-manager, then the
 * Gateway/GatewayClass resources.
 */
export function installGatewayController(provider: k8s.Provider): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace(
    "envoy-gateway-ns",
    { metadata: { name: "envoy-gateway-system" } },
    { provider },
  );

  return new k8s.helm.v3.Release(
    "envoy-gateway",
    {
      chart: "oci://docker.io/envoyproxy/gateway-helm",
      version: "v1.2.4",
      namespace: ns.metadata.name,
      // The chart installs the Gateway API standard-channel CRDs + controller
      // by default (crds.gatewayAPI.enabled=true). DO NOT override `values.crds`
      // or set `skipAwait`: cert-manager (installed next with enableGatewayAPI)
      // hard-fails at startup if the Gateway API CRDs aren't Established first,
      // and the default release-await is what guarantees that ordering.
      values: {},
    },
    { provider, dependsOn: ns },
  );
}

/**
 * GatewayClass `eg` (bound to the Envoy Gateway controller) + the Gateway with
 * an HTTP :80 listener (ACME HTTP-01 challenge) and per-host HTTPS :443
 * listeners for appDomain + s3Domain. TLS is provisioned by cert-manager's
 * Gateway shim: the annotation names the ClusterIssuer, and cert-manager
 * creates a Certificate for each listener's `certificateRefs` secret.
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
  const envoyProxySpec: IEnvoyProxySpec = {
    provider: {
      type: "Kubernetes",
      kubernetes: {
        envoyDeployment: {
          replicas: 2,
          pod: {
            affinity: {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    weight: 100,
                    podAffinityTerm: {
                      topologyKey: "kubernetes.io/hostname",
                      labelSelector: {
                        matchLabels: {
                          "gateway.envoyproxy.io/owning-gateway-name": GATEWAY_NAME,
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        envoyPDB: { minAvailable: 1 },
      },
    },
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

  const gatewaySpec: IGatewaySpec = {
    gatewayClassName: GATEWAY_CLASS,
    // Attach the HA proxy-infrastructure config above.
    infrastructure: {
      parametersRef: {
        group: "gateway.envoyproxy.io",
        kind: "EnvoyProxy",
        name: "grid-envoy-proxy",
      },
    },
    listeners: [
      {
        // Open for the ACME HTTP-01 challenge (cert-manager attaches a
        // temporary HTTPRoute here).
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
        annotations: { "cert-manager.io/cluster-issuer": issuerName } as {
          [k: string]: pulumi.Input<string>;
        },
      },
      spec: gatewaySpec,
    },
    { provider, dependsOn: [gatewayClass, envoyProxyConfig] },
  );

  // Long-lived WebSocket chat upgrades: Envoy's default connection idle
  // timeout would sever hour-long chat streams mid-response. Mirror the 3600s
  // read/idle budget the compose/Traefik edges give the app.
  const clientTrafficPolicySpec: IClientTrafficPolicySpec = {
    targetRefs: [
      { group: "gateway.networking.k8s.io", kind: "Gateway", name: GATEWAY_NAME },
    ],
    timeout: { http: { idleTimeout: "3600s" } },
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

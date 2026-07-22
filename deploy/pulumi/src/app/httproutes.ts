import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
// Strongly-typed CRD classes generated from the exact deployed CRDs (see
// src/platform/gateway.ts).
import * as crds from "../../crds";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { GATEWAY_NAME } from "../platform/gateway";

/**
 * Gateway API HTTPRoutes (replacing the legacy Ingress resources):
 *   - appDomain → frontend:3000 (UI + BFF + WebSocket chat upgrades)
 *   - s3Domain  → seaweedfs:8333 (browser presigned preview/download URLs)
 *
 * Each route attaches to its dedicated HTTPS listener on the shared Gateway.
 * WebSocket upgrades pass through natively; Envoy Gateway streams large bodies
 * with no request-size cap.
 */
export function installHttpRoutes(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): { app: crds.gateway.v1.HTTPRoute; s3: crds.gateway.v1.HTTPRoute } {
  const app = new crds.gateway.v1.HTTPRoute(
    "grid-app-route",
    {
      metadata: { name: "grid-app", namespace, labels: commonLabels("frontend") },
      spec: {
        parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-app" }],
        hostnames: [cfg.ingress.appDomain],
        rules: [{ backendRefs: [{ name: "frontend", port: 3000 }] }],
      },
    },
    { provider, dependsOn },
  );

  // Envoy's default per-request timeout (15s) would cut long streaming chat
  // responses and WS sessions on the app route. Give upstream requests the same
  // 3600s budget as the client-side policy.
  new crds.gateway.v1alpha1.BackendTrafficPolicy(
    "grid-app-backend-traffic-policy",
    {
      metadata: { name: "grid-app-timeouts", namespace, labels: commonLabels("frontend") },
      spec: {
        targetRefs: [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", name: "grid-app" }],
        timeout: { http: { requestTimeout: "3600s" } },
      },
    },
    { provider, dependsOn: app },
  );

  const s3 = new crds.gateway.v1.HTTPRoute(
    "grid-s3-route",
    {
      metadata: { name: "grid-s3", namespace, labels: commonLabels("seaweedfs") },
      spec: {
        parentRefs: [{ name: GATEWAY_NAME, sectionName: "https-s3" }],
        hostnames: [cfg.ingress.s3Domain],
        rules: [{ backendRefs: [{ name: "seaweedfs", port: 8333 }] }],
      },
    },
    { provider, dependsOn },
  );

  return { app, s3 };
}

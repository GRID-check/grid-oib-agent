import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { GATEWAY_NAME } from "./gateway";

const COMPONENT = "aspire-dashboard";
const DASHBOARD_PORT = 18888;
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;

export interface Observability {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  route: k8s.apiextensions.CustomResource;
  /**
   * Dedicated Secret holding the dashboard's sensitive values:
   *   - `otlp-api-key`         — OTLP ingestion key (dashboard PrimaryApiKey +
   *                              collector exporter header)
   *   - `workos-client-secret` — WorkOS API key as the OIDC client secret
   * Both are referenced via secretKeyRef — never plain env values on a pod
   * spec (visible to anyone with Deployment read RBAC).
   */
  secrets: k8s.core.v1.Secret;
}

/** Secret keys in the observability Secret. */
export const OTLP_API_KEY_SECRET_KEY = "otlp-api-key";
const WORKOS_CLIENT_SECRET_KEY = "workos-client-secret";

/**
 * Deploys the .NET Aspire standalone dashboard as a single-replica Deployment
 * behind the shared Gateway on its own `https-otel` listener.
 *
 * The dashboard is a plain container — no .NET workload or AppHost. It stores
 * telemetry in an in-memory ring buffer (lost on restart). Only the UI
 * (:18888) is exposed via an HTTPRoute; OTLP ingestion (:4317/:4318) is
 * cluster-internal and API-key protected.
 *
 * Auth: WorkOS AuthKit OIDC via the existing WorkOS client (reusing the API key
 * as the OIDC client secret). RequiredClaim gates on org_id = platform org.
 */
export function installObservabilityDashboard(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  otlpApiKey: pulumi.Output<string>,
  workosApiKey: pulumi.Output<string>,
  dependsOn: pulumi.Resource[],
): Observability {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;
  const { observability: obs } = cfg;

  // All sensitive values in one dedicated Secret — referenced via secretKeyRef
  // so they never land on a pod spec as plain values.
  const secrets = new k8s.core.v1.Secret(
    "aspire-dashboard-secrets",
    {
      metadata: { name: "aspire-dashboard-secrets", namespace, labels },
      stringData: {
        [OTLP_API_KEY_SECRET_KEY]: otlpApiKey,
        [WORKOS_CLIENT_SECRET_KEY]: workosApiKey,
      },
    },
    { provider, dependsOn },
  );
  const fromSecret = (key: string): k8s.types.input.core.v1.EnvVarSource => ({
    secretKeyRef: { name: secrets.metadata.name, key },
  });

  // The OIDC client secret for the built-in Aspire OIDC RP is the WorkOS API
  // key (AuthKit uses the API key as the OIDC client secret).
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
                  // UI access — OIDC via WorkOS AuthKit. RP settings live under
                  // Authentication:Schemes:OpenIdConnect (the
                  // Dashboard:Frontend:OpenIdConnect section only carries the
                  // claim gate). WorkOS's OIDC issuer is per-client — there is
                  // NO discovery doc at the api.workos.com root.
                  { name: "Dashboard__Frontend__AuthMode", value: "OpenIdConnect" },
                  {
                    name: "Authentication__Schemes__OpenIdConnect__Authority",
                    value: `https://api.workos.com/user_management/${cfg.auth.workosClientId}`,
                  },
                  { name: "Authentication__Schemes__OpenIdConnect__ClientId", value: cfg.auth.workosClientId },
                  { name: "Authentication__Schemes__OpenIdConnect__ClientSecret", valueFrom: fromSecret(WORKOS_CLIENT_SECRET_KEY) },
                  // Claim gate: only GRID Platform organization members pass.
                  { name: "Dashboard__Frontend__OpenIdConnect__RequiredClaimType", value: "org_id" },
                  { name: "Dashboard__Frontend__OpenIdConnect__RequiredClaimValue", value: obs.platformOrgId },
                  // Public URL for OIDC redirects.
                  { name: "Dashboard__Frontend__PublicUrl", value: `https://${obs.otelDomain}` },
                  // TLS terminates at the Gateway — without this the OIDC
                  // redirect_uri is built as http:// and the callback fails.
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
      metadata: { name: "grid-otel", namespace, labels: commonLabels(COMPONENT) },
      spec: routeSpec,
    },
    { provider, dependsOn: service },
  );

  return { deployment, service, route, secrets };
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import { OTLP_API_KEY_SECRET_KEY } from "./observability";

const COMPONENT = "otel-collector";
const OTLP_GRPC_PORT = 4317;
const OTLP_HTTP_PORT = 4318;
const HEALTH_PORT = 13133;

/** Dashboard Service DNS name + OTLP/HTTP port (same namespace). */
const ASPIRE_OTLP_HTTP = "http://aspire-dashboard:4318";

export interface OtelCollector {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  configMap: k8s.core.v1.ConfigMap;
}

/**
 * Deploys the OpenTelemetry Collector as the cluster's single OTLP ingestion
 * point (ADR-0029 amendment).
 *
 * All telemetry producers (Next.js BFF, aiq-agent, agent-worker) send plain
 * OTLP in-cluster to this Service — no API key on the producers. The collector
 * is the ONLY holder of the Aspire ingestion key and the only client of the
 * dashboard's OTLP ports. It batches, applies memory back-pressure, and
 * carries pipelines for all three signals (traces, logs, metrics) so future
 * signal adoption is app-only work. Swapping the storage/UI backend later
 * (Grafana/Tempo/…) is a config change HERE, not in any app.
 *
 * NetworkPolicy: none needed — same-namespace ingress is already allowed and
 * egress is open by design (see network-policies.ts).
 */
export function installOtelCollector(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  secrets: k8s.core.v1.Secret,  dependsOn: pulumi.Resource[],
): OtelCollector {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;

  // ${env:OTLP_API_KEY} is interpolated by the collector at startup from the
  // container env (secretKeyRef below) — the key never sits in the ConfigMap.
  const collectorConfig = `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:${OTLP_GRPC_PORT}
      http:
        endpoint: 0.0.0.0:${OTLP_HTTP_PORT}

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  batch:
    timeout: 5s
    send_batch_size: 1024

exporters:
  otlp_http/aspire:
    endpoint: ${ASPIRE_OTLP_HTTP}
    # The dashboard's OTLP/HTTP endpoint does not decompress gzip request
    # bodies — it parses the raw body as protobuf, so the gzip magic bytes
    # (0x1f 0x8b) surface as HTTP 500 InvalidProtocolBufferException "tag with
    # an invalid wire type". The exporter default is gzip; force identity.
    compression: none
    headers:
      x-otlp-api-key: \${env:OTLP_API_KEY}

extensions:
  health_check:
    endpoint: 0.0.0.0:${HEALTH_PORT}

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]
`;

  const configMap = new k8s.core.v1.ConfigMap(
    COMPONENT,
    {
      metadata: { name: `${COMPONENT}-config`, namespace, labels },
      data: { "collector.yaml": collectorConfig },
    },
    { provider, dependsOn },
  );

  const deployment = new k8s.apps.v1.Deployment(
    COMPONENT,
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
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            containers: [
              {
                name: "collector",
                image: cfg.observability.collectorImage,
                imagePullPolicy: "IfNotPresent",
                args: ["--config=/etc/otelcol/collector.yaml"],
                ports: [
                  { containerPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
                  { containerPort: OTLP_HTTP_PORT, name: "otlp-http" },
                  { containerPort: HEALTH_PORT, name: "health" },
                ],
                env: [
                  {
                    name: "OTLP_API_KEY",
                    valueFrom: {
                      secretKeyRef: {
                        name: secrets.metadata.name,
                        key: OTLP_API_KEY_SECRET_KEY,
                      },
                    },
                  },
                ],
                volumeMounts: [
                  { name: "config", mountPath: "/etc/otelcol", readOnly: true },
                ],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                readinessProbe: {
                  httpGet: { path: "/", port: HEALTH_PORT },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: HEALTH_PORT },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
            volumes: [
              { name: "config", configMap: { name: configMap.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, configMap, secrets] },
  );

  const service = new k8s.core.v1.Service(
    COMPONENT,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { port: OTLP_GRPC_PORT, targetPort: OTLP_GRPC_PORT, name: "otlp-grpc" },
          { port: OTLP_HTTP_PORT, targetPort: OTLP_HTTP_PORT, name: "otlp-http" },
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { deployment, service, configMap };
}

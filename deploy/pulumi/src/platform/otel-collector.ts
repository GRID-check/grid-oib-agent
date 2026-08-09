import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "./namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  secretChecksum,
  secretChecksumAnnotations,
  surgeRollout,
} from "./rollout";
import { OTLP_API_KEY_SECRET_KEY } from "./observability";
import { ERR2ISSUE_OTLP_HTTP } from "./err2issue";
import {
  LANGFUSE_SECRET_KEYS,
  langfuseOtlpBasicAuth,
  langfuseOtlpTracesEndpoint,
} from "./langfuse";

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
  secrets: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
  /**
   * The Secret carrying Langfuse's precomputed Basic-auth header (ADR-0044),
   * when that tier is deployed. Undefined leaves the collector config
   * byte-identical to what it was before Langfuse existed.
   */
  langfuseSecretName?: pulumi.Input<string>,
): OtelCollector {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;

  // err2issue (ADR-0031) is a SECOND consumer of the logs signal, not a
  // replacement: the dashboard keeps the full live view, err2issue gets only
  // what is worth waking someone for. Both fragments below are empty when the
  // sink is off, so the collector config is byte-identical to before —
  // enabling the sink is the only thing that changes it.
  //
  // The filter drops everything below ERROR *before* the exporter rather than
  // letting err2issue discard it on arrival: the sink only ever acts on ERROR,
  // so forwarding INFO/DEBUG would be pure waste of collector egress, sink CPU
  // and pod memory at exactly the moment a service is noisiest.
  const err2issueExporter = cfg.err2issue.enabled
    ? `
  otlp_http/err2issue:
    endpoint: ${ERR2ISSUE_OTLP_HTTP}
    compression: none`
    : "";
  const err2issueProcessor = cfg.err2issue.enabled
    ? `
  filter/errors_only:
    # A malformed record must not take the pipeline down — the dashboard's
    # copy of this signal is on the other side of the same receiver.
    error_mode: ignore
    # \`log_conditions\` (with the \`log.\` prefix), NOT the older
    # \`logs: log_record:\` nesting: the latter is deprecated as of
    # collector-contrib 0.146 and slated for removal, and this stack pins
    # 0.157. Conditions DROP what they match, so this keeps ERROR and above.
    log_conditions:
      - 'log.severity_number < SEVERITY_NUMBER_ERROR'`
    : "";
  // A separate pipeline, NOT an extra exporter on the existing `logs` one: the
  // severity filter is per-pipeline, so sharing would silently strip
  // sub-ERROR logs from the dashboard too and gut the live view.
  const err2issuePipeline = cfg.err2issue.enabled
    ? `
    logs/err2issue:
      receivers: [otlp]
      processors: [memory_limiter, filter/errors_only, batch]
      exporters: [otlp_http/err2issue]`
    : "";

  // Langfuse (ADR-0044) is a THIRD consumer, and the first one on the traces
  // signal — this is the change ADR-0029 predicted when it wrote that swapping
  // or adding a storage backend "is a config change HERE, not in any app".
  //
  // A second exporter on the EXISTING traces pipeline rather than a pipeline of
  // its own, which is the opposite of the choice made for err2issue one
  // signal down. The difference is the processor chain: err2issue needs a
  // severity filter that must not apply to the dashboard's copy, so it needs
  // its own pipeline. Langfuse wants exactly the spans Aspire wants, so a
  // separate pipeline would duplicate `memory_limiter` and `batch` — two
  // independent memory budgets and two batchers over one input — to produce
  // identical output.
  //
  // Consequence worth stating plainly: exporters on one pipeline share a fate
  // for back-pressure. If Langfuse is slow enough to fill its sending queue,
  // `memory_limiter` sees the pressure and starts refusing, and the dashboard
  // loses spans too. That is accepted for the same reason the tier accepts
  // dropped telemetry generally — neither consumer is in a request path — and
  // it is why the Langfuse exporter gets an explicit, bounded queue below
  // instead of the default.
  const langfuseExporter = cfg.langfuse.enabled
    ? `
  otlp_http/langfuse:
    # \`otlp_http\`, NOT \`otlphttp\`. Both resolve today, so this is easy to
    # "correct" in the wrong direction: upstream renamed the component and
    # \`otlphttp\` is now the DeprecatedType
    # (exporter/otlphttpexporter/internal/metadata/generated_status.go —
    # \`Type = MustNewType("otlp_http")\`, \`DeprecatedType = MustNewType("otlphttp")\`).
    # Matches \`otlp_http/aspire\` below, which is the same component.
    #
    # \`traces_endpoint\`, not \`endpoint\`: the latter would have the exporter
    # append \`/v1/traces\` to a path that already ends in it.
    traces_endpoint: ${langfuseOtlpTracesEndpoint()}
    # Basic base64(pk:sk), precomputed into the Langfuse Secret because the
    # collector cannot base64 two env vars together (see LANGFUSE_SECRET_KEYS).
    headers:
      Authorization: \${env:LANGFUSE_OTLP_AUTH}
    # Langfuse accepts gzip (it is a Next.js route, not the Aspire dashboard's
    # raw-protobuf reader), and unlike the in-cluster hop to the dashboard this
    # one pays for itself: spans carry prompts and completions, which compress
    # roughly an order of magnitude.
    compression: gzip
    # Bounded rather than unlimited. The queue is what keeps a Langfuse restart
    # — a deploy, a node drain — from immediately becoming dropped spans, but
    # an unbounded one would let a long outage grow collector RSS until
    # \`memory_limiter\` starts refusing the dashboard's traffic too.
    sending_queue:
      enabled: true
      queue_size: 2000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 300s`
    : "";
  const langfuseTraceExport = cfg.langfuse.enabled ? ", otlp_http/langfuse" : "";

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
    send_batch_size: 1024${err2issueProcessor}

exporters:${err2issueExporter}${langfuseExporter}
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
      exporters: [otlp_http/aspire${langfuseTraceExport}]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/aspire]${err2issuePipeline}
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
        // Stateless OTLP forwarder — surge so producers always have a collector
        // Service endpoint to export to, even mid-roll.
        ...surgeRollout(ROLLOUT.observability),
        selector: { matchLabels: labels },
        template: {
          metadata: {
            labels,
            // Both of this pod's credentials arrive by `secretKeyRef`, which is
            // read ONCE at container start (rollout.ts §5). Without this the
            // collector keeps presenting a retired key after a rotation while
            // `pulumi up` reports success — and the symptom is the quietest one
            // in the tier: the exporters 401 and telemetry simply stops.
            //
            // The Langfuse half is what made this urgent, but the annotation
            // covers the Aspire key too, which had the same gap.
            annotations: secretChecksumAnnotations(
              secretChecksum({
                "otlp-api-key": cfg.observability.otelPrimaryApiKey,
                ...(cfg.langfuse.enabled ? { "langfuse-otlp-auth": langfuseOtlpBasicAuth(cfg) } : {}),
              }),
            ),
          },
          spec: {
            enableServiceLinks: false,
            // No K8s API access needed — don't hand the pod an API token.
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
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
                  // Present only when Langfuse is deployed. The collector
                  // fails to START on an unresolvable `${env:…}` in its
                  // config, so this env var and the exporter block above are
                  // one decision — both keyed off `cfg.langfuse.enabled`.
                  ...(langfuseSecretName
                    ? [
                        {
                          name: "LANGFUSE_OTLP_AUTH",
                          valueFrom: {
                            secretKeyRef: {
                              name: langfuseSecretName,
                              key: LANGFUSE_SECRET_KEYS.otlpBasicAuth,
                            },
                          },
                        },
                      ]
                    : []),
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

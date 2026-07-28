import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "./namespaces";
import { ROLLOUT, gracefulShutdown, surgeRollout } from "./rollout";

const COMPONENT = "err2issue";

/** err2issue's OTLP/HTTP receive port (fixed by the upstream image). */
export const ERR2ISSUE_OTLP_HTTP_PORT = 4318;

/** Service DNS the collector's `otlp_http/err2issue` exporter targets. */
export const ERR2ISSUE_OTLP_HTTP = `http://${COMPONENT}:${ERR2ISSUE_OTLP_HTTP_PORT}`;

const SECRETS_NAME = "err2issue-secrets"; // pragma: allowlist secret (Secret object name, not a credential)

/** Secret keys in the err2issue Secret. */
const GITHUB_TOKEN_SECRET_KEY = "github-token"; // pragma: allowlist secret (Secret key name, not a credential)
const ANTHROPIC_API_KEY_SECRET_KEY = "anthropic-api-key"; // pragma: allowlist secret (Secret key name, not a credential)

export interface Err2Issue {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  secrets: k8s.core.v1.Secret;
}

/**
 * Deploys err2issue (https://github.com/matthiasbigl/err2issue) — the sink that
 * turns ERROR-severity telemetry into deduplicated GitHub issues (ADR-0031).
 *
 * It is a second consumer hanging off the OTel Collector, not a second
 * ingestion point: producers keep exporting plain OTLP to `otel-collector` and
 * know nothing about this pod. The collector fans the logs signal out to both
 * the Aspire dashboard (live view, in-memory, lost on restart) and here
 * (durable, actionable, one issue per unique fingerprint). Aspire answers
 * "what is happening right now"; err2issue answers "what broke and is anyone
 * on it".
 *
 * Deduplication state lives in GitHub, not in this pod — issue labels are used
 * as a distributed mutex — so a restart loses only the in-memory suppression
 * windows, never the issue↔fingerprint mapping. That is why the pod is
 * stateless (no PVC) and safe to roll.
 *
 * NetworkPolicy: this pod holds a GitHub token that can write issues, and its
 * OTLP receiver authenticates nobody. It is therefore excluded from the
 * wholesale `allow-same-namespace` ingress allow and granted exactly one
 * caller — otel-collector on 4318 — the same treatment the Aspire dashboard
 * gets, for the same reason (see network-policies.ts rules 2 and 9). Without
 * that, any pod in the namespace could file issues into the repo at will.
 *
 * Egress is open by design (see network-policies.ts header), which is what lets
 * this pod reach api.github.com.
 */
export function installErr2Issue(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): Err2Issue {
  const labels = commonLabels(COMPONENT);
  const name = COMPONENT;
  const e2i = cfg.err2issue;

  const secrets = new k8s.core.v1.Secret(
    SECRETS_NAME,
    {
      metadata: { name: SECRETS_NAME, namespace, labels },
      stringData: {
        [GITHUB_TOKEN_SECRET_KEY]: e2i.githubToken,
        // Empty when unset: err2issue falls back to a deterministic
        // rule-based title instead of an AI-written one (see `enrichment` in
        // its README). A blank key is a degraded title, not a broken sink.
        [ANTHROPIC_API_KEY_SECRET_KEY]: e2i.anthropicApiKey,
      },
    },
    { provider, dependsOn },
  );
  const fromSecret = (key: string): k8s.types.input.core.v1.EnvVarSource => ({
    secretKeyRef: { name: secrets.metadata.name, key },
  });

  const env: k8s.types.input.core.v1.EnvVar[] = [
    { name: "E2I_GITHUB_TOKEN", valueFrom: fromSecret(GITHUB_TOKEN_SECRET_KEY) },
    { name: "E2I_ANTHROPIC_API_KEY", valueFrom: fromSecret(ANTHROPIC_API_KEY_SECRET_KEY) },
    // Default destination for anything the route map does not match.
    { name: "E2I_GITHUB_REPO", value: e2i.githubRepo },
    // Suppression caps. These are the blast-radius control: a hot loop in the
    // agent tier emitting thousands of errors a minute must cost a handful of
    // issue writes, not a rate-limited token and an unusable issue tracker.
    { name: "E2I_SUPPRESS_WINDOW_SECONDS", value: String(e2i.suppressWindowSeconds) },
    { name: "E2I_MAX_NEW_FINGERPRINTS_PER_DAY", value: String(e2i.maxNewFingerprintsPerDay) },
    // Drop errors from services with no route rather than dumping them in the
    // fallback repo — an unattributed issue nobody owns is noise.
    { name: "E2I_DROP_UNROUTED", value: String(e2i.dropUnrouted) },
  ];
  if (e2i.routeMap !== "") {
    env.push({ name: "E2I_ROUTE_MAP", value: e2i.routeMap });
  }

  const deployment = new k8s.apps.v1.Deployment(
    COMPONENT,
    {
      metadata: { name, namespace, labels },
      spec: {
        // Single replica on purpose. Correctness does not need a second one —
        // GitHub holds the dedup state — but suppression windows and the daily
        // fingerprint budget are per-pod in-memory counters, so N replicas
        // multiply the effective caps by N. One pod keeps the budget meaning
        // what it says; the sink is not on any user-facing request path, so a
        // few seconds of unavailability mid-roll costs at most a dropped error
        // export, which the collector already treats as best-effort.
        replicas: 1,
        ...surgeRollout(ROLLOUT.observability),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false,
            // No K8s API access needed — don't hand the pod an API token.
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
            containers: [
              {
                name: COMPONENT,
                image: e2i.image,
                // Derived, not hardcoded: the default `:latest` is a MOVING tag
                // and must re-pull on every pod start (policy pack:
                // moving-tag-must-repull), but digest-pinning `err2issueImage`
                // — which prod requires — should flip this to IfNotPresent
                // without anyone remembering to edit it here. Upstream
                // publishes no version tags yet, hence the moving default.
                imagePullPolicy: pullPolicyFor(e2i.image),
                ports: [{ containerPort: ERR2ISSUE_OTLP_HTTP_PORT, name: "otlp-http" }],
                env,
                resources: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                // /readyz also validates config (token present, repo parseable),
                // so a misconfigured deploy fails the rollout instead of coming
                // up healthy and silently dropping every error.
                readinessProbe: {
                  httpGet: { path: "/readyz", port: ERR2ISSUE_OTLP_HTTP_PORT },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: ERR2ISSUE_OTLP_HTTP_PORT },
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

  const service = new k8s.core.v1.Service(
    COMPONENT,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [
          {
            port: ERR2ISSUE_OTLP_HTTP_PORT,
            targetPort: ERR2ISSUE_OTLP_HTTP_PORT,
            name: "otlp-http",
          },
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { deployment, service, secrets };
}

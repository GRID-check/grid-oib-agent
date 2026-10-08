import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  GridConfig,
  appPullPolicy,
  assertHpaTargetIsProportional,
  assertMemoryFitsLimit,
  backendImage,
  toResourceRequirements,
} from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  ROLLOUT,
  assertStartupFitsRollout,
  gracefulShutdown,
  secretChecksumAnnotations,
  startupBudgetSeconds,
  surgeRollout,
} from "../platform/rollout";
import { AppSecrets, AppWiring, apiEnv } from "./config";
import { PORT, UID } from "../constants";

export interface Api {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
}

/** How long the api container may take to start: the workflow it builds is the chat tier's. */
const STARTUP_PERIOD_SECONDS = 10;
const STARTUP_FAILURE_THRESHOLD = 60;

/**
 * The api tier (ADR-0082 step B): `GRID_ROLE=api` of the backend image, every
 * HTTP route the backend serves except the chat socket. It is what
 * `BACKEND_URL` names: the BFF, the housekeeping CronJobs, the purger and the
 * workers' callers all reach it through the `aiq-api` Service.
 *
 * Stateless: a Deployment without a volume, like the worker tiers, behind a
 * Service. Its work is request-bound (knowledge lookups, LLM utilities, job
 * submit and SSE streams), so an HPA scales it on CPU and its rollout never
 * waits on a chat turn: the grace period is sized for closing SSE streams and
 * finishing short requests (`API_DRAIN_SECONDS`), where the chat tier's is its
 * longest turn. The two tiers share an image, a database, the cache and the
 * shared Chroma, and call each other nowhere.
 *
 * The env is the chat tier's less what only chat reads (`apiEnv`).
 */
export function installApi(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): Api {
  const labels = commonLabels("aiq-api");
  const shutdown = gracefulShutdown(ROLLOUT.api, "python");

  // Fail the preview, not production: a CPU request far below steady-state
  // usage turns the HPA below into an on/off switch to maxReplicas.
  assertHpaTargetIsProportional("aiq-api", cfg.api.resources, cfg.api.hpaCpuTargetPercent);
  assertMemoryFitsLimit("aiq-api", cfg.api.resources);
  assertStartupFitsRollout(
    "aiq-api",
    ROLLOUT.api,
    startupBudgetSeconds(STARTUP_PERIOD_SECONDS, STARTUP_FAILURE_THRESHOLD),
  );

  const deployment = new k8s.apps.v1.Deployment(
    "aiq-api",
    {
      metadata: { name: "aiq-api", namespace: w.namespace, labels },
      spec: {
        // Initial size; the HPA owns replica count thereafter.
        replicas: cfg.api.minReplicas,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.api),
        template: {
          metadata: {
            labels,
            // Rotating any credential in `grid-secrets` is a real rolling update
            // (rollout.ts).
            annotations: secretChecksumAnnotations(secrets.checksum),
          },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            // preStop covers EndpointSlice propagation, then uvicorn gets its
            // SIGTERM and the role closes its SSE streams (`drain_owned_work`).
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "aiq-api",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                ports: [{ containerPort: PORT.backend, name: "http" }],
                env: apiEnv(w),
                resources: toResourceRequirements(cfg.api.resources),
                lifecycle: shutdown.lifecycle,
                // Boot builds the NAT workflow and opens Chroma, as the chat
                // tier's does: the same window before liveness kicks in.
                startupProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: STARTUP_PERIOD_SECONDS,
                  failureThreshold: STARTUP_FAILURE_THRESHOLD,
                },
                readinessProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: 15,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: 20,
                  timeoutSeconds: 10,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    {
      provider: w.provider,
      dependsOn: [secrets.secret, ...dependsOn],
      // The HPA owns spec.replicas after creation — don't let `pulumi up` revert
      // an autoscaling decision back to minReplicas.
      ignoreChanges: ["spec.replicas"],
      // A cold first boot is an image pull plus the workflow build; the rollout
      // surges one pod at a time. Stay above progressDeadlineSeconds so the
      // failure the operator sees is Kubernetes' own, not an opaque timeout.
      customTimeouts: { create: "25m", update: "25m" },
    },
  );

  // Load-balanced ClusterIP: what BACKEND_URL names. Every caller is a plain
  // HTTP client, so no per-pod address and no headless Service.
  const service = new k8s.core.v1.Service(
    "aiq-api",
    {
      metadata: { name: "aiq-api", namespace: w.namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.backend, targetPort: PORT.backend, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
    "aiq-api",
    {
      metadata: { name: "aiq-api", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: deployment.metadata.name,
        },
        minReplicas: cfg.api.minReplicas,
        maxReplicas: cfg.api.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: { type: "Utilization", averageUtilization: cfg.api.hpaCpuTargetPercent },
            },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  // Cap voluntary disruptions at one pod so an automatic-upgrade node drain
  // cannot evict every api replica at once.
  const pdb = installPdb("aiq-api", w.namespace, w.provider, labels, [deployment]);

  return { deployment, service, hpa, pdb };
}

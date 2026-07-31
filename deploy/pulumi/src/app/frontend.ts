import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  GridConfig,
  assertHpaTargetIsProportional,
  frontendImage,
  toResourceRequirements,
} from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  ROLLOUT,
  gracefulShutdown,
  secretChecksumAnnotations,
  surgeRollout,
} from "../platform/rollout";
import { AppSecrets, AppWiring, frontendEnv } from "./config";
import { PORT, UID } from "../constants";

export interface Frontend {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
}

/**
 * Frontend: Next.js UI + BFF API routes + the WebSocket gateway (server.js),
 * all in one Node process per pod. Runs HORIZONTALLY: it is stateless once the
 * shared cache (Dragonfly/Redis) is wired — which it is — so an HPA scales it on
 * CPU. Command is overridden to `node server.js`; the image's default also runs
 * `drizzle-kit migrate`, which we deliberately move to the one-shot migration
 * Job to avoid replicas racing on migrations.
 *
 * A chat WS connection pins to whichever pod terminated its upgrade and stays
 * there for its lifetime, so no session affinity is required at the ingress.
 */
export function installFrontend(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): Frontend {
  const labels = commonLabels("frontend");
  const shutdown = gracefulShutdown(ROLLOUT.frontend, "node");

  // Fail the preview, not production: a CPU request far below steady-state
  // usage turns the HPA below into an on/off switch to maxReplicas.
  assertHpaTargetIsProportional(
    "frontend",
    cfg.frontend.resources,
    cfg.frontend.hpaCpuTargetPercent,
  );

  const deployment = new k8s.apps.v1.Deployment(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        // Initial size; the HPA owns replica count thereafter.
        replicas: cfg.frontend.minReplicas,
        selector: { matchLabels: labels },
        // Surge-only rolling update + a stability soak + a progress deadline.
        ...surgeRollout(ROLLOUT.frontend),
        template: {
          metadata: {
            labels,
            // Rotating any credential in `grid-secrets` changes this annotation,
            // which is what turns the rotation into an actual rolling update
            // instead of a Secret nobody re-reads (rollout.ts).
            annotations: secretChecksumAnnotations(secrets.checksum),
          },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            // Keep serving after SIGTERM: preStop covers EndpointSlice
            // propagation at the gateway, then server.js drains in-flight
            // requests and WebSockets (GRID_SHUTDOWN_DRAIN_MS).
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            // The frontend image runs as non-root UID 1001; make it explicit so
            // the pod is Pod-Security "restricted"-ready.
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            // Spread replicas across worker nodes so a single node loss (or the
            // provider's automatic upgrade node-replacement) never drops the
            // whole frontend tier. Soft (ScheduleAnyway) — never blocks a deploy.
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "frontend",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                // Skip the image's built-in migrate; the Job owns migrations.
                command: ["node", "server.js"],
                ports: [{ containerPort: PORT.frontend, name: "http" }],
                env: frontendEnv(w),
                resources: toResourceRequirements(cfg.frontend.resources),
                lifecycle: shutdown.lifecycle,
                readinessProbe: {
                  httpGet: { path: "/api/healthz", port: PORT.frontend },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/api/healthz", port: PORT.frontend },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                  failureThreshold: 5,
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
      // Surge-only rolling of up to `frontendMaxReplicas` pods, each soaking for
      // minReadySeconds and draining for up to a full grace period, comfortably
      // exceeds Pulumi's default 10m await. Keep this above
      // progressDeadlineSeconds so the failure the operator sees is Kubernetes'
      // real "ProgressDeadlineExceeded" reason, not an opaque Pulumi timeout.
      customTimeouts: { create: "20m", update: "20m" },
    },
  );

  const service = new k8s.core.v1.Service(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.frontend, targetPort: PORT.frontend, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: deployment.metadata.name,
        },
        minReplicas: cfg.frontend.minReplicas,
        maxReplicas: cfg.frontend.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: cfg.frontend.hpaCpuTargetPercent,
              },
            },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  // Cap voluntary disruptions at one pod so an automatic-upgrade node drain
  // can't evict every frontend replica simultaneously.
  const pdb = installPdb("frontend", w.namespace, w.provider, labels, [deployment]);

  return { deployment, service, hpa, pdb };
}

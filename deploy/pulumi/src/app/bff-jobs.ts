import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, frontendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { agentWorkerRollout, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, SECRET_NAME, bffJobsEnv } from "./config";
import { PORT, UID } from "../constants";

/** The durable queue the pool drains (`frontends/ui/drizzle/0102_bff_job_queue.sql`). */
const QUEUE_TABLE = "bff_job_queue";

/**
 * KEDA's measure of the pool's work: every job a worker could still run or is
 * running. Dead rows are the one status left out: a job that failed every
 * attempt waits for an operator, and counting it would hold a replica up
 * forever for work nothing will ever claim. (The ingest tier's table has no
 * dead rows yet, so its query counts everything.)
 */
export const BFF_QUEUE_DEPTH_QUERY = `SELECT COUNT(*) FROM ${QUEUE_TABLE} WHERE status <> 'dead'`;

/** Seconds a pod gets, after its drain, to stop the BFF it supervises and exit. */
const EXIT_SLACK_SECONDS = 30;

/**
 * The BFF's background pool (ADR-0078): replicas of the FRONTEND image that run
 * `workers/jobs/index.js`. Each is a supervisor around two things: the BFF
 * itself (`node server.js`) and a claim loop that takes jobs from
 * `bff_job_queue`, fairly across organizations (fewest running first,
 * fleet-wide), and has that BFF run them a bounded slice at a time. So the heavy
 * work lands here, never on the user-facing frontend pods that proxy chat.
 *
 * INTERNAL ONLY. No Service and no HTTPRoute: nothing routes to these pods, and
 * the one caller of their BFF is the claim loop on the pod's own loopback
 * (`bff-jobs.spec.ts` asserts both). The intra-namespace network policy is
 * therefore not a surface here, and the internal route is token-guarded anyway.
 *
 * One container, not a BFF and a sidecar, because shutdown has an order: on
 * SIGTERM the loop stops claiming, lets the slice in hand finish, gives each
 * claim back WITHOUT spending an attempt (the next worker resumes from the
 * progress it saved), and only then stops the BFF. Two containers would be
 * signalled together and the BFF would vanish under the slice still using it.
 *
 * SCALED ON THE QUEUE, NOT ON CPU: KEDA counts the open jobs and asks for
 * ceil(depth / concurrency) replicas between `minReplicas` and `maxReplicas`. A
 * lane is one organization, so a burst from one office fans out across the
 * pool and a lone job from another still takes the next free slot.
 *
 * Rollout and grace follow the other queue pools (`agentWorkerRollout`): surge
 * first, then each draining pod gets its drain budget plus slack to exit.
 */
export function installBffJobs(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): {
  deployment: k8s.apps.v1.Deployment;
  scaledObject: k8s.apiextensions.CustomResource;
  pdb: k8s.policy.v1.PodDisruptionBudget;
} {
  const labels = commonLabels("bff-jobs");
  // The grace period is the drain budget (the runner's) plus the time to stop
  // the BFF after it.
  const profile = agentWorkerRollout(cfg.bffJobs.drainSeconds + EXIT_SLACK_SECONDS);
  const shutdown = gracefulShutdown(profile);

  const deployment = new k8s.apps.v1.Deployment(
    "bff-jobs",
    {
      metadata: { name: "bff-jobs", namespace: w.namespace, labels },
      spec: {
        replicas: Math.max(1, cfg.bffJobs.minReplicas),
        selector: { matchLabels: labels },
        ...surgeRollout(profile),
        template: {
          metadata: { labels, annotations: secretChecksumAnnotations(secrets.checksum) },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "bff-jobs",
                image: frontendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                // Not `node server.js`: this supervises it (and skips the
                // image's migrate step, which the migration Job owns).
                command: ["node", "workers/jobs/index.js"],
                // Named for the probes only. Nothing routes to it: there is no
                // Service, and the runner reaches the BFF on 127.0.0.1.
                ports: [{ containerPort: PORT.frontend, name: "http" }],
                env: bffJobsEnv(w),
                resources: toResourceRequirements(cfg.bffJobs.resources),
                // The supervisor exits when the BFF does, so a dead BFF is a
                // restarted pod; these catch one that is up but not serving.
                startupProbe: {
                  httpGet: { path: "/api/healthz", port: PORT.frontend },
                  periodSeconds: 5,
                  failureThreshold: 36,
                },
                readinessProbe: {
                  httpGet: { path: "/api/healthz", port: PORT.frontend },
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/api/healthz", port: PORT.frontend },
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
      // KEDA owns the replica count once the ScaledObject exists.
      ignoreChanges: ["spec.replicas"],
      customTimeouts: {
        create: `${Math.ceil(profile.progressDeadlineSeconds / 60) + 15}m`,
        update: `${Math.ceil(profile.progressDeadlineSeconds / 60) + 15}m`,
      },
    },
  );

  // How KEDA reads the queue: a libpq DSN whose host is the FQDN, because the
  // operator resolves names in its own namespace (`KEDA_BFF_QUEUE_DB_URL`).
  const auth = new k8s.apiextensions.CustomResource(
    "bff-jobs-queue-auth",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "TriggerAuthentication",
      metadata: { name: "bff-jobs-queue-auth", namespace: w.namespace, labels },
      spec: { secretTargetRef: [{ parameter: "connection", name: SECRET_NAME, key: "KEDA_BFF_QUEUE_DB_URL" }] },
    },
    { provider: w.provider, dependsOn },
  );

  const scaledObject = new k8s.apiextensions.CustomResource(
    "bff-jobs",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "ScaledObject",
      metadata: { name: "bff-jobs", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: { name: deployment.metadata.name },
        minReplicaCount: cfg.bffJobs.minReplicas,
        maxReplicaCount: cfg.bffJobs.maxReplicas,
        pollingInterval: 15,
        // Scale-in waits this long after the queue empties, so a burst that
        // arrives in waves does not pay a cold start (Next boot) per wave.
        cooldownPeriod: 300,
        advanced: {
          horizontalPodAutoscalerConfig: {
            behavior: {
              // Out fast (the backlog is real), in slowly and a pod at a time
              // (each one drains for up to `drainSeconds`).
              scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: "Percent", value: 100, periodSeconds: 30 }] },
              scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: "Pods", value: 1, periodSeconds: 60 }] },
            },
          },
        },
        triggers: [
          {
            type: "postgresql",
            metadata: {
              query: BFF_QUEUE_DEPTH_QUERY,
              targetQueryValue: String(cfg.bffJobs.concurrency),
              activationTargetQueryValue: "0",
            },
            authenticationRef: { name: auth.metadata.name },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: [deployment, auth] },
  );

  const pdb = installPdb("bff-jobs", w.namespace, w.provider, labels, [deployment]);
  return { deployment, scaledObject, pdb };
}

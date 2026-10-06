import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, frontendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { agentWorkerRollout, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, BFF_QUEUE_DSN_KEY, SCALER_SECRET_NAME, bffJobsEnv } from "./config";
import { installQueueScaledObject, installTriggerAuth, queueDepthQuery } from "./keda-scaling";
import { PORT, UID } from "../constants";

/** The durable queue the pool drains (`frontends/ui/drizzle/0102_bff_job_queue.sql`). */
export const QUEUE_TABLE = "bff_job_queue";

/**
 * KEDA's measure of the pool's work: every job a worker could still run or is
 * running, dead rows left out (`queueDepthQuery`): a job that failed every
 * attempt waits for an operator, and counting it would hold a replica up forever
 * for work nothing will ever claim.
 */
export const BFF_QUEUE_DEPTH_QUERY = queueDepthQuery(QUEUE_TABLE);

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
  // the BFF after it (`agentWorkerRollout` adds it).
  const profile = agentWorkerRollout(cfg.bffJobs.drainSeconds);
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

  // How KEDA reads the queue: the read-only scaler login's DSN on the app
  // database, from the scaler's own Secret (`buildScalerSecret`).
  const auth = installTriggerAuth(w, {
    name: "bff-jobs-queue-auth",
    parameter: "connection",
    secretName: SCALER_SECRET_NAME,
    key: BFF_QUEUE_DSN_KEY,
    labels,
    dependsOn,
  });

  const scaledObject = installQueueScaledObject(w, {
    name: "bff-jobs",
    deployment,
    labels,
    minReplicas: cfg.bffJobs.minReplicas,
    maxReplicas: cfg.bffJobs.maxReplicas,
    concurrency: cfg.bffJobs.concurrency,
    table: QUEUE_TABLE,
    authName: auth.metadata.name,
    dependsOn: [auth, ...dependsOn],
  });

  const pdb = installPdb("bff-jobs", w.namespace, w.provider, labels, [deployment]);
  return { deployment, scaledObject, pdb };
}

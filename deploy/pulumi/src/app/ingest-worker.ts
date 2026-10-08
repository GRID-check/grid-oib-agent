import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, assertVlmPeakFitsCeiling, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { agentWorkerRollout, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, ingestWorkerEnv } from "./config";
import { JOBS_QUEUE_AUTH } from "./jobs-queue-auth";
import { installQueueScaledObject, queueDepthQuery } from "./keda-scaling";
import { UID } from "../constants";

/** The durable queue the tier drains (`aiq_agent.knowledge.ingest_queue.TABLE`). */
export const QUEUE_TABLE = "ingest_job_queue";

/**
 * KEDA's measure of the tier's work: every job queued or held by a worker, dead
 * rows left out (`queueDepthQuery`). A crashed claim ages out of the table
 * through the reaper.
 */
export const QUEUE_DEPTH_QUERY = queueDepthQuery(QUEUE_TABLE);

/**
 * The ingestion tier (ADR-0076), the only process that claims ingestion jobs.
 *
 * Replicas of the backend image with `GRID_ROLE=ingest-worker`: no web port, no
 * Dask, no PVC. Each builds the ingestor once and its `concurrency` threads
 * claim jobs from Postgres, fairly across organisations (fewest running first,
 * fleet-wide). Vectors live in the shared Chroma, jobs in Postgres, so a replica
 * is disposable.
 *
 * SCALED ON THE QUEUE, NOT ON CPU. An ingest job mostly waits on the model
 * provider, so CPU says nothing about the backlog. KEDA runs `QUEUE_DEPTH_QUERY`
 * and asks for ceil(depth / concurrency) replicas between `minReplicas` and
 * `maxReplicas`: a thousand-document reindex fans out across the tier, and an
 * empty queue shrinks it back to the floor (zero, if the floor is zero).
 *
 * The ceiling that matters is not this one: replicas × concurrency ×
 * `AIQ_VLM_BATCH_WORKERS` VLM calls are in flight at the peak, all on the shared
 * provider key. `assertVlmPeakFitsCeiling` fails the deploy when that product is
 * more than twice `AIQ_VLM_FLEET_CONCURRENCY` (itself held to the limiter ceilings,
 * the vision model's own included), so `ingestWorkerMaxReplicas` cannot be raised
 * past what the provider budget can feed.
 *
 * Rollout is the research tier's (`agentWorkerRollout`): surge first, then give
 * each draining worker its `drainSeconds` to finish what it claimed, plus time to
 * give back what it did not (`terminationGracePeriodSeconds` is drain + 30 s).
 * The ScaledObject is the shared queue one (`keda-scaling.ts`).
 */
export function installIngestWorker(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): {
  deployment: k8s.apps.v1.Deployment;
  scaledObject: k8s.apiextensions.CustomResource;
  pdb: k8s.policy.v1.PodDisruptionBudget;
} {
  assertVlmPeakFitsCeiling(cfg);
  const labels = commonLabels("ingest-worker");
  const profile = agentWorkerRollout(cfg.ingestWorker.drainSeconds);
  const shutdown = gracefulShutdown(profile);
  const liveness = "/tmp/ingest-worker.alive";

  const deployment = new k8s.apps.v1.Deployment(
    "ingest-worker",
    {
      metadata: { name: "ingest-worker", namespace: w.namespace, labels },
      spec: {
        replicas: Math.max(1, cfg.ingestWorker.minReplicas),
        selector: { matchLabels: labels },
        ...surgeRollout(profile),
        template: {
          metadata: { labels, annotations: secretChecksumAnnotations(secrets.checksum) },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "ingest-worker",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                env: ingestWorkerEnv(w, liveness),
                resources: toResourceRequirements(cfg.ingestWorker.resources),
                // The worker touches the marker every 15 s while its loop runs;
                // python, because the image has no procps (see agent-worker.ts).
                livenessProbe: {
                  exec: {
                    command: [
                      "python",
                      "-c",
                      `import os,sys,time; f='${liveness}'; ` +
                        "sys.exit(0 if os.path.exists(f) and time.time()-os.path.getmtime(f) < 120 else 1)",
                    ],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  failureThreshold: 3,
                },
                // The first mark appears only after the whole NAT workflow is
                // built; hold liveness off until then (up to 10 minutes).
                startupProbe: {
                  exec: { command: ["python", "-c", `import os,sys; sys.exit(0 if os.path.exists('${liveness}') else 1)`] },
                  periodSeconds: 10,
                  failureThreshold: 60,
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

  const scaledObject = installQueueScaledObject(w, {
    name: "ingest-worker",
    deployment,
    labels,
    minReplicas: cfg.ingestWorker.minReplicas,
    maxReplicas: cfg.ingestWorker.maxReplicas,
    concurrency: cfg.ingestWorker.concurrency,
    table: QUEUE_TABLE,
    // The shared TriggerAuthentication (`jobs-queue-auth.ts`), created once for
    // both Python claim queues and passed in through `dependsOn`.
    authName: JOBS_QUEUE_AUTH,
    dependsOn,
  });

  const pdb = installPdb("ingest-worker", w.namespace, w.provider, labels, [deployment]);
  return { deployment, scaledObject, pdb };
}

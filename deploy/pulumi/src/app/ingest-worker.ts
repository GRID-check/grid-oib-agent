import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { agentWorkerRollout, gracefulShutdown, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { AppSecrets, AppWiring, SECRET_NAME, ingestWorkerEnv } from "./config";
import { UID } from "../constants";

/** The durable queue the tier drains (`aiq_agent.knowledge.ingest_queue.TABLE`). */
const QUEUE_TABLE = "ingest_job_queue";

/** The status of a row the queue gave up on (`aiq_agent.common.claim_queue.DEAD`). */
const DEAD_STATUS = "dead";

/**
 * KEDA's measure of the tier's work: every job queued or held by a worker.
 * Counting claimed jobs too keeps the tier from scaling in underneath the jobs
 * it is running; a crashed claim ages out of the table through the reaper.
 *
 * A DEAD row is kept as the trace of a job that failed every claim, and is
 * never work: counting it would hold replicas up for a job nobody will run.
 */
export const QUEUE_DEPTH_QUERY = `SELECT COUNT(*) FROM ${QUEUE_TABLE} WHERE status <> '${DEAD_STATUS}'`;

/**
 * The ingestion tier (ADR-0076) — only deployed with `jobExecution = "db"`.
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
 * provider key. Raise `ingestWorkerMaxReplicas` with that product in mind.
 *
 * Rollout is the research tier's (`agentWorkerRollout`): surge first, then give
 * each draining worker its `drainSeconds` to finish what it claimed.
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

  // How KEDA reads the queue: a libpq DSN whose host is the FQDN, because the
  // operator resolves names in its own namespace (`KEDA_INGEST_QUEUE_DB_URL`).
  const auth = new k8s.apiextensions.CustomResource(
    "ingest-queue-auth",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "TriggerAuthentication",
      metadata: { name: "ingest-queue-auth", namespace: w.namespace, labels },
      spec: { secretTargetRef: [{ parameter: "connection", name: SECRET_NAME, key: "KEDA_INGEST_QUEUE_DB_URL" }] },
    },
    { provider: w.provider, dependsOn },
  );

  const scaledObject = new k8s.apiextensions.CustomResource(
    "ingest-worker",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "ScaledObject",
      metadata: { name: "ingest-worker", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: { name: deployment.metadata.name },
        minReplicaCount: cfg.ingestWorker.minReplicas,
        maxReplicaCount: cfg.ingestWorker.maxReplicas,
        pollingInterval: 15,
        // Scale-in waits this long after the queue empties, so a burst that
        // arrives in waves does not pay a cold start (NAT build) per wave.
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
              query: QUEUE_DEPTH_QUERY,
              targetQueryValue: String(cfg.ingestWorker.concurrency),
              activationTargetQueryValue: "0",
            },
            authenticationRef: { name: auth.metadata.name },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: [deployment, auth] },
  );

  const pdb = installPdb("ingest-worker", w.namespace, w.provider, labels, [deployment]);
  return { deployment, scaledObject, pdb };
}

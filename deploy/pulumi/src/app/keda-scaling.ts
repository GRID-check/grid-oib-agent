import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { AppWiring } from "./config";

/**
 * What every ScaledObject in the program has in common (ADR-0078), so the four
 * tiers KEDA scales (`ingest-worker`, `agent-worker`, `bff-jobs`, `aiq-agent`)
 * cannot drift apart in the parts that are not about their own signal: how often
 * it polls, how it scales in, what it does when its trigger cannot be read, and
 * how it authenticates.
 *
 * The three queue tiers differ only in the table they count, the Deployment they
 * move and the jobs one replica takes, so {@link installQueueScaledObject} takes
 * exactly those. The chat tier's trigger is not a queue and it carries a cpu
 * trigger beside it, so it builds its own spec and shares the pieces below.
 */

/** Seconds between two polls of a trigger. */
export const SCALER_POLLING_SECONDS = 15;

/**
 * Consecutive failed polls after which KEDA stops trusting a trigger and holds
 * the tier at its fallback count. Three polls is 45 s: a restart of Postgres or a
 * rotated scaler password is not a fallback, a dead scaler is.
 */
export const SCALER_FALLBACK_FAILURES = 3;

/**
 * KEDA's `cooldownPeriod`. It governs ONE step only: how long after the last
 * active trigger a tier is held before it is taken from 1 replica to 0, so it
 * does nothing where `minReplicas` is 1 (prod). Every step from N down to 1 is
 * the HPA's, and `QUEUE_SCALE_BEHAVIOR.scaleDown` is what slows it. It is long so
 * that a burst arriving in waves does not pay a cold start (a NAT build, a Next
 * boot) per wave.
 */
export const SCALER_COOLDOWN_SECONDS = 300;

/** The status of a row a queue gave up on (`aiq_agent.common.claim_queue.DEAD`, `bff_job_queue`). */
export const DEAD_STATUS = "dead";

/**
 * KEDA's measure of a claim queue's work: every row a worker could still run or
 * is running. Counting claimed rows keeps a tier from scaling in underneath the
 * jobs it is running. A DEAD row is kept as the trace of a job that failed every
 * claim and is never work: counting it would hold replicas up for a job nobody
 * will run. A finished job's row is deleted, so it needs no clause.
 */
export function queueDepthQuery(table: string): string {
  return `SELECT COUNT(*) FROM ${table} WHERE status <> '${DEAD_STATUS}'`;
}

/**
 * Out fast (the backlog is real), in slowly and a pod at a time: each pod that
 * leaves drains for up to its tier's `drainSeconds`.
 */
export const QUEUE_SCALE_BEHAVIOR = {
  scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: "Percent", value: 100, periodSeconds: 30 }] },
  scaleDown: { stabilizationWindowSeconds: 300, policies: [{ type: "Pods", value: 1, periodSeconds: 60 }] },
} as const;

/**
 * The count a queue tier is held at while it cannot see its queue: a third of its
 * ceiling, never below its floor or one replica, never above the ceiling. Blind,
 * the backlog is unknown. The floor is too few for a backlog that built up
 * unseen; the ceiling is the whole bill and the provider key's load for a queue
 * that may be empty, so a third is a tier that keeps working and does not run
 * away.
 */
export function fallbackReplicas(minReplicas: number, maxReplicas: number): number {
  return Math.min(maxReplicas, Math.max(1, minReplicas, Math.ceil(maxReplicas / 3)));
}

/**
 * The `fallback` block of a ScaledObject whose triggers KEDA can fall back on.
 *
 * `currentReplicasIfHigher`, not the default `static`: a tier that is already
 * above the fallback count when the trigger goes blind keeps its replicas rather
 * than being scaled down underneath the jobs it is running, and one below it is
 * raised to it.
 *
 * KEDA honours `fallback` only for AverageValue triggers and refuses it beside a
 * `cpu` trigger, which is why the chat tier has none (`backend-scaling.ts`).
 */
export function scalerFallback(minReplicas: number, maxReplicas: number) {
  return {
    failureThreshold: SCALER_FALLBACK_FAILURES,
    replicas: fallbackReplicas(minReplicas, maxReplicas),
    behavior: "currentReplicasIfHigher",
  } as const;
}

/**
 * A TriggerAuthentication that hands one key of a Secret to a trigger as
 * `parameter`. The operator reads the Secret itself, so a rotation reaches it
 * with no pod to restart, and no credential is written into a ScaledObject.
 */
export function installTriggerAuth(
  w: AppWiring,
  opts: {
    name: string;
    /** The trigger parameter the value fills: `connection` (postgresql) or `apiKey` (metrics-api). */
    parameter: "connection" | "apiKey";
    /** The Secret, and its key, that fill it. */
    secretName: string;
    key: string;
    labels: pulumi.Input<Record<string, string>>;
    dependsOn: pulumi.Resource[];
  },
): k8s.apiextensions.CustomResource {
  return new k8s.apiextensions.CustomResource(
    opts.name,
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "TriggerAuthentication",
      metadata: { name: opts.name, namespace: w.namespace, labels: opts.labels },
      spec: { secretTargetRef: [{ parameter: opts.parameter, name: opts.secretName, key: opts.key }] },
    },
    { provider: w.provider, dependsOn: opts.dependsOn },
  );
}

export interface QueueScaledTier {
  /** Name of the ScaledObject; the Deployment it moves has the same name. */
  name: string;
  deployment: k8s.apps.v1.Deployment;
  labels: pulumi.Input<Record<string, string>>;
  minReplicas: number;
  maxReplicas: number;
  /** Jobs one replica runs at once: the trigger's target, so replicas = ceil(depth / concurrency). */
  concurrency: number;
  /** The table the trigger counts (`queueDepthQuery`). */
  table: string;
  /** The TriggerAuthentication carrying the scaler's DSN. */
  authName: pulumi.Input<string>;
  dependsOn: pulumi.Resource[];
}

/**
 * The ScaledObject of a worker pool that claims jobs from a Postgres queue
 * (ADR-0076, ADR-0078): one `postgresql` trigger counting the queue, one replica
 * per `concurrency` open jobs between the tier's floor and ceiling.
 *
 * The Deployment keeps `ignoreChanges: ["spec.replicas"]` at its own definition,
 * because KEDA owns the count once this exists.
 */
export function installQueueScaledObject(w: AppWiring, tier: QueueScaledTier): k8s.apiextensions.CustomResource {
  return new k8s.apiextensions.CustomResource(
    tier.name,
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "ScaledObject",
      metadata: { name: tier.name, namespace: w.namespace, labels: tier.labels },
      spec: {
        scaleTargetRef: { name: tier.deployment.metadata.name },
        minReplicaCount: tier.minReplicas,
        maxReplicaCount: tier.maxReplicas,
        pollingInterval: SCALER_POLLING_SECONDS,
        cooldownPeriod: SCALER_COOLDOWN_SECONDS,
        fallback: scalerFallback(tier.minReplicas, tier.maxReplicas),
        advanced: { horizontalPodAutoscalerConfig: { behavior: QUEUE_SCALE_BEHAVIOR } },
        triggers: [
          {
            type: "postgresql",
            // AverageValue is the type `fallback` requires, and the one that
            // reads as "open jobs per replica"; spelled out because it is a
            // default of the scaler that a version could change.
            metricType: "AverageValue",
            metadata: {
              query: queueDepthQuery(tier.table),
              targetQueryValue: String(tier.concurrency),
              activationTargetQueryValue: "0",
            },
            authenticationRef: { name: tier.authName },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: [tier.deployment, ...tier.dependsOn] },
  );
}

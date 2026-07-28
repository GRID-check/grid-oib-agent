import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createHash } from "node:crypto";

/**
 * Rolling-update safety primitives.
 *
 * `scheduling.ts` keeps a *node drain* from taking a whole tier down. This
 * module covers the other half — what happens on OUR OWN deploys — because a
 * Deployment with default settings does not actually roll safely:
 *
 *  1. **A pod counts as "available" the instant it first passes readiness.** A
 *     container that boots, answers one probe and then dies (bad config, missing
 *     migration, OOM at first real request) is enough for the controller to move
 *     on and take down the next old replica. Without `minReadySeconds` a broken
 *     image walks through the entire fleet before anything notices. With it,
 *     each new replica must stay ready for a fixed window before it counts, so a
 *     crash-on-first-work rollout STALLS after one pod instead of completing.
 *
 *  2. **A rollout that can never finish blocks forever.** `progressDeadlineSeconds`
 *     turns "stuck" into a reported `ProgressDeadlineExceeded` condition, which
 *     is what the Pulumi Kubernetes provider's await logic reads to fail the
 *     `pulumi up` with the real reason instead of an opaque timeout.
 *
 *  3. **SIGTERM and endpoint removal race.** Removing a pod from a Service's
 *     EndpointSlice and telling the kubelet to stop the container are two
 *     independent, concurrent flows. The gateway can still be routing to a pod
 *     that already got SIGTERM — that is the classic "a few 502s on every
 *     deploy". A `preStop` hook that just sleeps holds the container open while
 *     the data plane converges; the SIGTERM only lands after it returns.
 *
 *  4. **The default grace period is 30s.** For anything that drains real work on
 *     SIGTERM (the research worker finishes in-flight jobs, the gateway drains
 *     WebSockets) 30s means SIGKILL mid-flight, on every single deploy.
 *
 *  5. **Rotating a Secret does not restart anything.** Values injected with
 *     `secretKeyRef` are read once, at container start. `pulumi up` after a key
 *     rotation updates the Secret object and reports success while every pod
 *     keeps serving with the old credential — indefinitely. Stamping a checksum
 *     of the Secret's contents onto the pod template turns a rotation into an
 *     ordinary, gated rolling update (see `secretChecksum`).
 *
 * `preStop` uses `exec` rather than the newer `sleep` lifecycle action on
 * purpose: `SleepAction` needs a recent API server, while the interpreter each
 * image already ships is always there (the same reason agent-worker probes with
 * `python -c` — see agent-worker.ts).
 */

/**
 * Pod-template annotation carrying the hash of the shared Secret. Its only job
 * is to change when the Secret's contents change, so the workload controller
 * performs a rolling update instead of silently keeping stale credentials.
 */
export const SECRET_CHECKSUM_ANNOTATION = "grid.bigls.net/secret-checksum"; // pragma: allowlist secret (annotation key name, not a credential)

/** Old ReplicaSets/ControllerRevisions kept for `kubectl rollout undo`. */
export const REVISION_HISTORY_LIMIT = 5;

/**
 * How a single workload rolls. Every number is a deliberate per-tier decision —
 * see `ROLLOUT` for the concrete profiles and their reasoning.
 */
export interface RolloutProfile {
  /** Ready-and-stable window a new replica must survive before it counts. */
  minReadySeconds: number;
  /**
   * Wall-clock budget for the whole rollout before Kubernetes marks it failed.
   * Must exceed image pull + startupProbe budget + `minReadySeconds` for EVERY
   * replica, or a healthy-but-slow deploy reports failure.
   * (Deployments only — StatefulSets have no such field.)
   */
  progressDeadlineSeconds: number;
  /** Hard ceiling on shutdown: preStop + in-process drain + slack. */
  terminationGracePeriodSeconds: number;
  /**
   * preStop sleep that covers EndpointSlice propagation. 0 for workloads behind
   * no Service (they receive no traffic, so there is nothing to deprogram).
   */
  endpointDrainSeconds: number;
}

/**
 * Seconds the frontend gateway keeps serving after SIGTERM before forcing exit
 * (`GRID_SHUTDOWN_DRAIN_MS` in server.js). Chat WebSockets are long-lived, so a
 * hard close on SIGTERM drops every streaming answer in flight on every deploy.
 * Must fit inside the frontend grace period alongside `endpointDrainSeconds`.
 */
export const FRONTEND_DRAIN_SECONDS = 30;

/**
 * The frontend's shutdown budget is spent by three things in sequence: the
 * preStop endpoint drain, then server.js draining requests and WebSockets, then
 * slack for the process to actually exit. If they no longer fit, the pod is
 * SIGKILLed mid-drain — the exact failure this module exists to remove — so the
 * arithmetic is checked at plan time instead of being maintained by comment.
 * (Declared after ROLLOUT below; evaluated at module load.)
 */
function assertFrontendBudgetFits(): void {
  const p = ROLLOUT.frontend;
  const needed = p.endpointDrainSeconds + FRONTEND_DRAIN_SECONDS;
  if (needed >= p.terminationGracePeriodSeconds) {
    throw new Error(
      `Invalid frontend shutdown budget: endpointDrainSeconds (${p.endpointDrainSeconds}) + ` +
        `FRONTEND_DRAIN_SECONDS (${FRONTEND_DRAIN_SECONDS}) = ${needed}s does not fit inside ` +
        `terminationGracePeriodSeconds (${p.terminationGracePeriodSeconds}s). Raise the grace ` +
        `period or shorten the drain.`,
    );
  }
}

/**
 * Per-tier rollout profiles.
 *
 * The invariant to preserve when changing these:
 *   terminationGracePeriodSeconds >= endpointDrainSeconds + in-process drain + slack
 * The grace clock starts when the pod is marked for deletion, i.e. BEFORE the
 * preStop hook runs — so preStop time comes out of the same budget.
 */
export const ROLLOUT = {
  /**
   * Next.js UI + BFF + WebSocket gateway. Surge-only (`maxUnavailable: 0`) so
   * capacity never dips below the current replica count mid-deploy.
   */
  frontend: {
    minReadySeconds: 15,
    // Node boot + Next.js server start is fast; the budget is dominated by
    // rolling `frontendMaxReplicas` pods one at a time with a 15s soak each.
    progressDeadlineSeconds: 900,
    // 10s endpoint drain + 30s WebSocket drain + slack.
    terminationGracePeriodSeconds: 60,
    endpointDrainSeconds: 10,
  },

  /**
   * aiq-agent chat/web tier (StatefulSet). Boot is heavy — multi-GB image, Dask
   * spin-up, Chroma open, optional corpus sync — hence the long grace and the
   * generous startupProbe in backend.ts.
   */
  backend: {
    minReadySeconds: 30,
    progressDeadlineSeconds: 0, // unused: StatefulSets have no progress deadline
    terminationGracePeriodSeconds: 90,
    endpointDrainSeconds: 10,
  },

  /**
   * purger / workflow-scheduler: single-replica poll loops behind no Service.
   * `Recreate` is correct for them (never two at once), so there is no rolling
   * window to protect — only a clean stop between poll ticks.
   */
  lightWorker: {
    minReadySeconds: 10,
    progressDeadlineSeconds: 600,
    terminationGracePeriodSeconds: 30,
    endpointDrainSeconds: 0,
  },

  /**
   * Single-replica data-plane services (Dragonfly, and the Chroma/SeaweedFS
   * StatefulSets). Short soak — they either open their port or they don't.
   */
  dataPlane: {
    minReadySeconds: 10,
    progressDeadlineSeconds: 600,
    terminationGracePeriodSeconds: 60,
    endpointDrainSeconds: 0,
  },

  /** Observability tier (Aspire dashboard, OTel Collector) — stateless, single replica. */
  observability: {
    minReadySeconds: 10,
    progressDeadlineSeconds: 600,
    terminationGracePeriodSeconds: 30,
    endpointDrainSeconds: 0,
  },
} as const satisfies Record<string, RolloutProfile>;

assertFrontendBudgetFits();

/**
 * The research worker's profile is derived, not fixed: its grace period IS the
 * operator's `agentWorkerDrainSeconds` budget. On SIGTERM the worker stops
 * claiming and awaits its in-flight jobs (`jobs/worker.py`), so the grace period
 * is the difference between "a deploy finishes the research a user is waiting
 * on" and "a deploy kills it at the 30s default".
 */
export function agentWorkerRollout(drainSeconds: number): RolloutProfile {
  return {
    minReadySeconds: 30,
    // Worst case the whole tier rolls one pod at a time, each waiting out a full
    // drain, plus a cold-start startupProbe budget (10 min) on the replacement.
    progressDeadlineSeconds: drainSeconds * 2 + 900,
    terminationGracePeriodSeconds: drainSeconds,
    endpointDrainSeconds: 0,
  };
}

/**
 * Deployment `spec` fragment for a SURGE-ONLY rolling update: bring the
 * replacement up and prove it healthy before any old replica goes away
 * (`maxUnavailable: 0`), one at a time (`maxSurge: 1`).
 *
 * This is the setting that makes a deploy a genuine rolling update rather than
 * a staggered restart: with the default `maxUnavailable: 25%` a tier of 2 loses
 * a replica the moment the roll starts, before the new pod is serving.
 */
export function surgeRollout(p: RolloutProfile) {
  return {
    strategy: {
      type: "RollingUpdate",
      rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
    },
    minReadySeconds: p.minReadySeconds,
    progressDeadlineSeconds: p.progressDeadlineSeconds,
    revisionHistoryLimit: REVISION_HISTORY_LIMIT,
  };
}

/**
 * Deployment `spec` fragment for a single-replica worker that must never run
 * twice concurrently (`Recreate`). Still gated: `minReadySeconds` keeps a
 * crash-looping replacement from being reported as a successful deploy.
 */
export function recreateRollout(p: RolloutProfile) {
  return {
    strategy: { type: "Recreate" },
    minReadySeconds: p.minReadySeconds,
    progressDeadlineSeconds: p.progressDeadlineSeconds,
    revisionHistoryLimit: REVISION_HISTORY_LIMIT,
  };
}

/**
 * StatefulSet `spec` fragment. `OrderedReady` + `RollingUpdate` is pinned
 * explicitly rather than left to the defaults: it rolls the highest ordinal
 * first and waits for each pod to be Ready (and now: ready for
 * `minReadySeconds`) before touching the next — exactly the one-at-a-time
 * behaviour the conversation-affinity routing in ADR-0028 depends on.
 */
export function orderedRollout(p: RolloutProfile) {
  return {
    updateStrategy: { type: "RollingUpdate" },
    podManagementPolicy: "OrderedReady",
    minReadySeconds: p.minReadySeconds,
    revisionHistoryLimit: REVISION_HISTORY_LIMIT,
  };
}

/**
 * Pod-`spec` fragment: grace period plus, for Service-backed workloads, the
 * preStop hook that holds the container open while the gateway stops routing to
 * it. `runtime` picks an interpreter the image is guaranteed to have — the app
 * images are debian-slim and ship neither `sleep`-in-a-shell guarantees nor
 * `procps` (see the agent-worker liveness probe for the same constraint).
 */
export function gracefulShutdown(
  p: RolloutProfile,
  runtime?: "node" | "python",
): {
  terminationGracePeriodSeconds: number;
  lifecycle?: k8s.types.input.core.v1.Lifecycle;
} {
  // The grace clock starts when the pod is marked for deletion — BEFORE preStop
  // runs — so preStop time comes out of the same budget. A profile that gets
  // this backwards produces a pod whose hook is still sleeping when SIGKILL
  // arrives: it would never receive SIGTERM at all, and would drain nothing.
  // Fail at plan time rather than shipping that.
  if (p.endpointDrainSeconds >= p.terminationGracePeriodSeconds) {
    throw new Error(
      `Invalid rollout profile: endpointDrainSeconds (${p.endpointDrainSeconds}) must be less ` +
        `than terminationGracePeriodSeconds (${p.terminationGracePeriodSeconds}) — the preStop ` +
        `hook is spent from the same grace budget, so the container would be SIGKILLed before ` +
        `it ever saw SIGTERM.`,
    );
  }
  const base = { terminationGracePeriodSeconds: p.terminationGracePeriodSeconds };
  if (p.endpointDrainSeconds <= 0 || runtime === undefined) return base;
  const command =
    runtime === "node"
      ? ["node", "-e", `setTimeout(() => {}, ${p.endpointDrainSeconds * 1000})`]
      : ["python", "-c", `import time; time.sleep(${p.endpointDrainSeconds})`];
  return { ...base, lifecycle: { preStop: { exec: { command } } } };
}

/**
 * A short, stable hash of every value that goes into the shared Secret.
 *
 * Stamped on each consumer's pod template (`SECRET_CHECKSUM_ANNOTATION`) so that
 * rotating a credential is a real, gated rolling update instead of a silent
 * no-op. Without it, `pulumi config set --secret grid-oib:openrouterApiKey …`
 * followed by `pulumi up` reports success while every pod keeps using the old
 * key until something unrelated happens to restart it.
 *
 * `unsecret` is deliberate: SHA-256 over high-entropy credentials is one-way, so
 * the digest carries no recoverable secret material — and keeping it in
 * plaintext is the entire point, because a `[secret]`-masked annotation would
 * hide the very "this rotation will restart these pods" signal from
 * `pulumi preview`.
 */
export function secretChecksum(
  values: Record<string, pulumi.Input<string>>,
): pulumi.Output<string> {
  return pulumi.unsecret(
    pulumi.output(values).apply((resolved) => {
      const hash = createHash("sha256");
      // Sort so the digest depends on content only, never on key insertion order.
      for (const key of Object.keys(resolved).sort()) {
        hash.update(key).update(" ").update(resolved[key] ?? "").update(" ");
      }
      // 64 bits is far more than enough to distinguish successive rotations, and
      // keeps the annotation readable in `kubectl describe` / plan diffs.
      return hash.digest("hex").slice(0, 16);
    }),
  );
}

/** Pod-template `metadata.annotations` fragment carrying the Secret checksum. */
export function secretChecksumAnnotations(
  checksum: pulumi.Input<string>,
): Record<string, pulumi.Input<string>> {
  return { [SECRET_CHECKSUM_ANNOTATION]: checksum };
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { ROLLOUT, gracefulShutdown, recreateRollout, surgeRollout } from "../platform/rollout";
import { DATA_RESOURCES, EDGE_RATE_LIMIT, PORT } from "../constants";

const DRAGONFLY_IMAGE = "docker.dragonflydb.io/dragonflydb/dragonfly:latest";

export interface Dragonfly {
  service: k8s.core.v1.Service;
  /** redis:// URL other services use as REDIS_URL. */
  url: pulumi.Output<string>;
  /** `host:port` — the form Envoy Gateway's rate limit backend wants. */
  hostPort: pulumi.Output<string>;
}

interface DragonflyOptions {
  /** Resource, Deployment and Service name; also the `app.kubernetes.io/name`. */
  name: string;
  /** `--maxmemory`: caps the dataset, not RSS. */
  maxmemory: string;
  /** Pod memory limit. Must sit ABOVE `maxmemory` (RSS runs higher). */
  memoryLimit: string;
  /**
   * `--cache_mode=true` makes Dragonfly evict under memory pressure instead of
   * refusing writes. Right for a cache, wrong for rate-limit counters — see
   * `installRateLimitStore`.
   */
  cacheMode: boolean;
  /**
   * Replace the pod instead of surging a second one alongside it.
   *
   * A surge briefly puts TWO independent instances behind one Service, and a
   * Service load-balances across both. For a cache that is harmless (a split
   * keyspace costs a few misses). For rate-limit COUNTERS it is not: each
   * instance keeps its own count, so for the length of the rollout a client can
   * spend its budget twice — the limit quietly doubles with nothing to show it.
   * A brief gap is the better failure: no store means the rate limit service
   * errors, which is the documented fail-open path.
   */
  recreateOnRollout?: boolean;
}

/** The shared Deployment+Service shape both instances use. */
function installDragonflyInstance(
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  opts: DragonflyOptions,
): Dragonfly {
  // Dragonfly refuses to boot below 256MiB per proactor thread ("There are 1
  // threads, so 256.00MiB are required. Exiting..."). `--proactor_threads=1`
  // is pinned below, so 256mb is the floor. Catching a bad value here turns a
  // CrashLoopBackOff discovered after `up` into a preview-time error.
  const maxmemoryMatch = /^(\d+)\s*(mb|gb)$/i.exec(opts.maxmemory);
  const maxmemoryMib = maxmemoryMatch
    ? Number(maxmemoryMatch[1]) * (maxmemoryMatch[2].toLowerCase() === "gb" ? 1024 : 1)
    : 0;
  if (maxmemoryMib < 256) {
    throw new Error(
      `${opts.name}: --maxmemory=${opts.maxmemory} is below Dragonfly's 256mb-per-thread boot floor (proactor_threads=1)`,
    );
  }

  const labels = commonLabels(opts.name);

  const deployment = new k8s.apps.v1.Deployment(
    opts.name,
    {
      metadata: { name: opts.name, namespace, labels },
      spec: {
        replicas: 1,
        // The CACHE surges: Recreate would leave a window with no cache at all,
        // while surging only splits the keyspace for a few seconds, and every
        // value there is regenerable. The COUNTER store does the opposite
        // (`recreateOnRollout`), because a split keyspace there means doubled
        // limits rather than a few extra misses.
        ...(opts.recreateOnRollout
          ? recreateRollout(ROLLOUT.dataPlane)
          : surgeRollout(ROLLOUT.dataPlane)),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.dataPlane).terminationGracePeriodSeconds,
            containers: [
              {
                name: "dragonfly",
                // No durable state (regenerable cache / expiring counters) —
                // safe to track latest.
                image: DRAGONFLY_IMAGE,
                // Moving tag ⇒ must re-pull, or a rescheduled pod pins whatever
                // `latest` happened to be cached on that node.
                imagePullPolicy: pullPolicyFor(DRAGONFLY_IMAGE),
                args: [
                  "--logtostderr",
                  // io_uring is denied under many managed-node seccomp profiles
                  // and crashes on boot; epoll is universally available.
                  "--force_epoll",
                  "--proactor_threads=1",
                  `--maxmemory=${opts.maxmemory}`,
                  `--cache_mode=${opts.cacheMode}`,
                  "--dbfilename=",
                ],
                ports: [{ containerPort: PORT.redis, name: "redis" }],
                resources: {
                  requests: DATA_RESOURCES.dragonflyRequests,
                  // Limit sits ABOVE --maxmemory (which caps only the dataset);
                  // RSS overhead above it would otherwise OOMKill the instance.
                  limits: { cpu: DATA_RESOURCES.dragonflyCpuLimit, memory: opts.memoryLimit },
                },
                readinessProbe: {
                  tcpSocket: { port: PORT.redis },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  const service = new k8s.core.v1.Service(
    opts.name,
    {
      metadata: { name: opts.name, namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.redis, targetPort: PORT.redis, name: "redis" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  return {
    service,
    url: pulumi.output(`redis://${opts.name}:${PORT.redis}/0`),
    hostPort: pulumi.output(`${opts.name}:${PORT.redis}`),
  };
}

/**
 * Dragonfly — the Redis-protocol shared cache (ADR-0020). Cache semantics only:
 * every value is reconstructible, so no persistence volume; cache_mode evicts
 * under memory pressure rather than failing writes. Nothing depends on it being
 * healthy — both app tiers fail open to in-process caches — so it must never
 * block a rollout.
 *
 * This shared cache is the precondition for running >1 frontend replica
 * (fixes the per-replica cache-invalidation bug in the scaling review) and for
 * future backend horizontal scaling.
 */
export function installDragonfly(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): Dragonfly {
  return installDragonflyInstance(provider, namespace, {
    name: "dragonfly",
    maxmemory: cfg.dragonfly.maxmemory,
    memoryLimit: cfg.dragonfly.memoryLimit,
    cacheMode: true,
  });
}

/**
 * The counter store for edge rate limiting (ADR-0040 layer L1) — a SECOND,
 * smaller Dragonfly that only Envoy Gateway's rate limit service talks to.
 *
 * Two reasons it is not the ADR-0020 cache:
 *
 *   1. **Eviction.** That instance runs `--cache_mode=true` on a shared
 *      `--maxmemory`, so a burst of ordinary cache traffic evicts whatever is
 *      coldest — including rate-limit counters. A silently reset counter is a
 *      silently lifted limit, and nothing in any log says it happened. Here
 *      `cache_mode` is OFF: past `maxmemory` writes are REFUSED, the rate limit
 *      service logs errors, and (fail-open) traffic flows while a metric moves.
 *      Loud degradation beats quiet.
 *   2. **Blast radius.** The rate limit service is in the request path of every
 *      request. Coupling it to the cache means cache pressure becomes edge
 *      latency.
 *
 * Counters are ephemeral by construction (they expire with their window), so
 * this instance keeps the cache's no-persistence, single-replica shape.
 */
export function installRateLimitStore(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): Dragonfly {
  return installDragonflyInstance(provider, namespace, {
    name: EDGE_RATE_LIMIT.storeService,
    maxmemory: cfg.rateLimit.storeMaxmemory,
    memoryLimit: cfg.rateLimit.storeMemoryLimit,
    cacheMode: false,
    // Never two counter stores behind one Service — see the option's comment.
    recreateOnRollout: true,
  });
}

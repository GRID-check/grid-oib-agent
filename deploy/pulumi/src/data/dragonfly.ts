import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { ROLLOUT, gracefulShutdown, recreateRollout } from "../platform/rollout";
import { DATA_RESOURCES, PORT } from "../constants";

const DRAGONFLY_IMAGE = "docker.dragonflydb.io/dragonflydb/dragonfly:latest";

export interface Dragonfly {
  service: k8s.core.v1.Service;
  /** redis:// URL other services use as REDIS_URL. */
  url: pulumi.Output<string>;
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
  const labels = commonLabels("dragonfly");

  const deployment = new k8s.apps.v1.Deployment(
    "dragonfly",
    {
      metadata: { name: "dragonfly", namespace, labels },
      spec: {
        replicas: 1,
        // Single replica on a single port: two Dragonfly pods would briefly
        // serve two divergent caches, so Recreate (not a surge) is correct.
        // Both tiers fail open to in-process caches during the gap.
        ...recreateRollout(ROLLOUT.dataPlane),
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
                // Cache only (state is regenerable) — safe to track latest.
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
                  `--maxmemory=${cfg.dragonfly.maxmemory}`,
                  "--cache_mode=true",
                  "--dbfilename=",
                ],
                ports: [{ containerPort: PORT.redis, name: "redis" }],
                resources: {
                  requests: DATA_RESOURCES.dragonflyRequests,
                  // Limit sits ABOVE --maxmemory (which caps only the dataset);
                  // RSS overhead above it would otherwise OOMKill the cache.
                  limits: { cpu: DATA_RESOURCES.dragonflyCpuLimit, memory: cfg.dragonfly.memoryLimit },
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
    "dragonfly",
    {
      metadata: { name: "dragonfly", namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.redis, targetPort: PORT.redis, name: "redis" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { service, url: pulumi.output(`redis://dragonfly:${PORT.redis}/0`) };
}

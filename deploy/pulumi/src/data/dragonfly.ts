import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";

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
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: "dragonfly",
                // Cache only (state is regenerable) — safe to track latest.
                image: "docker.dragonflydb.io/dragonflydb/dragonfly:latest",
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
                ports: [{ containerPort: 6379, name: "redis" }],
                resources: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: cfg.dragonfly.maxmemory },
                },
                readinessProbe: {
                  tcpSocket: { port: 6379 },
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
        ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { service, url: pulumi.output("redis://dragonfly:6379/0") };
}

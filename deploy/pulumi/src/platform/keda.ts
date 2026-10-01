import * as k8s from "@pulumi/kubernetes";
import { PLATFORM_RESOURCES } from "../constants";

/** Namespace KEDA runs in; the network policy that lets it read the queue depth names it. */
export const KEDA_NAMESPACE = "keda";

/**
 * KEDA — the event-driven autoscaler the ingest-worker tier scales with
 * (ADR-0076).
 *
 * The CPU HPAs this cluster already runs cannot scale ingestion: an ingest
 * worker spends most of a job waiting on the model provider, so its CPU says
 * nothing about how much work is waiting, and `metrics.k8s.io` is the only
 * metrics API here (no Prometheus adapter). KEDA answers the question directly
 * — it runs `SELECT COUNT(*)` against the durable queue and sets the replica
 * count from it — and brings its own `external.metrics.k8s.io` provider, so no
 * metrics pipeline has to exist first. It can also scale a tier to zero, which
 * an HPA cannot.
 *
 * Bought rather than built: the alternative is a controller of our own that
 * polls Postgres and patches a Deployment's replicas, i.e. a worse KEDA.
 */
export function installKeda(provider: k8s.Provider): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace("keda-ns", { metadata: { name: KEDA_NAMESPACE } }, { provider });
  return new k8s.helm.v3.Release(
    "keda",
    {
      chart: "keda",
      // Unpinned, like the other platform charts: ScaledObject v1alpha1 and the
      // postgresql scaler have been stable across KEDA 2.x.
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://kedacore.github.io/charts" },
      values: {
        resources: {
          operator: PLATFORM_RESOURCES.kedaOperator,
          metricServer: PLATFORM_RESOURCES.kedaMetricServer,
          webhooks: PLATFORM_RESOURCES.kedaWebhooks,
        },
      },
    },
    { provider, dependsOn: [ns] },
  );
}

import * as k8s from "@pulumi/kubernetes";

/**
 * metrics-server — provides the `metrics.k8s.io` API the CPU HPAs (frontend +
 * agent-worker) depend on. Without it the HPAs report `<unknown>/70%` and never
 * scale, so the horizontal-scaling knobs would silently do nothing.
 *
 * Many managed clusters already ship metrics-server; set
 * `grid-oib:installMetricsServer=false` there to avoid installing a second one.
 */
export function installMetricsServer(provider: k8s.Provider): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    "metrics-server",
    {
      chart: "metrics-server",
      version: "3.12.2",
      namespace: "kube-system",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/metrics-server/" },
      values: {
        resources: { requests: { cpu: "50m", memory: "64Mi" } },
      },
    },
    { provider },
  );
}

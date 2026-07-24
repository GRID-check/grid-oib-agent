import * as k8s from "@pulumi/kubernetes";

/**
 * metrics-server — provides the `metrics.k8s.io` API the CPU HPAs (frontend +
 * agent-worker) depend on. Without it the HPAs report `<unknown>/70%` and never
 * scale, so the horizontal-scaling knobs would silently do nothing.
 *
 * The managed provider ALREADY ships base metrics components that serve
 * `metrics.k8s.io` and cannot be removed, so `installMetricsServer` defaults to
 * false and this never runs on that cluster (a second copy would just fight the
 * built-in one). It exists for bare clusters with no metrics API — flip
 * `grid-oib:installMetricsServer=true` there.
 */
export function installMetricsServer(provider: k8s.Provider): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    "metrics-server",
    {
      chart: "metrics-server",
      // Unpinned: track the latest chart.
      namespace: "kube-system",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/metrics-server/" },
      values: {
        // Self-managed / bare-metal kubelets (this cluster's Lightbits profile)
        // typically present self-signed serving certs, so without this arg
        // metrics-server can't scrape and both HPAs stall at `<unknown>/70%`.
        // Managed clusters that ship valid kubelet certs should install their
        // own metrics-server instead (installMetricsServer=false).
        args: ["--kubelet-insecure-tls"],
        resources: { requests: { cpu: "50m", memory: "64Mi" } },
      },
    },
    { provider },
  );
}

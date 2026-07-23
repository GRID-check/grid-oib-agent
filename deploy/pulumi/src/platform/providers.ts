import * as k8s from "@pulumi/kubernetes";
import { GridConfig } from "../config";

/**
 * A Kubernetes provider bound to the target cluster's kubeconfig.
 *
 * Everything in the program is created against THIS provider (passed explicitly
 * as `{ provider }`), so `pulumi up` never depends on the operator's ambient
 * `kubectl` context — it targets exactly the cluster whose kubeconfig is in
 * `grid-oib:kubeconfig`.
 */
export function makeProvider(cfg: GridConfig): k8s.Provider {
  return new k8s.Provider("grid-k8s", {
    kubeconfig: cfg.kubeconfig,
    // Server-side apply gives us cleaner diffs and avoids the last-applied
    // annotation bloat on large manifests (CNPG/ingress CRs).
    enableServerSideApply: true,
  });
}

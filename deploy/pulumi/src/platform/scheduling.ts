import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Scheduling helpers for the provider's managed-k0s behaviour.
 *
 * Two provider facts drive this module (docs/deployment/kubernetes.md §1):
 *   1. **Version upgrades are automatic** and replace/drain worker nodes with no
 *      operator involvement. A voluntary node drain that evicts every replica of
 *      a service at once is a self-inflicted outage during a routine upgrade.
 *   2. The **cluster-autoscaler reacts to unschedulable pods**, and the provider
 *      lists `topologySpreadConstraints` (alongside HPAs and requests/limits) as
 *      a precondition for it to behave well.
 *
 * So every workload that runs ≥2 replicas gets:
 *   - a **PodDisruptionBudget** (`maxUnavailable: 1`) so a drain can only take one
 *     replica down at a time, and
 *   - a soft **topologySpreadConstraint** across nodes so replicas land on
 *     different worker nodes (a single node loss never takes the whole tier).
 *
 * NOTE — single-replica workloads deliberately get NO PDB: `minAvailable: 1` on a
 * 1-replica workload would block the node drain forever and deadlock the
 * provider's automatic upgrades. Postgres HA is handled by CloudNativePG's own
 * PDB.
 */

/**
 * Spread a workload's pods across worker nodes. `ScheduleAnyway` (soft) keeps it
 * a preference — it never blocks a rollout when the cluster is briefly down to
 * one schedulable node (e.g. mid node-replacement), but the scheduler spreads
 * whenever it can. Drop this onto a pod `spec`.
 */
export function spreadAcrossNodes(
  matchLabels: pulumi.Input<{ [k: string]: string }>,
): k8s.types.input.core.v1.TopologySpreadConstraint[] {
  return [
    {
      maxSkew: 1,
      topologyKey: "kubernetes.io/hostname",
      whenUnsatisfiable: "ScheduleAnyway",
      labelSelector: { matchLabels },
    },
  ];
}

/**
 * A PodDisruptionBudget capping voluntary disruptions at one pod. `maxUnavailable`
 * (not `minAvailable`) is used on purpose: it scales with any replica count and
 * can never deadlock a drain the way `minAvailable: <replicas>` would.
 */
export function installPdb(
  name: string,
  namespace: pulumi.Input<string>,
  provider: k8s.Provider,
  matchLabels: pulumi.Input<{ [k: string]: string }>,
  dependsOn: pulumi.Resource[] = [],
): k8s.policy.v1.PodDisruptionBudget {
  return new k8s.policy.v1.PodDisruptionBudget(
    name,
    {
      metadata: { name, namespace },
      spec: {
        maxUnavailable: 1,
        selector: { matchLabels },
      },
    },
    { provider, dependsOn },
  );
}

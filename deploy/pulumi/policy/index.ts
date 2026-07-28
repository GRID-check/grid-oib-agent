import * as k8s from "@pulumi/kubernetes";
import { PolicyPack, ReportViolation, validateResourceOfType } from "@pulumi/policy";

/**
 * CrossGuard guardrails for the Grid OIB stack.
 *
 * These run as part of `pulumi preview` / `pulumi up` in CI
 * (`--policy-pack ./policy`), so a change that would ship an unsafe rollout
 * fails the deploy at plan time — before anything touches the cluster.
 *
 * The point is not to re-state what the program already does. It is that the
 * program's rollout settings are easy to drop: a new workload written by
 * copy-pasting an old one, a "temporary" strategy tweak, an upstream chart
 * bump. Every rule below encodes a failure this stack has a concrete reason to
 * fear, and points at where the reasoning lives.
 *
 * `mandatory` blocks the deploy; `advisory` prints a warning and continues.
 * Promote an advisory rule once the stack satisfies it everywhere.
 */

type PodSpec = k8s.types.output.core.v1.PodSpec;
type Container = k8s.types.output.core.v1.Container;

/**
 * The slice of a Deployment/StatefulSet the pod-level rules care about. Both
 * kinds share it, but their generated arg types are nominally distinct, so the
 * shared rules run against this structural view.
 */
interface WorkloadProps {
  metadata?: { name?: string };
  spec?: { template?: { spec?: PodSpec } };
}

/**
 * Register one pod-level check against BOTH workload kinds we author directly.
 * (Helm-rendered charts — cert-manager, Envoy Gateway, CNPG — arrive as a
 * single opaque `Release` resource and are out of scope here by construction.)
 */
function forEachWorkload(check: (workload: WorkloadProps, report: ReportViolation) => void) {
  return [
    validateResourceOfType(k8s.apps.v1.Deployment, (props, _args, report) =>
      check(props as unknown as WorkloadProps, report),
    ),
    validateResourceOfType(k8s.apps.v1.StatefulSet, (props, _args, report) =>
      check(props as unknown as WorkloadProps, report),
    ),
  ];
}

function containersOf(pod: PodSpec | undefined): Container[] {
  if (!pod) return [];
  return [...(pod.containers ?? []), ...(pod.initContainers ?? [])];
}

/** An image reference is immutable if it is digest-pinned or version-tagged. */
function isImmutableRef(image: string): boolean {
  if (image.includes("@sha256:")) return true;
  const tag = image.split("/").pop()?.split(":")[1];
  return tag !== undefined && tag !== "latest";
}

export default new PolicyPack("grid-oib-guardrails", {
  policies: [
    {
      name: "deployment-rollout-gated",
      description:
        "Deployments must gate their rollout: a stability soak (minReadySeconds) so a " +
        "crash-on-first-request image cannot walk through the fleet, and a " +
        "progressDeadlineSeconds so a wedged rollout is reported as failed instead of " +
        "hanging. See deploy/pulumi/src/platform/rollout.ts.",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(
        k8s.apps.v1.Deployment,
        (deployment, _args, report: ReportViolation) => {
          const spec = deployment.spec;
          if (!spec) return;
          const name = deployment.metadata?.name ?? "<unnamed>";
          if (!spec.minReadySeconds || spec.minReadySeconds < 1) {
            report(
              `Deployment "${name}" does not set spec.minReadySeconds. Without it a new pod ` +
                `counts as available the instant it first passes readiness, so a broken ` +
                `image rolls through every replica before anything notices.`,
            );
          }
          if (!spec.progressDeadlineSeconds || spec.progressDeadlineSeconds < 1) {
            report(
              `Deployment "${name}" does not set spec.progressDeadlineSeconds. A stuck ` +
                `rollout would never surface a ProgressDeadlineExceeded condition, so ` +
                `\`pulumi up\` fails on an opaque client timeout instead of the real reason.`,
            );
          }
        },
      ),
    },

    {
      name: "deployment-no-capacity-dip",
      description:
        "A multi-replica Deployment must roll by SURGING (maxUnavailable: 0), not by " +
        "removing capacity first. `Recreate` is allowed only for declared singletons.",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(
        k8s.apps.v1.Deployment,
        (deployment, _args, report: ReportViolation) => {
          const spec = deployment.spec;
          if (!spec) return;
          const name = deployment.metadata?.name ?? "<unnamed>";
          // `replicas` is unset on HPA-owned workloads; those are multi-replica.
          const replicas = spec.replicas ?? 2;
          const type = spec.strategy?.type ?? "RollingUpdate";

          if (type === "Recreate") {
            if (replicas > 1) {
              report(
                `Deployment "${name}" uses the Recreate strategy with ${replicas} replicas, ` +
                  `which takes the entire tier down on every deploy. Recreate is only for ` +
                  `single-replica workloads that must never run twice concurrently.`,
              );
            }
            return;
          }

          const maxUnavailable = spec.strategy?.rollingUpdate?.maxUnavailable;
          // Kubernetes defaults maxUnavailable to 25% when unset — a silent
          // capacity dip, which is exactly what this rule exists to catch.
          if (maxUnavailable === undefined || String(maxUnavailable) !== "0") {
            report(
              `Deployment "${name}" rolls with maxUnavailable=${
                maxUnavailable === undefined ? "unset (defaults to 25%)" : String(maxUnavailable)
              }. Set spec.strategy.rollingUpdate.maxUnavailable: 0 so a replacement pod is ` +
                `proven healthy BEFORE any serving replica is taken away.`,
            );
          }
        },
      ),
    },

    {
      name: "statefulset-rollout-gated",
      description:
        "StatefulSets must roll one pod at a time with a stability soak. (StatefulSets " +
        "have no progressDeadlineSeconds; minReadySeconds is the gate.)",
      enforcementLevel: "mandatory",
      validateResource: validateResourceOfType(
        k8s.apps.v1.StatefulSet,
        (statefulSet, _args, report: ReportViolation) => {
          const spec = statefulSet.spec;
          if (!spec) return;
          const name = statefulSet.metadata?.name ?? "<unnamed>";
          const type = spec.updateStrategy?.type ?? "RollingUpdate";
          if (type !== "RollingUpdate") {
            report(
              `StatefulSet "${name}" uses updateStrategy "${type}". OnDelete means a ` +
                `\`pulumi up\` updates the template and rolls NOTHING — the deploy reports ` +
                `success while every pod keeps running the old image.`,
            );
          }
          if (!spec.minReadySeconds || spec.minReadySeconds < 1) {
            report(
              `StatefulSet "${name}" does not set spec.minReadySeconds, so the controller ` +
                `moves to the next ordinal as soon as a pod first reports Ready.`,
            );
          }
        },
      ),
    },

    {
      name: "workload-graceful-termination",
      description:
        "Every workload must state its shutdown budget. The Kubernetes default of 30s " +
        "SIGKILLs anything that drains real work on SIGTERM — for this stack that means " +
        "in-flight research jobs and streaming chat WebSockets, on every single deploy.",
      enforcementLevel: "mandatory",
      validateResource: forEachWorkload((workload, report) => {
        const pod = workload.spec?.template?.spec;
        const name = workload.metadata?.name ?? "<unnamed>";
          const grace = pod?.terminationGracePeriodSeconds;
          if (grace === undefined) {
            report(
              `Workload "${name}" does not set terminationGracePeriodSeconds, so it inherits ` +
                `the 30s default. Set it explicitly from a ROLLOUT profile ` +
                `(deploy/pulumi/src/platform/rollout.ts) — even 30s is fine, as long as it is ` +
                `a decision rather than an accident.`,
            );
          } else if (grace < 5) {
            report(
            `Workload "${name}" sets terminationGracePeriodSeconds=${grace}, which is too ` +
              `short for the container to finish anything in flight.`,
          );
        }
      }),
    },

    {
      name: "container-resources-bounded",
      description:
        "Every container needs CPU + memory requests AND limits. The provider lists this " +
        "as a cluster-autoscaler prerequisite (docs/deployment/kubernetes.md §1), and an " +
        "unbounded pod is what turns one bad rollout into node-wide eviction.",
      enforcementLevel: "mandatory",
      validateResource: forEachWorkload((workload, report) => {
        const name = workload.metadata?.name ?? "<unnamed>";
        for (const container of containersOf(workload.spec?.template?.spec)) {
          const missing = [
              container.resources?.requests?.cpu ? undefined : "requests.cpu",
              container.resources?.requests?.memory ? undefined : "requests.memory",
              container.resources?.limits?.cpu ? undefined : "limits.cpu",
              container.resources?.limits?.memory ? undefined : "limits.memory",
            ].filter((m): m is string => m !== undefined);
          if (missing.length > 0) {
            report(`Container "${container.name}" in "${name}" is missing ${missing.join(", ")}.`);
          }
        }
      }),
    },

    {
      name: "moving-tag-must-repull",
      description:
        "A container on a MOVING tag (`latest`, or no tag) must set imagePullPolicy: Always. " +
        "Otherwise a rescheduled pod silently keeps whatever layer that node had cached, and " +
        "a deploy 'succeeds' without shipping the new code.",
      enforcementLevel: "mandatory",
      validateResource: forEachWorkload((workload, report) => {
        const name = workload.metadata?.name ?? "<unnamed>";
        for (const container of containersOf(workload.spec?.template?.spec)) {
          if (!container.image || isImmutableRef(container.image)) continue;
          if (container.imagePullPolicy !== "Always") {
            report(
              `Container "${container.name}" in "${name}" uses the moving reference ` +
                `"${container.image}" with imagePullPolicy=` +
                `${container.imagePullPolicy ?? "unset"}. Use pullPolicyFor() from ` +
                `src/config.ts, or pin the tag.`,
            );
          }
        }
      }),
    },

    {
      name: "prefer-immutable-image-tags",
      description:
        "Advisory: prefer a digest or a version tag over `latest`. A moving tag means the " +
        "running version changes at unpredictable times — every node replacement the " +
        "provider performs is an unreviewed upgrade.",
      enforcementLevel: "advisory",
      validateResource: forEachWorkload((workload, report) => {
        const name = workload.metadata?.name ?? "<unnamed>";
        for (const container of containersOf(workload.spec?.template?.spec)) {
          if (container.image && !isImmutableRef(container.image)) {
            report(
              `Container "${container.name}" in "${name}" tracks "${container.image}". ` +
                `Pin it to a digest or a released version.`,
            );
          }
        }
      }),
    },

    {
      name: "workload-health-probes",
      description:
        "Advisory: a container with no probe at all is invisible to the rollout gate — " +
        "Kubernetes calls it Ready as soon as the process starts, so minReadySeconds " +
        "measures nothing. Poll-loop workers with no port are the legitimate exception.",
      enforcementLevel: "advisory",
      validateResource: forEachWorkload((workload, report) => {
        const name = workload.metadata?.name ?? "<unnamed>";
        for (const container of workload.spec?.template?.spec?.containers ?? []) {
          if (!container.readinessProbe && !container.livenessProbe) {
            report(
              `Container "${container.name}" in "${name}" declares neither a readiness nor ` +
                `a liveness probe.`,
            );
          }
        }
      }),
    },
  ],
});

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, backendAutoscaled, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  backendRollout,
  gracefulShutdown,
  orderedRollout,
  secretChecksumAnnotations,
} from "../platform/rollout";
import { withLangfuseKeysChecksum } from "../platform/langfuse";
import { AppSecrets, AppWiring, chatEnv } from "./config";
import { PORT, UID } from "../constants";

export interface Backend {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  headlessService: k8s.core.v1.Service;
  /** Only present in db mode (multi-replica); a singleton needs no PDB. */
  pdb?: k8s.policy.v1.PodDisruptionBudget;
}

/**
 * The chat tier (aiq-agent, `GRID_ROLE=chat`, ADR-0082): the chat socket and the
 * answers running on it, plus NAT's own routes. Every other backend route is the
 * api tier's (`api.ts`, the `aiq-api` Service). It keeps no files: the vectors
 * live in the shared Chroma server, the base corpus in SeaweedFS and a Postgres
 * table (ADR-0082 step A2), and what it caches on its own disk
 * (`GRID_BASE_CORPUS_CACHE_DIR`, under /tmp) it can lose at any restart.
 *
 * The chat and retrieval path is replica-safe (shared Chroma, Postgres DSNs,
 * shared cache, DB-persisted ingest status, advisory-locked reapers), so it runs
 * `backend.replicas` replicas. Research executes on the separate agent-worker tier.
 *
 * Still a StatefulSet, though nothing here needs one any more: chat affinity
 * hashes a conversation onto a pod ordinal (ADR-0028, ADR-0080), and that
 * routing needs the stable per-pod DNS and ordinals only a StatefulSet gives.
 * It becomes a Deployment when the chat tier stops depending on it (ADR-0082).
 */
export function installBackend(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): Backend {
  const labels = commonLabels("aiq-agent");
  const autoscaled = backendAutoscaled(cfg);
  const multiReplica = cfg.backend.replicas > 1 || autoscaled;
  // The grace period is the chat drain plus the endpoint drain and slack: a
  // terminating replica finishes the turns it claimed (ADR-0080).
  const profile = backendRollout(cfg.backend.drainSeconds);
  const shutdown = gracefulShutdown(profile, "python");

  const statefulSet = new k8s.apps.v1.StatefulSet(
    "aiq-agent",
    {
      metadata: { name: "aiq-agent", namespace: w.namespace, labels },
      spec: {
        // Headless governing service → stable per-pod DNS
        // (aiq-agent-<i>.aiq-agent-headless), which the frontend uses for
        // conversation affinity so a chat pins to its owning replica.
        serviceName: "aiq-agent-headless",
        // Multi-replica chat tier (safe with conversation affinity, ADR-0028, or
        // the conversation bus, ADR-0080). The floor when KEDA scales it
        // (backend-scaling.ts).
        replicas: cfg.backend.replicas,
        selector: { matchLabels: labels },
        // One pod at a time, highest ordinal first, and each replacement must
        // stay Ready for minReadySeconds before the next is touched — the
        // ordering the conversation-affinity routing (ADR-0028) depends on.
        ...orderedRollout(profile),
        template: {
          metadata: {
            labels,
            // Credential rotation ⇒ pod-template change ⇒ a real, ordered
            // rolling update (rollout.ts). Without it the pods keep serving with
            // the pre-rotation keys and `pulumi up` still reports success.
            annotations: secretChecksumAnnotations(withLangfuseKeysChecksum(cfg, secrets.checksum)),
          },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            // preStop covers EndpointSlice propagation (both the ClusterIP and
            // the affinity headless service route here), then uvicorn gets its
            // SIGTERM with room to finish streaming responses in flight.
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            // The chat tier may run >1 replica — spread across nodes so an upgrade
            // node-drain / node loss can't take every chat replica down.
            ...(multiReplica ? { topologySpreadConstraints: spreadAcrossNodes(labels) } : {}),
            containers: [
              {
                name: "aiq-agent",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                ports: [{ containerPort: PORT.backend, name: "http" }],
                env: chatEnv(w),
                resources: toResourceRequirements(cfg.backend.resources),
                lifecycle: shutdown.lifecycle,
                // Boot opens the Chroma client — generous
                // startup window before liveness kicks in.
                startupProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: 10,
                  failureThreshold: 60,
                },
                readinessProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: 15,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: PORT.backend },
                  periodSeconds: 20,
                  timeoutSeconds: 10,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    {
      provider: w.provider,
      dependsOn: [secrets.secret, ...dependsOn],
      // KEDA owns the replica count once its ScaledObject exists, so a count
      // this program wrote would be reverted on the next `pulumi up`.
      ignoreChanges: autoscaled ? ["spec.replicas"] : [],
      // Fixed-name StatefulSet: replaces must delete first (see chroma.ts).
      deleteBeforeReplace: true,
      // First boot = multi-GB image pull + startup work; the startupProbe alone
      // allows 10 min. Give the await headroom so a healthy-but-slow first
      // deploy doesn't fail on Pulumi's default 10m.
      // An update also waits out every replica's drain, one pod at a time.
      customTimeouts: {
        create: "25m",
        update: `${Math.ceil(profile.terminationGracePeriodSeconds / 60) * cfg.backend.maxReplicas + 25}m`,
      },
    },
  );

  // Headless service: stable per-pod DNS (aiq-agent-<i>.aiq-agent-headless) for
  // conversation affinity (the frontend routes a conversation to its owning pod).
  const headlessService = new k8s.core.v1.Service(
    "aiq-agent-headless",
    {
      metadata: { name: "aiq-agent-headless", namespace: w.namespace, labels },
      spec: {
        clusterIP: "None",
        selector: labels,
        ports: [{ port: PORT.backend, targetPort: PORT.backend, name: "http" }],
        // Serve DNS for pods as soon as they exist (before Ready) so affinity
        // routing resolves during rollouts.
        publishNotReadyAddresses: true,
      },
    },
    { provider: w.provider },
  );

  // Load-balanced ClusterIP for callers that don't need affinity: the frontend's
  // WebSocket proxy when it has no pod address (BACKEND_CHAT_URL), and KEDA's
  // occupancy scaler. HTTP callers use the api tier's Service, not this one.
  const service = new k8s.core.v1.Service(
    "aiq-agent",
    {
      metadata: { name: "aiq-agent", namespace: w.namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.backend, targetPort: PORT.backend, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: statefulSet },
  );

  // PDB only when the tier is genuinely multi-replica (db mode). On a singleton
  // a maxUnavailable:1 PDB is a no-op, but adding it conditionally keeps the
  // intent explicit and avoids churn on a single-replica stack.
  const pdb = multiReplica
    ? installPdb("aiq-agent", w.namespace, w.provider, labels, [statefulSet])
    : undefined;

  return { statefulSet, service, headlessService, pdb };
}

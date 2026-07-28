import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  ROLLOUT,
  gracefulShutdown,
  orderedRollout,
  secretChecksumAnnotations,
} from "../platform/rollout";
import { AppSecrets, AppWiring, backendEnv } from "./config";
import { PORT, UID } from "../constants";

export interface Backend {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  headlessService: k8s.core.v1.Service;
  /** Only present in db mode (multi-replica); a singleton needs no PDB. */
  pdb?: k8s.policy.v1.PodDisruptionBudget;
}

/**
 * The agent (aiq-agent): FastAPI web tier + an in-process Dask cluster + an
 * embedded ChromaDB vector store, all on one persistent data volume.
 *
 * Replica count depends on the execution mode:
 *   - "dask" (default): a HARD SINGLETON (replicas=1) — embedded Chroma +
 *     in-pod Dask + in-process state pin work to one process. Scales VERTICALLY
 *     (CPU/memory + Dask worker/thread knobs, bounded by admission caps).
 *   - "db": the chat/retrieval path is replica-safe (shared Chroma, Postgres
 *     DSNs, shared cache, DB-persisted ingest status, advisory-locked reapers),
 *     so it runs `backend.replicas` replicas. Research executes on the separate
 *     agent-worker tier. Caveat: the platform base-corpus upload writes to a
 *     per-replica uploads PVC — see docs/deployment/kubernetes.md §6.3.
 *
 * Kept as a StatefulSet (stable identity + per-replica RWO PVC on Lightbits).
 */
export function installBackend(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): Backend {
  const labels = commonLabels("aiq-agent");
  const multiReplica = cfg.jobExecution === "db" && cfg.backend.replicas > 1;
  const shutdown = gracefulShutdown(ROLLOUT.backend, "python");

  const statefulSet = new k8s.apps.v1.StatefulSet(
    "aiq-agent",
    {
      metadata: { name: "aiq-agent", namespace: w.namespace, labels },
      spec: {
        // Headless governing service → stable per-pod DNS
        // (aiq-agent-<i>.aiq-agent-headless), which the frontend uses for
        // conversation affinity so a chat pins to its owning replica.
        serviceName: "aiq-agent-headless",
        // Singleton in dask mode; multi-replica chat tier in db mode (safe with
        // conversation affinity — ADR-0028).
        replicas: cfg.jobExecution === "db" ? cfg.backend.replicas : 1,
        selector: { matchLabels: labels },
        // One pod at a time, highest ordinal first, and each replacement must
        // stay Ready for minReadySeconds before the next is touched — pinned
        // explicitly because the conversation-affinity routing (ADR-0028)
        // depends on exactly this ordering, not on a controller default.
        ...orderedRollout(ROLLOUT.backend),
        // StatefulSet PVCs must survive the StatefulSet: the /app/data volume
        // holds the base OIB corpus + (in dask mode) the only Chroma store, and
        // the provider's StorageClasses all reclaim `Delete`, so a controller
        // that cascaded a PVC delete would irreversibly destroy that data. Retain
        // on both delete and scale-down (matches the k8s default; pinned so a
        // future default flip to Delete can't silently start wiping volumes).
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        template: {
          metadata: {
            labels,
            // Credential rotation ⇒ pod-template change ⇒ a real, ordered
            // rolling update (rollout.ts). Without it the pods keep serving with
            // the pre-rotation keys and `pulumi up` still reports success.
            annotations: secretChecksumAnnotations(secrets.checksum),
          },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            // preStop covers EndpointSlice propagation (both the ClusterIP and
            // the affinity headless service route here), then uvicorn gets its
            // SIGTERM with room to finish streaming responses in flight.
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            // The image runs as UID 1000 and needs to write /app/data (Chroma +
            // uploads); fsGroup makes the PVC group-writable, replacing the
            // compose chown init container.
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend, fsGroup: UID.backend },
            // In db mode the web tier runs >1 replica — spread across nodes so an
            // upgrade node-drain / node loss can't take every chat replica down.
            // (Singleton dask mode: the array is empty, a harmless no-op.)
            ...(multiReplica ? { topologySpreadConstraints: spreadAcrossNodes(labels) } : {}),
            containers: [
              {
                name: "aiq-agent",
                image: backendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                ports: [{ containerPort: PORT.backend, name: "http" }],
                env: backendEnv(w),
                volumeMounts: [{ name: "data", mountPath: "/app/data" }],
                resources: toResourceRequirements(cfg.backend.resources),
                lifecycle: shutdown.lifecycle,
                // Boot spins up Dask + opens Chroma and may run a volume-based
                // OIB sync — generous startup window before liveness kicks in.
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
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: cfg.backend.dataStorageSize } },
            },
          },
        ],
      },
    },
    {
      provider: w.provider,
      dependsOn: [secrets.secret, ...dependsOn],
      // Immutable volumeClaimTemplates — see seaweedfs.ts; grow via PVC patch.
      ignoreChanges: ["spec.volumeClaimTemplates"],
      // Fixed-name StatefulSet: replaces must delete first (see chroma.ts).
      deleteBeforeReplace: true,
      // First boot = multi-GB image pull + Dask/Chroma init + optional corpus
      // sync; the startupProbe alone allows 10 min. Give the await headroom so
      // a healthy-but-slow first deploy doesn't fail on Pulumi's default 10m.
      customTimeouts: { create: "25m", update: "25m" },
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

  // Load-balanced ClusterIP for callers that don't need affinity (BACKEND_URL,
  // internal REST, the migration/health checks).
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
  // intent explicit and avoids churn on the dask-mode stack.
  const pdb = multiReplica
    ? installPdb("aiq-agent", w.namespace, w.provider, labels, [statefulSet])
    : undefined;

  return { statefulSet, service, headlessService, pdb };
}

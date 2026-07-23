import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, backendEnv } from "./config";

export interface Backend {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  headlessService: k8s.core.v1.Service;
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
  secret: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
): Backend {
  const labels = commonLabels("aiq-agent");

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
        template: {
          metadata: { labels },
          spec: {
            // The image runs as UID 1000 and needs to write /app/data (Chroma +
            // uploads); fsGroup makes the PVC group-writable, replacing the
            // compose chown init container.
            securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers: [
              {
                name: "aiq-agent",
                image: backendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                ports: [{ containerPort: 8000, name: "http" }],
                env: backendEnv(w),
                volumeMounts: [{ name: "data", mountPath: "/app/data" }],
                resources: toResourceRequirements(cfg.backend.resources),
                // Boot spins up Dask + opens Chroma and may run a volume-based
                // OIB sync — generous startup window before liveness kicks in.
                startupProbe: {
                  httpGet: { path: "/health", port: 8000 },
                  periodSeconds: 10,
                  failureThreshold: 60,
                },
                readinessProbe: {
                  httpGet: { path: "/health", port: 8000 },
                  periodSeconds: 15,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: 8000 },
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
    { provider: w.provider, dependsOn: [secret, ...dependsOn] },
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
        ports: [{ port: 8000, targetPort: 8000, name: "http" }],
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
        ports: [{ port: 8000, targetPort: 8000, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: statefulSet },
  );

  return { statefulSet, service, headlessService };
}

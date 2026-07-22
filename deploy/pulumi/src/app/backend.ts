import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, backendEnv } from "./config";

export interface Backend {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
}

/**
 * The agent (aiq-agent): FastAPI web tier + an in-process Dask cluster + an
 * embedded ChromaDB vector store, all on one persistent data volume.
 *
 * WHY A StatefulSet WITH replicas=1: per docs/architecture/scaling-review-2026-07.md
 * this tier is a HARD SINGLETON today — the embedded Chroma store, the private
 * localhost Dask cluster, and in-process job/citation state all pin work to one
 * process. It therefore scales VERTICALLY (more CPU/memory + Dask workers/threads
 * via config, bounded by the admission caps), not by adding replicas. The
 * StatefulSet gives it a stable identity and a stable RWO PVC. Horizontal
 * scaling is a documented follow-up (DB-claimed research workers + externalised
 * vector store); this manifest is already wired for it (Postgres DSNs, Redis).
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
        serviceName: "aiq-agent",
        replicas: 1,
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

  return { statefulSet, service };
}

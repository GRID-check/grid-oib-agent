import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { DATA_RESOURCES, PORT } from "../constants";

export interface Chroma {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  /** In-cluster URL every backend replica + worker points AIQ_CHROMA_URL at. */
  url: pulumi.Output<string>;
}

/**
 * Shared ChromaDB server (horizontal scaling — Stage A).
 *
 * Replaces the per-pod embedded `PersistentClient` with ONE Chroma server that
 * every backend replica and research worker talks to over HTTP. The vector
 * store stops being pinned to a single pod's disk, which is the precondition
 * for running the agent web tier and workers as multiple replicas.
 *
 * Chroma's open-source server is itself single-node (one process on a durable
 * Lightbits PVC); that is fine — it is the *shared* store, not a per-replica
 * one. Its own HA is a separate, later concern.
 */
export function installChroma(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): Chroma {
  const labels = commonLabels("chroma");

  const statefulSet = new k8s.apps.v1.StatefulSet(
    "chroma",
    {
      metadata: { name: "chroma", namespace, labels },
      spec: {
        serviceName: "chroma-headless",
        replicas: 1,
        // Shared vector store on a `Delete`-reclaim StorageClass — retain the PVC
        // across StatefulSet delete/scale so a teardown can't wipe the embeddings
        // (matches the k8s default; pinned against a future default flip).
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            securityContext: { fsGroup: 1000 },
            containers: [
              {
                name: "chroma",
                image: cfg.chroma.image,
                ports: [{ containerPort: PORT.chroma, name: "http" }],
                // Chroma 1.x is a Rust server configured by a baked /config.yaml
                // (persist_path: /data); the 0.5.x IS_PERSISTENT/PERSIST_DIRECTORY
                // env vars are ignored, so persistence comes from the /data mount.
                volumeMounts: [{ name: "data", mountPath: "/data" }],
                // /api/v2 — v1 was removed in Chroma 1.0.
                readinessProbe: {
                  httpGet: { path: "/api/v2/heartbeat", port: 8000 },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                  failureThreshold: 12,
                },
                livenessProbe: {
                  httpGet: { path: "/api/v2/heartbeat", port: 8000 },
                  initialDelaySeconds: 30,
                  periodSeconds: 20,
                },
                resources: DATA_RESOURCES.chroma,
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
              resources: { requests: { storage: cfg.chroma.storageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      // Immutable volumeClaimTemplates — see seaweedfs.ts; grow via PVC patch.
      ignoreChanges: ["spec.volumeClaimTemplates"],
    },
  );

  // Headless governing service — the StatefulSet per-pod DNS contract requires
  // one (chroma-0.chroma-headless). Clients keep using the ClusterIP `chroma`.
  new k8s.core.v1.Service(
    "chroma-headless",
    {
      metadata: { name: "chroma-headless", namespace, labels },
      spec: { clusterIP: "None", selector: labels, ports: [{ port: PORT.chroma, name: "http" }] },
    },
    { provider },
  );

  const service = new k8s.core.v1.Service(
    "chroma",
    {
      metadata: { name: "chroma", namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.chroma, targetPort: PORT.chroma, name: "http" }],
      },
    },
    { provider, dependsOn: statefulSet },
  );

  return { statefulSet, service, url: pulumi.output(`http://chroma:${PORT.chroma}`) };
}

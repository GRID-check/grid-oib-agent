import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { ROLLOUT, gracefulShutdown, orderedRollout } from "../platform/rollout";
import { DATA_RESOURCES, PORT, SEAWEED } from "../constants";
import type { SeaweedTopology } from "./seaweedfs-types";

/**
 * The single-node SeaweedFS topology: one `weed server -s3` process running
 * master + volume + filer + gateway against one PVC.
 *
 * This is what every deployment ran before ADR-0043, and it stays because
 * moving to the split topology is a DATA MIGRATION, not a config change — the
 * two use different PVCs, so a stack that flips without running the migration
 * comes up with an empty object store while its data sits on a claim nothing
 * mounts. Keeping this path intact is what makes `seaweedfsTopology: single` a
 * genuine no-op for an existing stack.
 *
 * It is still the right choice for a small deployment: one process, one volume,
 * nothing to coordinate. What it cannot do is grow by adding replicas, and it
 * cannot put the chunk encryption keys anywhere other than the disk holding the
 * chunks they open — the filer's embedded leveldb store lives at `/data`,
 * alongside the volume files.
 */
export function installSingleNodeSeaweedFS(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  s3Secret: k8s.core.v1.Secret,
): SeaweedTopology {
  const labels = commonLabels(SEAWEED.filer);

  // Every port weed tooling needs. The gRPC ports (HTTP + 10000) are REQUIRED:
  // `weed shell` (the bucket-init Job) and any `weed` admin tooling talk gRPC to
  // master:19333 / filer:18888 — in compose this worked implicitly (direct
  // container networking), but a k8s Service filters ports, and without 19333
  // `weed shell` connect-blocks forever (found by the live smoke deploy).
  const seaweedPorts = [
    { port: PORT.seaweedS3, name: "s3" },
    { port: PORT.seaweedMaster, name: "master" },
    { port: PORT.seaweedMasterGrpc, name: "master-grpc" },
    { port: PORT.seaweedFiler, name: "filer" },
    { port: PORT.seaweedFilerGrpc, name: "filer-grpc" },
  ];

  // Headless service for the StatefulSet's stable network identity.
  const headless = new k8s.core.v1.Service(
    "seaweedfs-headless",
    {
      metadata: { name: "seaweedfs-headless", namespace, labels },
      spec: { clusterIP: "None", selector: labels, ports: seaweedPorts },
    },
    { provider },
  );

  const statefulSet = new k8s.apps.v1.StatefulSet(
    "seaweedfs",
    {
      metadata: { name: SEAWEED.filer, namespace, labels },
      spec: {
        serviceName: headless.metadata.name,
        replicas: 1,
        // The object store's only copy of every uploaded PDF lives on this PVC,
        // and the provider's StorageClasses reclaim `Delete`. Retain the PVC
        // across StatefulSet delete/scale so tearing down the workload never
        // cascades into irreversible data loss (matches the k8s default; pinned).
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            securityContext: { fsGroup: 1000 },
            // `weed server` flushes volume/filer state on SIGTERM; the 30s
            // default is thin for a store that may be mid-write.
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.dataPlane).terminationGracePeriodSeconds,
            containers: [
              {
                name: "seaweedfs",
                image: cfg.seaweedfs.image,
                // Defaults to a MOVING tag (`latest`), which must re-pull on
                // every start — see the pinning note on `seaweedfsImage`.
                imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                command: ["/bin/sh", "-c"],
                args: [
                  // Byte-for-byte the pre-ADR-0043 command line. The split
                  // topology's `volumeMaxCount` / `volumeSizeLimitMB` knobs are
                  // deliberately NOT read here: changing either on a running
                  // single-node stack re-sizes its volume slots and restarts the
                  // only storage server it has, which is not something a
                  // refactor gets to do.
                  //
                  // `-volume.max=0` is a trap: the volume server derives the
                  // number of slots from diskSize / volumeSizeLimit, so a small
                  // PVC yields 0 writable volumes and every upload fails with
                  // "No writable volumes and no free volumes left". Use an
                  // explicit, modest cap; SeaweedFS grows volumes lazily, so the
                  // slots aren't pre-allocated.
                  "exec weed server -dir=/data -volume.max=8 -s3 " +
                    "-s3.config=/etc/seaweedfs/s3.json -s3.port=8333" +
                    // Chunk encryption is a FILER concern — the volume server
                    // has no concept of it and stores the ciphertext as opaque
                    // bytes. Keys are per chunk and live in the FILER METADATA,
                    // so enabling this makes the filer store the key store for
                    // every object (see the config doc). New writes only;
                    // existing objects stay plaintext and keep working.
                    (cfg.seaweedfs.encryptVolumeData ? " -filer.encryptVolumeData" : ""),
                ],
                ports: seaweedPorts.map((p) => ({ containerPort: p.port, name: p.name })),
                volumeMounts: [
                  { name: "data", mountPath: "/data" },
                  { name: "s3config", mountPath: "/etc/seaweedfs", readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: "/cluster/healthz", port: PORT.seaweedMaster },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                  failureThreshold: 12,
                },
                // TCP rather than `/cluster/healthz`. That handler answers
                // `423 Locked` while this master holds a topology child lock —
                // an ordinary admin/volume operation — and a kubelet reads 423
                // as a failed probe. On a single-node topology that restart is
                // a full storage outage, triggered by SeaweedFS doing its job.
                livenessProbe: {
                  tcpSocket: { port: PORT.seaweedMaster },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                resources: DATA_RESOURCES.seaweedfs,
              },
            ],
            volumes: [{ name: "s3config", secret: { secretName: s3Secret.metadata.name } }],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: cfg.seaweedfs.storageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: s3Secret,
      // volumeClaimTemplates are IMMUTABLE: a storage-size change would make
      // Pulumi REPLACE the StatefulSet (deleting the only S3 server) while the
      // existing PVC keeps its old size anyway. Growing the volume is done by
      // patching the PVC (see docs/deployment/kubernetes.md storage section);
      // the template value is initial-size-only.
      ignoreChanges: ["spec.volumeClaimTemplates"],
      // Fixed-name StatefulSet: replaces must delete first (see chroma.ts).
      deleteBeforeReplace: true,
      // The only S3 server in the stack: every uploaded PDF, every presigned
      // preview URL, and (when pgBackupsEnabled) the Postgres PITR archive go
      // through it. `protect` turns an accidental delete/replace into a refused
      // operation rather than a full storage outage.
      protect: cfg.protectDataResources,
    },
  );

  // Stable ClusterIP service clients resolve as `seaweedfs`.
  const service = new k8s.core.v1.Service(
    "seaweedfs",
    {
      metadata: { name: SEAWEED.filer, namespace, labels },
      spec: { selector: labels, ports: seaweedPorts },
    },
    { provider, dependsOn: statefulSet },
  );

  return {
    workloads: [statefulSet],
    service,
    // One process serves every role, so the master lives at the same address.
    masterService: service,
    masterAddress: `${SEAWEED.filer}:${PORT.seaweedMaster}`,
    filerAddress: `${SEAWEED.filer}:${PORT.seaweedFiler}`,
    pdbs: [],
  };
}

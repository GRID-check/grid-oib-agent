import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  orderedRollout,
  secretChecksumAnnotations,
} from "../platform/rollout";
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
  /**
   * Digest of the rendered config. Without it a rotated `seaweedfsSecretKey`
   * updates the Secret, restarts nothing, and leaves every pod authenticating
   * callers against the key that was just retired — a `pulumi up` that reports
   * success and changed nothing that matters.
   */
  configChecksum: pulumi.Output<string>,
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
          metadata: { labels, annotations: secretChecksumAnnotations(configChecksum) },
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
                  // `-volume.max=0` is a trap: the volume server derives the
                  // number of slots from diskSize / volumeSizeLimit, so a small
                  // PVC yields 0 writable volumes and every upload fails with
                  // "No writable volumes and no free volumes left". Hence an
                  // explicit cap; SeaweedFS grows volumes lazily, so the slots
                  // are not pre-allocated and the number is a ceiling, not a
                  // reservation.
                  //
                  // That cap was hardcoded at 8, and 8 turned out to be a
                  // different version of the same failure. `perOrgBuckets`
                  // makes every organization its own bucket, and a bucket is a
                  // SeaweedFS COLLECTION that needs a writable volume of its
                  // own — so the slot count is an upper bound on how many
                  // tenants can ever be onboarded. Staging hit it exactly:
                  // `/dir/status` reporting `Max:8 Free:0` with 9.6 GB of the
                  // 9.7 GB disk still free, the new org's collection listed
                  // with `writables: null`, and every upload — a 149 MB model
                  // and a 2 MB PDF alike — failing on the first write into it
                  // with a bare S3 `InternalError`. Disk space was never the
                  // constraint, so growing the PVC would have changed nothing.
                  //
                  // The count now comes from `volumeMaxCount` (64 by default,
                  // matching the split topology) so it is an operator knob on
                  // both topologies rather than a number only a code change can
                  // move.
                  //
                  // `volumeSizeLimitMB` is still deliberately NOT read here.
                  // Slots are a ceiling and cost nothing until used, but the
                  // size limit re-sizes the volumes a running single-node stack
                  // already holds — and prod runs `single`. That one stays a
                  // split-topology knob until someone wants it enough to write
                  // the migration note.
                  `exec weed server -dir=/data -volume.max=${cfg.seaweedfs.volumeMaxCount} -s3 ` +
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
                // The S3 gateway's own handler, on the port every consumer
                // actually uses — NOT the master's `/cluster/healthz`.
                //
                // `/cluster/healthz` answers `423 Locked` while the master holds
                // a topology child lock, which is an ordinary admin/volume
                // operation, and a kubelet reads 423 as a failed probe. The
                // liveness probe below already avoided it for that reason; the
                // readiness probe did not, and readiness is the WORSE place for
                // it: this pod is the only endpoint of the `seaweedfs` Service,
                // so a 423 removes the last endpoint and takes object storage
                // offline for the app tier, the purger, the edge and
                // `seaweedfs-bucket-init` at once — with nothing restarting and
                // no failing container to point at.
                //
                // `/healthz` on the S3 port is registered before any auth
                // wrapper in SeaweedFS 3.80 (`s3api_server.go`, under upstream's
                // own "// Readiness Probe" comment) and returns an unconditional
                // 200, so it reports this process's own ability to serve S3 and
                // nothing about its peers. `seaweedfs.spec.ts` asserts this rule
                // across both topologies, because it was already written down
                // here and still got broken.
                readinessProbe: {
                  httpGet: { path: "/healthz", port: PORT.seaweedS3 },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                  failureThreshold: 12,
                },
                // TCP, for the same reason readiness avoids the master: a
                // liveness failure here restarts the only storage pod there is.
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

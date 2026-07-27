import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";
import { BOOTSTRAP_JOB_RESOURCES, DATA_RESOURCES, JOB_DEFAULTS, PORT } from "../constants";

export interface SeaweedFS {
  statefulSet: k8s.apps.v1.StatefulSet;
  service: k8s.core.v1.Service;
  bucketInitJob: k8s.batch.v1.Job;
  /** In-cluster S3 endpoint (backend/frontend/purger consume this). */
  internalEndpoint: pulumi.Output<string>;
  /** Browser-reachable S3 endpoint used to sign presigned preview/download URLs. */
  publicEndpoint: pulumi.Output<string>;
}

/**
 * SeaweedFS S3-compatible object storage.
 *
 * DESIGN DECISION (the flagged risk): we keep the exact single-node topology
 * that is already proven in Docker Compose — one `weed server -s3` process
 * running master + volume + filer + the S3 gateway — but move its data onto a
 * durable Lightbits-backed PVC (via a StatefulSet volumeClaimTemplate) instead
 * of an ephemeral local volume. This is the lowest-risk faithful migration for
 * the app's modest object load. The scale-out path (split master/volume/filer
 * into separate StatefulSets, filer store on Postgres, N volume servers via the
 * upstream SeaweedFS Helm chart/operator) is documented in
 * docs/deployment/kubernetes.md and intentionally NOT adopted here.
 *
 * S3 identities come from a Secret (mounted as s3.json), mirroring the compose
 * bootstrap that generates s3.json from access/secret keys.
 */
export function installSeaweedFS(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  /** Extra buckets to pre-create alongside the documents bucket (e.g. PG backups). */
  extraBuckets: string[] = [],
): SeaweedFS {
  const labels = commonLabels("seaweedfs");

  // S3 identities config. Same shape the compose entrypoint printf-generates.
  const s3Config = pulumi
    .all([pulumi.output(cfg.seaweedfs.accessKey), cfg.seaweedfs.secretKey])
    .apply(([ak, sk]) =>
      JSON.stringify({
        identities: [
          {
            name: "grid",
            credentials: [{ accessKey: ak, secretKey: sk }],
            actions: ["Admin", "Read", "Write", "List", "Tagging"],
          },
        ],
      }),
    );

  const s3Secret = new k8s.core.v1.Secret(
    "seaweedfs-s3-config",
    {
      metadata: { name: "seaweedfs-s3-config", namespace },
      stringData: { "s3.json": s3Config },
    },
    { provider },
  );

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
      spec: {
        clusterIP: "None",
        selector: labels,
        ports: seaweedPorts,
      },
    },
    { provider },
  );

  const statefulSet = new k8s.apps.v1.StatefulSet(
    "seaweedfs",
    {
      metadata: { name: "seaweedfs", namespace, labels },
      spec: {
        serviceName: headless.metadata.name,
        replicas: 1,
        // The object store's only copy of every uploaded PDF lives on this PVC,
        // and the provider's StorageClasses reclaim `Delete`. Retain the PVC
        // across StatefulSet delete/scale so tearing down the workload never
        // cascades into irreversible data loss (matches the k8s default; pinned).
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            securityContext: { fsGroup: 1000 },
            containers: [
              {
                name: "seaweedfs",
                image: cfg.seaweedfs.image,
                command: ["/bin/sh", "-c"],
                args: [
                  // `-volume.max=0` is a trap: the volume server derives the
                  // number of slots from diskSize / volumeSizeLimit, so a small
                  // PVC yields 0 writable volumes and every upload fails with
                  // "No writable volumes and no free volumes left". Use an
                  // explicit, modest cap; SeaweedFS grows volumes lazily, so 8
                  // slots on a 10 Gi PVC is fine (they aren't pre-allocated).
                  "exec weed server -dir=/data -volume.max=8 -s3 " +
                    "-s3.config=/etc/seaweedfs/s3.json -s3.port=8333",
                ],
                ports: seaweedPorts.map((p) => ({ containerPort: p.port, name: p.name })),
                volumeMounts: [
                  { name: "data", mountPath: "/data" },
                  { name: "s3config", mountPath: "/etc/seaweedfs", readOnly: true },
                ],
                readinessProbe: {
                  httpGet: { path: "/cluster/status", port: 9333 },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                  failureThreshold: 12,
                },
                livenessProbe: {
                  httpGet: { path: "/cluster/status", port: 9333 },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                resources: DATA_RESOURCES.seaweedfs,
              },
            ],
            volumes: [
              { name: "s3config", secret: { secretName: s3Secret.metadata.name } },
            ],
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
    },
  );

  // Stable ClusterIP service clients resolve as `seaweedfs`.
  const service = new k8s.core.v1.Service(
    "seaweedfs",
    {
      metadata: { name: "seaweedfs", namespace, labels },
      spec: {
        selector: labels,
        ports: seaweedPorts,
      },
    },
    { provider, dependsOn: statefulSet },
  );

  // Pre-create the documents bucket (+ any extras, e.g. PG backups). SeaweedFS
  // does not auto-create on PUT. Idempotent: bucket-already-exists is a no-op.
  const buckets = [cfg.seaweedfs.bucket, ...extraBuckets];
  // `weed shell` exits 0 even when the command it ran FAILED (verified against
  // a live server: bad bucket name → "error: …" on stdout, exit 0; unknown
  // command → exit 0). Exit-code checks are therefore dead code. The only
  // reliable contract is POSITIVE VERIFICATION: run the create, then require
  // the bucket to appear in `s3.bucket.list` — that catches auth errors, filer
  // errors, and races identically. `timeout 120` bounds weed shell's silent
  // connect-block if a gRPC port regresses (also found live).
  const createBuckets = buckets
    .map(
      (b) =>
        `echo 's3.bucket.create -name ${b}' | timeout 120 weed shell -master=seaweedfs:9333 2>&1; ` +
        `if ! echo 's3.bucket.list' | timeout 120 weed shell -master=seaweedfs:9333 2>&1 | grep -q '^ *${b}'; ` +
        `then echo "FATAL: bucket ${b} missing after create"; exit 1; fi; ` +
        `echo "bucket ${b} verified"`,
    )
    // "; " — a bare space would butt commands together and produce
    // `/bin/sh: syntax error` (caught by the live smoke deploy).
    .join("; ");

  const bucketInitJob = new k8s.batch.v1.Job(
    "seaweedfs-bucket-init",
    {
      metadata: { namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels("seaweedfs-init") },
          spec: {
            enableServiceLinks: false,
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "bucket-init",
                image: cfg.seaweedfs.image,
                securityContext: hardenedJobSecurityContext(),
                resources: BOOTSTRAP_JOB_RESOURCES,
                command: ["/bin/sh", "-c"],
                args: [
                  "until wget -q -O /dev/null http://seaweedfs:9333/cluster/status; " +
                    "do echo waiting for seaweedfs; sleep 3; done; " +
                    createBuckets,
                ],
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: service },
  );

  return {
    statefulSet,
    service,
    bucketInitJob,
    internalEndpoint: pulumi.output("http://seaweedfs:8333"),
    publicEndpoint: pulumi.output(`https://${cfg.ingress.s3Domain}`),
  };
}

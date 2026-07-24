import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";

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
    { port: 8333, name: "s3" },
    { port: 9333, name: "master" },
    { port: 19333, name: "master-grpc" },
    { port: 8888, name: "filer" },
    { port: 18888, name: "filer-grpc" },
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
            securityContext: { fsGroup: 1000 },
            containers: [
              {
                name: "seaweedfs",
                image: "chrislusf/seaweedfs:latest",
                command: ["/bin/sh", "-c"],
                args: [
                  "exec weed server -dir=/data -volume.max=0 -s3 " +
                    "-s3.config=/etc/seaweedfs/s3.json -s3.port=8333",
                ],
                ports: [
                  { containerPort: 8333, name: "s3" },
                  { containerPort: 9333, name: "master" },
                  { containerPort: 19333, name: "master-grpc" },
                  { containerPort: 8888, name: "filer" },
                  { containerPort: 18888, name: "filer-grpc" },
                ],
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
                resources: {
                  requests: { cpu: "100m", memory: "256Mi" },
                  limits: { cpu: "1", memory: "1Gi" },
                },
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
    { provider, dependsOn: s3Secret },
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
  // One create per bucket, tolerating ONLY the idempotent "already exists" case
  // — a blanket `|| true` would hide a real failure (bad master/auth), report
  // success, and let the first upload 404 at runtime instead of failing deploy.
  const createBuckets = buckets
    .map(
      (b) =>
        // `timeout 120`: weed shell connect-blocks silently if it can't reach a
        // gRPC port — bound it so a connectivity regression fails the Job (and
        // the deploy) loudly instead of hanging the rollout forever.
        `out=$(echo 's3.bucket.create -name ${b}' | timeout 120 weed shell -master=seaweedfs:9333 2>&1); ` +
        'rc=$?; echo "$out"; ' +
        `if [ $rc -ne 0 ] && ! echo "$out" | grep -qi "already exists"; then exit $rc; fi`,
    )
    // "; " — a bare space would butt the next command against `fi` and produce
    // `/bin/sh: syntax error` (caught by the live smoke deploy).
    .join("; ");

  const bucketInitJob = new k8s.batch.v1.Job(
    "seaweedfs-bucket-init",
    {
      metadata: { namespace },
      spec: {
        backoffLimit: 10,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: commonLabels("seaweedfs-init") },
          spec: {
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "bucket-init",
                image: "chrislusf/seaweedfs:latest",
                securityContext: hardenedJobSecurityContext(),
                resources: {
                  requests: { cpu: "25m", memory: "64Mi" },
                  limits: { cpu: "250m", memory: "256Mi" },
                },
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

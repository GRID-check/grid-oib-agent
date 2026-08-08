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
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { DATA_RESOURCES, PORT, SEAWEED } from "../constants";
import type { SeaweedTopology } from "./seaweedfs-types";

/**
 * The split SeaweedFS topology (ADR-0043): master, volume and filer as three
 * workloads instead of one `weed server` process.
 *
 * ## Why split at all
 *
 * The single-node topology is one process holding four roles on one PVC. Three
 * things follow from that, and all three are why this module exists:
 *
 * 1. **Capacity is a PVC resize, not a replica count.** Object storage is the
 *    one tier that grows without bound, and it was the one tier that could only
 *    grow by editing a volume claim and hoping the CSI driver supported online
 *    expansion.
 * 2. **The chunk encryption keys share a disk with the ciphertext.** Chunk
 *    encryption generates a per-chunk AES-256-GCM key and stores it in the
 *    FILER metadata. With an embedded leveldb store on the volume PVC, anyone
 *    who obtains that PVC gets both halves. Separating the filer store is the
 *    entire difference between "crypto-erasure" and "at-rest protection".
 * 3. **Every role fails together.** A filer restart to change one flag takes
 *    the master and the volume server with it.
 *
 * ## What talks to what
 *
 * ```
 *   app tier ──S3:8333──►  filer pods  ──gRPC:19333──►  master pods
 *                              │                            ▲
 *                              └──HTTP:8080──► volume pods ──┘  (heartbeat)
 * ```
 *
 * The S3 gateway runs INSIDE the filer process (`weed filer -s3`) rather than
 * as a fourth workload. It is a stateless translator that does nothing but call
 * the filer, so a separate Deployment would add a network hop and a second
 * thing to scale for no isolation gain — the filer is already the unit that
 * scales with request rate.
 *
 * The filer workload keeps the bare name `seaweedfs` so that
 * `SEAWEED_ENDPOINT=http://seaweedfs:8333`, and the edge NetworkPolicy that
 * selects `app.kubernetes.io/name=seaweedfs`, both keep pointing at the pods
 * that actually serve S3.
 *
 * ## Two facts about `weed` that shape the manifests
 *
 * **Every pod must advertise a unique, directly dialable address.** Volume
 * servers register with the master under their `-ip` and the filer connects to
 * that address to move chunks; filers register under their `-ip` and peer
 * filers subscribe to it for metadata aggregation. Advertising a Service name
 * would collapse all replicas into one entry in the master's member map
 * (`cluster.AddClusterNode` keys by address) and quietly break both. Hence
 * StatefulSets with per-pod headless DNS, not Deployments.
 *
 * **Two of the three health endpoints are not self-scoped.** The master's
 * `/cluster/healthz` answers `423 Locked` while the leader holds a topology
 * lock during an admin operation, and the volume server's `/healthz` returns
 * 503 when a PEER holding a replica is unreachable. As liveness probes both
 * would restart healthy pods — the volume one cascading, since a node loss
 * would fail liveness on every surviving replica holder. Both are readiness
 * only here, with TCP liveness underneath. The filer's `/healthz` is the one
 * genuinely self-scoped check of the three (it round-trips its own store), so
 * it does both jobs.
 */

/**
 * Cluster-membership partition key. Filers only aggregate metadata from peers
 * in the same group, and `weed shell` filters by it too, so a mismatch produces
 * filers that silently never see each other's writes. One fixed value.
 */
const FILER_GROUP = "grid";

/** Where the filer and the gateway read `filer.toml` / `s3.json`. */
const CONFIG_DIR = "/etc/seaweedfs";

/**
 * `filer.toml` for the Postgres-backed namespace.
 *
 * `[postgres2]`, not `[postgres]`, for one reason that matters here: it sets
 * `SupportBucketTable`, giving each S3 bucket its own table. Dropping a bucket
 * becomes `DROP TABLE` instead of a row-by-row delete — which is what makes
 * per-tenant erasure an O(1) operation rather than a paginated sweep that can
 * half-finish. `[postgres]` also declines to create its own table at all.
 *
 * The `upsertQuery` override is NOT optional. SeaweedFS's shipped scaffold
 * defaults it to `UPSERT INTO "%[1]s" (…)`, which is CockroachDB syntax;
 * PostgreSQL rejects it outright. Turning `enableUpsert` off is not the escape
 * hatch it looks like either — the fallback path retries as an UPDATE only when
 * the driver error contains the literal text `duplicate entry`, which is
 * MySQL's wording. PostgreSQL says `duplicate key value violates unique
 * constraint`, so the fallback never fires and a concurrent insert surfaces as
 * a hard error instead. The statement below is the supported combination.
 */
function filerToml(cfg: GridConfig, host: string): pulumi.Output<string> {
  // TOML basic strings need `"` and `\` escaped, and cannot hold a raw
  // newline. `JSON.stringify` emits exactly TOML's escape set
  // (`\" \\ \b \f \n \r \t \uXXXX`), quotes included — so it is the
  // correct encoder here, not merely a convenient one.
  //
  // This is not hypothetical. The documented way to generate the password is
  // `openssl rand -base64 24`, whose alphabet is safe, but an operator who
  // pastes their own with a `"` in it would produce a filer.toml that fails to
  // parse. viper's failure mode for that is `glog.Fatalf`, so the filer would
  // crash-loop at startup with a message about the CONFIG FILE rather than
  // about the password — and object storage would be down.
  const q = (value: string): string => JSON.stringify(value);

  return cfg.seaweedfs.filerDatabasePassword.apply((password) =>
    [
      "[filer.options]",
      // `rm -rf` semantics on a directory DELETE. Left off: the S3 gateway
      // deletes bucket contents through its own recursive path, and the flag
      // would additionally arm the plain filer HTTP API.
      "recursive_delete = false",
      "",
      "[postgres2]",
      "enabled = true",
      'createTable = """',
      '  CREATE TABLE IF NOT EXISTS "%s" (',
      "    dirhash   BIGINT,",
      "    name      VARCHAR(65535),",
      "    directory VARCHAR(65535),",
      "    meta      bytea,",
      "    PRIMARY KEY (dirhash, name)",
      "  );",
      '"""',
      `hostname = ${q(host)}`,
      `port = ${PORT.postgres}`,
      `username = ${q(cfg.seaweedfs.filerDatabaseUser)}`,
      `password = ${q(password)}`,
      `database = ${q(cfg.seaweedfs.filerDatabase)}`,
      'schema = ""',
      // Same posture as every other DSN in the program: encrypt, do not verify
      // the CA. CNPG serves TLS with its own internal CA; `require` closes the
      // passive-sniff hole without shipping that CA to a sixth client.
      'sslmode = "require"',
      // Per filer replica. Keep replicas x max_open comfortably under the
      // cluster's max_connections, which the app tier also draws from.
      "connection_max_idle = 10",
      "connection_max_open = 40",
      "connection_max_lifetime_seconds = 3600",
      "enableUpsert = true",
      'upsertQuery = """INSERT INTO "%[1]s" (dirhash,name,directory,meta) VALUES($1,$2,$3,$4) ' +
        'ON CONFLICT (dirhash,name) DO UPDATE SET directory=EXCLUDED.directory, meta=EXCLUDED.meta"""',
      "",
    ].join("\n"),
  );
}

/** `filer.toml` for the embedded store — the no-Postgres fallback. */
function leveldbFilerToml(): string {
  return [
    "[filer.options]",
    "recursive_delete = false",
    "",
    "[leveldb2]",
    "enabled = true",
    'dir = "/data/filerldb2"',
    "",
  ].join("\n");
}

/** Downward-API env every weed pod uses to advertise itself. */
const IDENTITY_ENV: k8s.types.input.core.v1.EnvVar[] = [
  { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
  { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
  // The volume server reports this as its `-rack`, which is what lets a `010`
  // replica placement mean "two different machines" instead of "two pods".
  { name: "NODE_NAME", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } },
];

/** Headless Service giving a StatefulSet's pods individually resolvable DNS. */
function peerService(
  name: string,
  namespace: pulumi.Input<string>,
  provider: k8s.Provider,
  labels: pulumi.Input<{ [k: string]: string }>,
  ports: Array<{ port: number; name: string }>,
): k8s.core.v1.Service {
  return new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        clusterIP: "None",
        selector: labels,
        ports,
        // Peers must resolve BEFORE they are ready: a master needs to reach its
        // fellow raft members to hold the election that makes any of them
        // ready, and with this false the DNS records simply do not exist until
        // then. That is a bootstrap deadlock, not a slow start.
        publishNotReadyAddresses: true,
      },
    },
    { provider },
  );
}

export function installSplitSeaweedFS(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  s3Secret: k8s.core.v1.Secret,
  /** Digest of the rendered `s3.json`, so a key rotation rolls the pods. */
  s3Checksum: pulumi.Output<string>,
  /** CNPG read/write host, for the Postgres filer store. */
  postgresHost: string,
  /** Gate the filer on the filer database and role existing. */
  filerStoreDeps: pulumi.Resource[],
): SeaweedTopology {
  const masterLabels = commonLabels(SEAWEED.master);
  const volumeLabels = commonLabels(SEAWEED.volume);
  // The filer keeps the bare `seaweedfs` name — see the header note.
  const filerLabels = commonLabels(SEAWEED.filer);

  const masterPorts = [
    { port: PORT.seaweedMaster, name: "master" },
    { port: PORT.seaweedMasterGrpc, name: "master-grpc" },
  ];
  const volumePorts = [
    { port: PORT.seaweedVolume, name: "volume" },
    { port: PORT.seaweedVolumeGrpc, name: "volume-grpc" },
  ];
  const filerPorts = [
    { port: PORT.seaweedS3, name: "s3" },
    { port: PORT.seaweedFiler, name: "filer" },
    { port: PORT.seaweedFilerGrpc, name: "filer-grpc" },
  ];

  // ── Master ────────────────────────────────────────────────────────────────
  const masterPeer = peerService(SEAWEED.masterPeer, namespace, provider, masterLabels, masterPorts);

  // Raft peer list, by stable per-pod DNS. Every master must see the same list
  // or they form separate single-node clusters that each believe they are the
  // leader — and, because each answers healthily, nothing reports a problem.
  const masterPeers = pulumi
    .output(namespace)
    .apply((ns) =>
      Array.from(
        { length: cfg.seaweedfs.masterReplicas },
        (_, i) =>
          `${SEAWEED.master}-${i}.${SEAWEED.masterPeer}.${ns}.svc.cluster.local:${PORT.seaweedMaster}`,
      ).join(","),
    );

  const masterArgs = pulumi.interpolate`exec weed master \
 -mdir=/data \
 -ip=$(POD_NAME).${SEAWEED.masterPeer}.$(POD_NAMESPACE).svc.cluster.local \
 -ip.bind=0.0.0.0 \
 -port=${PORT.seaweedMaster} \
 -peers=${masterPeers} \
 -volumeSizeLimitMB=${cfg.seaweedfs.volumeSizeLimitMB} \
 -defaultReplication=${cfg.seaweedfs.defaultReplication}`;

  const master = new k8s.apps.v1.StatefulSet(
    "seaweedfs-master",
    {
      metadata: { name: SEAWEED.master, namespace, labels: masterLabels },
      spec: {
        serviceName: masterPeer.metadata.name,
        replicas: cfg.seaweedfs.masterReplicas,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: masterLabels },
        template: {
          metadata: { labels: masterLabels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            securityContext: { fsGroup: 1000 },
            topologySpreadConstraints: spreadAcrossNodes(masterLabels),
            ...gracefulShutdown(ROLLOUT.dataPlane),
            containers: [
              {
                name: "master",
                image: cfg.seaweedfs.image,
                imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                command: ["/bin/sh", "-c"],
                args: [masterArgs],
                env: IDENTITY_ENV,
                ports: masterPorts.map((p) => ({ containerPort: p.port, name: p.name })),
                volumeMounts: [{ name: "data", mountPath: "/data" }],
                // `/cluster/healthz` answers 423 Locked while this master holds
                // a topology child lock, and 503 while no leader is elected.
                // Neither is self-scoped, which is why it is not the liveness
                // probe — and with ONE master it should not be the readiness
                // probe either: that master is the only endpoint of the
                // `seaweedfs-master` Service, which the volume servers, the
                // filer and every `weed shell` resolve. 60s of 423 during an
                // ordinary admin operation would empty the Service and fail
                // every new master connection in the cluster.
                //
                // With a quorum the calculus flips: a locked or leaderless
                // member SHOULD leave the Service, because the others can serve.
                readinessProbe:
                  cfg.seaweedfs.masterReplicas > 1
                    ? {
                        httpGet: { path: "/cluster/healthz", port: PORT.seaweedMaster },
                        initialDelaySeconds: 5,
                        periodSeconds: 5,
                        failureThreshold: 12,
                      }
                    : {
                        tcpSocket: { port: PORT.seaweedMaster },
                        initialDelaySeconds: 5,
                        periodSeconds: 5,
                        failureThreshold: 12,
                      },
                // TCP, not `/cluster/healthz`. That endpoint answers 423 Locked
                // while this master is the leader and the topology holds a
                // child lock — i.e. during an ordinary admin or volume
                // operation — and a kubelet reads 423 as a failure. Using it
                // for liveness restarts the leader in the middle of the work it
                // is coordinating.
                livenessProbe: {
                  tcpSocket: { port: PORT.seaweedMaster },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                resources: DATA_RESOURCES.seaweedfsMaster,
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
              resources: { requests: { storage: cfg.seaweedfs.masterStorageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: masterPeer,
      // volumeClaimTemplates are immutable; see the note in seaweedfs.ts.
      ignoreChanges: ["spec.volumeClaimTemplates"],
      deleteBeforeReplace: true,
      protect: cfg.protectDataResources,
    },
  );

  const masterService = new k8s.core.v1.Service(
    "seaweedfs-master-svc",
    {
      metadata: { name: SEAWEED.master, namespace, labels: masterLabels },
      spec: { selector: masterLabels, ports: masterPorts },
    },
    { provider, dependsOn: master },
  );

  const masterAddress = `${SEAWEED.master}:${PORT.seaweedMaster}`;

  // ── Volume servers ────────────────────────────────────────────────────────
  const volumePeer = peerService(SEAWEED.volumePeer, namespace, provider, volumeLabels, volumePorts);

  const volumeArgs = pulumi.interpolate`exec weed volume \
 -dir=/data \
 -max=${cfg.seaweedfs.volumeMaxCount} \
 -mserver=${masterAddress} \
 -ip=$(POD_NAME).${SEAWEED.volumePeer}.$(POD_NAMESPACE).svc.cluster.local \
 -ip.bind=0.0.0.0 \
 -port=${PORT.seaweedVolume} \
 -rack=$(NODE_NAME) \
 -minFreeSpace=${cfg.seaweedfs.volumeMinFreeSpace}`;

  const volume = new k8s.apps.v1.StatefulSet(
    "seaweedfs-volume",
    {
      metadata: { name: SEAWEED.volume, namespace, labels: volumeLabels },
      spec: {
        serviceName: volumePeer.metadata.name,
        replicas: cfg.seaweedfs.volumeReplicas,
        // Every uploaded byte lives here and the provider's StorageClasses
        // reclaim `Delete`. Retain on both delete and scale-down: scaling in
        // must never be the thing that destroys data.
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: volumeLabels },
        template: {
          metadata: { labels: volumeLabels },
          spec: {
            enableServiceLinks: false,
            securityContext: { fsGroup: 1000 },
            // Two copies of a chunk on one node is one copy. This is what makes
            // `-rack=$(NODE_NAME)` mean something.
            topologySpreadConstraints: spreadAcrossNodes(volumeLabels),
            ...gracefulShutdown(ROLLOUT.dataPlane),
            containers: [
              {
                name: "volume",
                image: cfg.seaweedfs.image,
                imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                command: ["/bin/sh", "-c"],
                args: [volumeArgs],
                env: IDENTITY_ENV,
                ports: volumePorts.map((p) => ({ containerPort: p.port, name: p.name })),
                volumeMounts: [{ name: "data", mountPath: "/data" }],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: PORT.seaweedVolume },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  failureThreshold: 12,
                },
                // Again TCP rather than `/healthz`, and here the reason is
                // worse than the master's: the volume server's healthz checks
                // whether the PEERS holding replicas of its volumes are
                // reachable. One node going away would fail liveness on every
                // surviving replica holder at once, and the kubelet would
                // restart them — turning a single node loss into a full storage
                // outage.
                livenessProbe: {
                  tcpSocket: { port: PORT.seaweedVolume },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                },
                resources: DATA_RESOURCES.seaweedfsVolume,
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
              resources: { requests: { storage: cfg.seaweedfs.storageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: [volumePeer, master],
      ignoreChanges: ["spec.volumeClaimTemplates"],
      deleteBeforeReplace: true,
      protect: cfg.protectDataResources,
    },
  );

  // ── Filer + S3 gateway ────────────────────────────────────────────────────
  const usePostgres = cfg.seaweedfs.filerStore === "postgres";

  const filerConfigSecret = new k8s.core.v1.Secret(
    "seaweedfs-filer-config",
    {
      metadata: { name: "seaweedfs-filer-config", namespace },
      stringData: {
        "filer.toml": usePostgres
          ? filerToml(cfg, postgresHost)
          : pulumi.output(leveldbFilerToml()),
      },
    },
    { provider },
  );

  const filerPeer = peerService(SEAWEED.filerPeer, namespace, provider, filerLabels, filerPorts);

  const filerArgs = pulumi.interpolate`exec weed -config_dir=${CONFIG_DIR} filer \
 -master=${masterAddress} \
 -filerGroup=${FILER_GROUP} \
 -ip=$(POD_NAME).${SEAWEED.filerPeer}.$(POD_NAMESPACE).svc.cluster.local \
 -ip.bind=0.0.0.0 \
 -port=${PORT.seaweedFiler} \
 -defaultStoreDir=/data \
 -s3 \
 -s3.config=${CONFIG_DIR}/s3.json \
 -s3.port=${PORT.seaweedS3}${cfg.seaweedfs.encryptVolumeData ? " -encryptVolumeData" : ""}`;

  const filer = new k8s.apps.v1.StatefulSet(
    "seaweedfs-filer",
    {
      metadata: { name: SEAWEED.filer, namespace, labels: filerLabels },
      spec: {
        serviceName: filerPeer.metadata.name,
        replicas: cfg.seaweedfs.filerReplicas,
        persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
        ...orderedRollout(ROLLOUT.dataPlane),
        selector: { matchLabels: filerLabels },
        template: {
          metadata: { labels: filerLabels, annotations: secretChecksumAnnotations(s3Checksum) },
          spec: {
            enableServiceLinks: false,
            securityContext: { fsGroup: 1000 },
            topologySpreadConstraints: spreadAcrossNodes(filerLabels),
            // The filer buffers its metadata change log in memory and flushes
            // once a minute. A hard kill loses up to a minute of change-LOG
            // records — the entries themselves are already committed to the
            // store, but the offsite mirror subscribes to that log, so those
            // writes would never reach the backup and nothing would say so.
            // `weed` flushes the buffer on SIGTERM; the grace period is what
            // gives it time to finish.
            ...gracefulShutdown(ROLLOUT.dataPlane),
            containers: [
              {
                name: "filer",
                image: cfg.seaweedfs.image,
                imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                command: ["/bin/sh", "-c"],
                args: [filerArgs],
                env: IDENTITY_ENV,
                ports: filerPorts.map((p) => ({ containerPort: p.port, name: p.name })),
                volumeMounts: [
                  { name: "config", mountPath: CONFIG_DIR, readOnly: true },
                  { name: "filer-data", mountPath: "/data" },
                ],
                // The one self-scoped health endpoint in the cluster: it
                // round-trips the filer's OWN store (a lookup of /topics), so a
                // filer whose database connection has broken is taken out of
                // the Service instead of answering 500s.
                readinessProbe: {
                  httpGet: { path: "/healthz", port: PORT.seaweedFiler },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  failureThreshold: 12,
                },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: PORT.seaweedFiler },
                  initialDelaySeconds: 30,
                  // Every probe is a database round trip; do not make it a load
                  // source.
                  periodSeconds: 30,
                  failureThreshold: 4,
                },
                resources: DATA_RESOURCES.seaweedfsFiler,
              },
            ],
            volumes: [
              // TWO Secrets, both mounted at CONFIG_DIR's children rather than
              // one over the other: `filer.toml` (the store) and `s3.json` (the
              // identities). The gateway runs inside this process, and
              // `NewIdentityAccessManagement` calls `glog.Fatalf` when
              // `-s3.config` names a file it cannot read — so a missing s3.json
              // does not degrade the S3 API, it kills the filer. Kubernetes
              // cannot merge two Secrets into one mount path, hence `projected`.
              {
                name: "config",
                projected: {
                  sources: [
                    { secret: { name: filerConfigSecret.metadata.name } },
                    { secret: { name: s3Secret.metadata.name } },
                  ],
                },
              },
            ],
          },
        },
        // Declared in BOTH store modes, and unused under `postgres`. That is
        // deliberate: volumeClaimTemplates are immutable, so a template that
        // appears only in leveldb mode would make switching stores a
        // StatefulSet REPLACE — deleting the running filer — rather than a
        // rolling update. One shape, one Gi, no replace.
        //
        // Named `filer-data`, NOT `data`, and that is load-bearing during the
        // single→split migration. A StatefulSet's PVC is named
        // `<template>-<statefulset>-<ordinal>`, and this workload deliberately
        // keeps the name `seaweedfs` — so a template called `data` would claim
        // `data-seaweedfs-0`, which is EXACTLY the PVC the single-node
        // StatefulSet leaves behind (retained on purpose, because it holds
        // every object in the deployment). The new filer would silently adopt
        // 20 Gi of old volume files it has no use for, and the migration would
        // find its source PVC already mounted by the thing it is migrating to.
        volumeClaimTemplates: [
          {
            metadata: { name: "filer-data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: cfg.storage.className,
              resources: { requests: { storage: cfg.seaweedfs.masterStorageSize } },
            },
          },
        ],
      },
    },
    {
      provider,
      dependsOn: [filerPeer, filerConfigSecret, s3Secret, master, volume, ...filerStoreDeps],
      ignoreChanges: ["spec.volumeClaimTemplates"],
      deleteBeforeReplace: true,
      protect: cfg.protectDataResources,
    },
  );

  const service = new k8s.core.v1.Service(
    "seaweedfs",
    {
      metadata: { name: SEAWEED.filer, namespace, labels: filerLabels },
      spec: { selector: filerLabels, ports: filerPorts },
    },
    { provider, dependsOn: filer },
  );

  // PDBs only where they can help. A single-replica tier gets none on purpose:
  // `maxUnavailable: 1` there is a no-op, but any tighter budget would block a
  // node drain forever and deadlock the provider's automatic upgrades.
  const pdbs: k8s.policy.v1.PodDisruptionBudget[] = [];
  if (cfg.seaweedfs.masterReplicas > 1) {
    pdbs.push(installPdb("seaweedfs-master-pdb", namespace, provider, masterLabels, [master]));
  }
  if (cfg.seaweedfs.volumeReplicas > 1) {
    pdbs.push(installPdb("seaweedfs-volume-pdb", namespace, provider, volumeLabels, [volume]));
  }
  if (cfg.seaweedfs.filerReplicas > 1) {
    pdbs.push(installPdb("seaweedfs-filer-pdb", namespace, provider, filerLabels, [filer]));
  }

  return {
    workloads: [master, volume, filer],
    service,
    masterService,
    masterAddress,
    filerAddress: `${SEAWEED.filer}:${PORT.seaweedFiler}`,
    pdbs,
  };
}

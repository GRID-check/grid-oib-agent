import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS } from "../constants";

export interface SeaweedFSBackup {
  objectMirror?: k8s.apps.v1.Deployment;
  metadataSnapshot?: k8s.batch.v1.CronJob;
}

/**
 * Backup for the documents bucket.
 *
 * WHY THIS EXISTS: until now `grid-documents` had no backup of any kind, while
 * Postgres had continuous PITR — whose archive also lands in this same
 * SeaweedFS. One volume loss therefore took the documents AND the database
 * backups with it. This module is the fix.
 *
 * THE HONEST LIMITATION, up front: SeaweedFS cannot take a consistent
 * point-in-time backup of a bucket. The namespace (filer metadata) and the
 * bytes (volume files) are separate subsystems with no coordinated snapshot,
 * and the project's own Data-Backup page tells you to pause writes if you want
 * the two halves to agree. Nothing below changes that. What these two layers
 * give you is a continuously-converging offsite copy plus a metadata snapshot,
 * which is what recovers you from cluster loss, an accidental bulk delete, or a
 * botched migration — the three things that actually happen.
 *
 * LAYER A — `weed filer.backup`, a long-running one-way mirror into an external
 * S3 bucket. Runs as a Deployment, not a Job: it is a streaming subscriber, not
 * a batch copy.
 *
 *   ⚠️ It has NO initial full-copy phase. It replays the filer's metadata change
 *   log (`/topics/.system/log/...`) from the beginning of time, so it converges
 *   to a full mirror ONLY while that log is intact. `fs.log.purge` — or moving
 *   to a new filer store via `fs.meta.load`, which does not regenerate the log —
 *   silently leaves the mirror with an incomplete baseline and reports nothing.
 *   After the first sync settles, COMPARE OBJECT COUNTS against the source. "The
 *   pod is running" is not evidence that anything was copied.
 *
 *   `is_incremental = true` is deliberate: files land under `YYYY-MM-DD/`
 *   directories and deletions are NOT propagated. A plain mirror faithfully
 *   replicates `rm -rf`; this does not, which is the entire point of a backup.
 *
 *   With more than one filer replica this still holds, and for a reason worth
 *   knowing: each filer writes its change log into the SHARED filer store, as
 *   ordinary entries under `/topics/.system/log/<date>/<HH-MM>.<filerId>`. A
 *   subscriber attached to filer A therefore replays filer B's history too —
 *   `collectPersistedLogBuffer` enumerates every producer's files and merges
 *   them by timestamp. What it cannot replay is the last ≤60s a filer buffered
 *   in memory and never flushed, which is why the filer pods get a real grace
 *   period rather than being SIGKILLed.
 *
 * LAYER B — `fs.meta.save`, SeaweedFS's own point-in-time primitive. It dumps
 * the whole namespace to one file. Metadata ONLY: the dump references chunk
 * file-ids, so it restores nothing on its own and is worthless without matching
 * volume data. Its job is to make a bad migration or filer-store corruption
 * recoverable.
 *
 *   With the split topology's Postgres filer store this stops being the ONLY
 *   path back: the namespace is then ordinary rows in a CNPG database with
 *   continuous WAL archiving, so it inherits real point-in-time recovery. The
 *   dump stays anyway — it is portable across filer stores and is what makes a
 *   store MIGRATION (leveldb → Postgres, or back) recoverable, which a Postgres
 *   PITR of a database that did not yet exist cannot be.
 *
 * RESTORE is documented in docs/deployment/kubernetes.md. Read it before you
 * need it — the two layers restore by DIFFERENT procedures and mixing them
 * produces a namespace full of dangling chunk references.
 */
export function installSeaweedFSBackup(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
  /**
   * Where the master and the filer actually live. Passed in rather than
   * hardcoded because the split topology puts them on different Services from
   * the S3 endpoint, and `weed shell` pointed at a port nothing listens on
   * BLOCKS rather than failing — so getting these wrong produces a backup that
   * appears to be running and copies nothing.
   */
  addresses: { master: string; filer: string },
): SeaweedFSBackup {
  const backup = cfg.seaweedfs.backup;
  if (!backup.enabled) return {};

  const labels = commonLabels("seaweedfs-backup");

  // `replication.toml` drives the sink. Credentials are read from the file, so
  // it is a Secret rather than a ConfigMap even though most of it is not secret.
  const replicationToml = pulumi
    .all([
      pulumi.output(backup.endpoint),
      pulumi.output(backup.bucket),
      pulumi.output(backup.region),
      backup.accessKey,
      backup.secretKey,
    ])
    .apply(([endpoint, bucket, region, ak, sk]) =>
      [
        "[sink.s3]",
        "enabled = true",
        `aws_access_key_id = "${ak}"`,
        `aws_secret_access_key = "${sk}"`,
        `region = "${region}"`,
        `bucket = "${bucket}"`,
        'directory = "/"',
        `endpoint = "${endpoint}"`,
        // Versioned history rather than a mirror — see the header note.
        "is_incremental = true",
        "",
      ].join("\n"),
    );

  const configSecret = new k8s.core.v1.Secret(
    "seaweedfs-backup-config",
    {
      metadata: { name: "seaweedfs-backup-config", namespace },
      stringData: { "replication.toml": replicationToml },
    },
    { provider },
  );

  // Layer A. One replica, always: two `filer.backup` processes against the same
  // sink share a checkpoint key (a hash of sink name + directory) held on the
  // SOURCE filer, so a second replica does not double throughput — it fights
  // the first one over that checkpoint.
  const objectMirror = new k8s.apps.v1.Deployment(
    "seaweedfs-backup",
    {
      metadata: { name: "seaweedfs-backup", namespace, labels },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false,
            containers: [
              {
                name: "filer-backup",
                image: cfg.seaweedfs.image,
                imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                securityContext: hardenedJobSecurityContext(),
                command: ["/bin/sh", "-c"],
                args: [
                  `until wget -q -O /dev/null http://${addresses.filer}/healthz; ` +
                    "do echo waiting for seaweedfs filer; sleep 3; done; " +
                    // -filerPath=/buckets confines the mirror to bucket data:
                    // /topics (the change log) and /etc (IAM identities) are
                    // filer-internal and would be noise in a restore.
                    "exec weed -config_dir=/etc/seaweedfs/backup filer.backup " +
                    `-filer=${addresses.filer} -filerPath=/buckets`,
                ],
                volumeMounts: [
                  { name: "backup-config", mountPath: "/etc/seaweedfs/backup", readOnly: true },
                ],
                resources: BOOTSTRAP_JOB_RESOURCES,
              },
            ],
            volumes: [
              { name: "backup-config", secret: { secretName: configSecret.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, configSecret] },
  );

  // Layer B. `weed shell` EXITS 0 EVEN WHEN THE COMMAND INSIDE IT FAILED — the
  // same trap the bucket-init Job documents. The only reliable contract is
  // positive verification, so this asserts the dump exists and is non-empty
  // before calling the run a success, and writes it back into the documents
  // bucket so Layer A carries it offsite with everything else.
  const snapshotScript = pulumi.interpolate`
set -e
OUT=/tmp/filer-meta.$(date +%Y-%m-%dT%H-%M-%S).meta
echo "fs.meta.save -o $OUT /" | timeout 600 weed shell -master=${addresses.master} 2>&1
if [ ! -s "$OUT" ]; then echo "FATAL: metadata dump missing or empty"; exit 1; fi
echo "metadata dump $(wc -c < "$OUT") bytes"
weed filer.copy -filer=${addresses.filer} "$OUT" /buckets/${cfg.seaweedfs.bucket}/_meta-snapshots/
echo "metadata snapshot stored"
`;

  const metadataSnapshot = new k8s.batch.v1.CronJob(
    "seaweedfs-meta-snapshot",
    {
      metadata: { name: "seaweedfs-meta-snapshot", namespace, labels },
      spec: {
        schedule: backup.metadataSchedule,
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: JOB_DEFAULTS.backoffLimit,
            ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
            template: {
              metadata: { labels: commonLabels("seaweedfs-meta-snapshot") },
              spec: {
                enableServiceLinks: false,
                restartPolicy: "OnFailure",
                containers: [
                  {
                    name: "meta-snapshot",
                    image: cfg.seaweedfs.image,
                    imagePullPolicy: pullPolicyFor(cfg.seaweedfs.image),
                    securityContext: hardenedJobSecurityContext(),
                    resources: BOOTSTRAP_JOB_RESOURCES,
                    command: ["/bin/sh", "-c"],
                    args: [snapshotScript],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { provider, dependsOn },
  );

  return { objectMirror, metadataSnapshot };
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedJobSecurityContext } from "../platform/security";
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, PORT, SEAWEED } from "../constants";
import { secretChecksum } from "../platform/rollout";
import { renderS3Config, s3ConfigSecret } from "./seaweedfs-identities";
import { installSingleNodeSeaweedFS } from "./seaweedfs-single";
import { filerToml, installSplitSeaweedFS, leveldbFilerToml } from "./seaweedfs-split";
import type { SeaweedTopology } from "./seaweedfs-types";

export interface SeaweedFS extends SeaweedTopology {
  bucketInitJob: k8s.batch.v1.Job;
  /** In-cluster S3 endpoint (backend/frontend/purger consume this). */
  internalEndpoint: pulumi.Output<string>;
  /** Browser-reachable S3 endpoint used to sign presigned preview/download URLs. */
  publicEndpoint: pulumi.Output<string>;
}

/**
 * SeaweedFS S3-compatible object storage.
 *
 * This module owns the parts that do not depend on the layout — the S3 identity
 * set and the bucket bootstrap — and dispatches the layout itself to one of two
 * topologies (ADR-0043):
 *
 * - `seaweedfs-single.ts` — one `weed server -s3` process on one PVC. What
 *   every deployment ran before ADR-0043, kept intact so an existing stack sees
 *   no change until its operator chooses one.
 * - `seaweedfs-split.ts` — master / volume / filer as separate workloads, with
 *   the filer namespace on Postgres. Volume capacity becomes a replica count,
 *   and the per-chunk encryption keys stop sharing a disk with the ciphertext.
 *
 * **Switching between them is a data migration.** The topologies use different
 * PVCs, so a stack that flips the knob without running the migration in
 * `docs/deployment/kubernetes.md` comes up with an empty object store while the
 * old data sits on a claim nothing mounts. Nothing errors, which is precisely
 * what makes it dangerous — hence the runbook and the pinned value in each
 * existing stack's own `Pulumi.<stack>.yaml`.
 */
export function installSeaweedFS(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  /** Extra buckets to pre-create alongside the documents bucket (e.g. PG backups). */
  extraBuckets: string[] = [],
  /** CNPG read/write host, for the split topology's Postgres filer store. */
  postgresHost = "",
  /** Gate the filer on the filer database and role existing. */
  filerStoreDeps: pulumi.Resource[] = [],
): SeaweedFS {
  // Buckets this stack creates and grants outright. Per-organization buckets
  // are created at runtime by the application and are granted by prefix
  // instead — see seaweedfs-identities.ts.
  const platformBuckets = [cfg.seaweedfs.bucket, ...extraBuckets];

  const identityInputs = {
    platformBuckets,
    // NOT gated on `perOrgBuckets`. The grant is a bucket-name PREFIX, so when
    // the feature is off it covers nothing — and when the feature is turned off
    // AFTER having been on, it covers exactly the tenant buckets that still
    // hold objects. Gating it there would revoke read access to every document
    // written while the flag was on, which is the opposite of the "flipping
    // back is uneventful" property the row-recorded bucket exists to provide.
    tenantBucketPrefix: cfg.seaweedfs.tenantBucketPrefix,
    // The bucket-LIFECYCLE identity is gated, because creating buckets is the
    // one thing that genuinely stops when the feature is off.
    provisioning: cfg.seaweedfs.perOrgBuckets,
  };
  const s3Secret = s3ConfigSecret(cfg, provider, namespace, identityInputs);

  // Rotating a credential updates the Secret and restarts nothing: both config
  // files are read ONCE, at process start, so `pulumi up` would report success
  // while every pod kept using the value that had just been retired. Stamping a
  // digest of the rendered content on the pod template turns a rotation into an
  // ordinary gated rolling update (see platform/rollout.ts).
  //
  // BOTH files, not just `s3.json`. They are projected into the same volume and
  // read by the same process, and `filer.toml` carries the Postgres password —
  // whose rotation is the quieter of the two failures: the filer keeps its
  // existing connection pool, so the auth errors begin a
  // `connection_max_lifetime` later, an hour after the deploy that "succeeded".
  const configChecksum = secretChecksum({
    "s3.json": renderS3Config(cfg, identityInputs),
    "filer.toml":
      cfg.seaweedfs.topology === "split" && cfg.seaweedfs.filerStore === "postgres"
        ? filerToml(cfg, postgresHost)
        : pulumi.output(leveldbFilerToml()),
  });

  const topology =
    cfg.seaweedfs.topology === "split"
      ? installSplitSeaweedFS(
          cfg,
          provider,
          namespace,
          s3Secret,
          configChecksum,
          postgresHost,
          filerStoreDeps,
        )
      : installSingleNodeSeaweedFS(cfg, provider, namespace, s3Secret, configChecksum);

  // Pre-create the platform buckets. SeaweedFS does not auto-create on PUT.
  // Idempotent: bucket-already-exists is a no-op.
  //
  // `weed shell` exits 0 even when the command it ran FAILED (verified against
  // a live server: bad bucket name → "error: …" on stdout, exit 0; unknown
  // command → exit 0). Exit-code checks are therefore dead code. The only
  // reliable contract is POSITIVE VERIFICATION: run the create, then require
  // the bucket to appear in `s3.bucket.list` — that catches auth errors, filer
  // errors, and races identically. `timeout 120` bounds weed shell's silent
  // connect-block if a gRPC port regresses (also found live).
  const master = topology.masterAddress;
  const createBuckets = platformBuckets
    .map(
      (b) =>
        `echo 's3.bucket.create -name ${b}' | timeout 120 weed shell -master=${master} 2>&1; ` +
        `if ! echo 's3.bucket.list' | timeout 120 weed shell -master=${master} 2>&1 | grep -q '^ *${b}'; ` +
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
                  // Wait on the MASTER, which under the split topology is not
                  // the same host as the S3 endpoint. `s3.bucket.create` writes
                  // through the filer, so wait for that too — a master that is
                  // up with no filer registered answers the shell command with
                  // an error and (see above) exit 0.
                  `until wget -q -O /dev/null http://${master}/cluster/status; ` +
                    "do echo waiting for seaweedfs master; sleep 3; done; " +
                    `until wget -q -O /dev/null http://${topology.filerAddress}/healthz; ` +
                    "do echo waiting for seaweedfs filer; sleep 3; done; " +
                    createBuckets,
                ],
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [topology.service, topology.masterService] },
  );

  return {
    ...topology,
    bucketInitJob,
    internalEndpoint: pulumi.output(`http://${SEAWEED.filer}:${PORT.seaweedS3}`),
    publicEndpoint: pulumi.output(`https://${cfg.ingress.s3Domain}`),
  };
}

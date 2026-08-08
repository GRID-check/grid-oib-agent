import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";

/**
 * The SeaweedFS S3 identity set — who can touch which bucket.
 *
 * Extracted from `seaweedfs.ts` because both topologies mount the same file and
 * because the rules below are the actual tenant-isolation boundary at the
 * storage layer; they deserve to be read on their own.
 *
 * ## How SeaweedFS matches an action
 *
 * `Identity.canDo` (weed/s3api/auth_credentials.go) builds
 * `target = "<Action>:<bucket><objectKey>"` and then, for each action on the
 * identity:
 *
 * - if the action ends in `*`, it matches when `target` has the action minus
 *   the star as a PREFIX;
 * - otherwise it matches only `"<Action>:<bucket>"` exactly;
 * - and an `Admin:<bucket>` (or `Admin:<prefix>*`) satisfies EVERY action on
 *   that bucket, including `DeleteBucket`.
 *
 * Two consequences drive everything here. First, a BARE action — `"Read"` with
 * no colon — is compared with `a == action` before the bucket is ever
 * considered, so it matches every bucket in the deployment. That is not a
 * scoped grant; it is a blanket one. Second, the trailing-star form is what
 * makes per-organization buckets expressible at all: we cannot enumerate
 * buckets that will be created at runtime, but we can grant a prefix.
 *
 * ## The identities
 *
 * | name | holder | grant |
 * |---|---|---|
 * | `grid` | BFF, purger, PG backups | object CRUD on the platform buckets and, when enabled, every tenant bucket. No `Admin` — it cannot create or drop a bucket. |
 * | `grid-backend-read` | aiq-agent tier (ADR-0039) | `Read` on document buckets ONLY. |
 * | `grid-tenant-admin` | provisioning + purge paths | `Admin` on the tenant bucket PREFIX and nothing else. |
 *
 * The split between `grid` and `grid-tenant-admin` is the point: SeaweedFS
 * cannot express "may create a bucket but not delete one" — `Admin:<bucket>`
 * authorises both — so the only way to keep `DeleteBucket` away from the
 * ordinary request path is to keep it on a different credential.
 */

/** Actions that make up ordinary object CRUD (no bucket lifecycle). */
const OBJECT_ACTIONS = ["Read", "Write", "List", "Tagging"] as const;

export interface S3IdentityInputs {
  /** Buckets this stack creates itself and grants `grid` outright. */
  platformBuckets: string[];
  /**
   * Bucket-name prefix for per-organization buckets. Always granted, whether or
   * not the feature is currently enabled — the grant is a PREFIX, so it covers
   * nothing when no tenant bucket exists, and covers exactly the right set when
   * the feature was on and has since been turned off. Gating it there would
   * revoke read access to every document written while it was on, which would
   * make the rollback the row-recorded bucket exists to keep safe unsafe again.
   */
  tenantBucketPrefix: string;
  /**
   * Whether this deployment CREATES tenant buckets. Gates only the lifecycle
   * identity, because creating buckets is the one thing that genuinely stops
   * when the feature is off — reading and deleting the objects in buckets that
   * already exist does not.
   */
  provisioning: boolean;
}

/**
 * Render `s3.json`. Same shape the compose entrypoint printf-generates, so a
 * developer can diff the two.
 */
export function renderS3Config(
  cfg: GridConfig,
  { platformBuckets, tenantBucketPrefix, provisioning }: S3IdentityInputs,
): pulumi.Output<string> {
  // `Read:grid-org-*` — the star is matched by prefix, so this covers every
  // bucket the tenant provisioner will ever create without covering
  // `grid-documents` or `grid-pg-backups`. config.ts refuses a prefix that
  // would overlap either.
  const tenantScope = (action: string): string[] => [`${action}:${tenantBucketPrefix}*`];

  const perBucket = (action: string): string[] => [
    ...platformBuckets.map((bucket) => `${action}:${bucket}`),
    ...tenantScope(action),
  ];

  return pulumi
    .all([
      pulumi.output(cfg.seaweedfs.accessKey),
      cfg.seaweedfs.secretKey,
      pulumi.output(cfg.seaweedfs.backendReadAccessKey),
      cfg.seaweedfs.backendReadSecretKey,
      pulumi.output(cfg.seaweedfs.tenantAdminAccessKey),
      cfg.seaweedfs.tenantAdminSecretKey,
    ])
    .apply(([ak, sk, brak, brsk, taak, task]) => {
      const identities: Array<{
        name: string;
        credentials: Array<{ accessKey: string; secretKey: string }>;
        actions: string[];
      }> = [
        {
          name: "grid",
          // NOT `Admin`, and never bucket-unscoped. `Admin` would grant every
          // action on every bucket including DeleteBucket, and this credential
          // is on the hot path of every upload, preview and purge. Bucket
          // creation goes through `grid-tenant-admin` instead; the platform
          // buckets are created by the init Job over `weed shell`, which talks
          // gRPC to the master and never passes through S3 auth at all.
          credentials: [{ accessKey: ak, secretKey: sk }],
          actions: OBJECT_ACTIONS.flatMap(perBucket),
        },
        {
          name: "grid-backend-read",
          credentials: [{ accessKey: brak, secretKey: brsk }],
          // This used to be a bare `["Read"]` with a separate `buckets` field.
          // The `buckets` field is not consulted by `canDo` — only `actions` is
          // — so the bare `Read` matched every bucket in the deployment,
          // including `grid-pg-backups`: the aiq-agent tier could read the
          // Postgres PITR archive, i.e. every row of every database. ADR-0039
          // described this identity as scoped to the documents bucket; it now
          // actually is.
          actions: [
            ...platformBuckets
              .filter((bucket) => bucket === cfg.seaweedfs.bucket)
              .map((bucket) => `Read:${bucket}`),
            ...tenantScope("Read"),
          ],
        },
      ];

      if (provisioning) {
        identities.push({
          name: "grid-tenant-admin",
          credentials: [{ accessKey: taak, secretKey: task }],
          // `Admin:<prefix>*` and nothing else: may create and drop tenant
          // buckets, may not touch `grid-documents` or `grid-pg-backups`.
          actions: [`Admin:${tenantBucketPrefix}*`],
        });
      }

      return JSON.stringify({ identities });
    });
}

/** The mounted `s3.json`, as a Secret both topologies attach. */
export function s3ConfigSecret(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  inputs: S3IdentityInputs,
): k8s.core.v1.Secret {
  return new k8s.core.v1.Secret(
    "seaweedfs-s3-config",
    {
      metadata: { name: "seaweedfs-s3-config", namespace },
      stringData: { "s3.json": renderS3Config(cfg, inputs) },
    },
    { provider },
  );
}

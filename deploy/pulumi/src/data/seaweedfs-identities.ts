import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { LANGFUSE } from "../constants";

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

/** One identity's name and grants, with no credential attached. */
export interface S3IdentityShape {
  name: string;
  actions: string[];
}

/**
 * THE authorization model for object storage, as data.
 *
 * Extracted from `renderS3Config` because this file was not the only definition
 * of it. The compose stacks build `s3.json` with a shell `printf`, and that copy
 * had drifted: it declared two identities where this declares three, so
 * `grid-backend-read` did not exist there at all and the agent tier ran on the
 * write-capable `grid` credential — a strictly weaker authorization model than
 * production, in the environment where people develop against it.
 *
 * The header comment used to say the two were "the same shape, so a developer
 * can diff the two". Nothing made that true. Now this function is the source and
 * `seaweedfs.spec.ts` asserts the compose files against it, so a divergence is a
 * failing test rather than something a reader has to notice.
 *
 * Deliberately pure and Pulumi-free: the spec calls it with plain strings, and
 * credentials are zipped on afterwards by {@link renderS3Config}.
 */
export function s3IdentityCatalog({
  documentsBucket,
  platformBuckets,
  tenantBucketPrefix,
  provisioning,
  langfuseBucket,
}: {
  documentsBucket: string;
  platformBuckets: string[];
  tenantBucketPrefix: string;
  provisioning: boolean;
  /**
   * The Langfuse bucket (ADR-0044), when that tier is deployed. It is a
   * platform bucket — the init Job has to create it — but it is deliberately
   * NOT in the `grid` identity's scope; see below.
   */
  langfuseBucket?: string;
}): S3IdentityShape[] {
  // `Read:grid-org-*` — the star is matched by prefix, so this covers every
  // bucket the tenant provisioner will ever create without covering
  // `grid-documents` or `grid-pg-backups`. config.ts refuses a prefix that
  // would overlap either.
  const tenantScope = (action: string): string[] => [`${action}:${tenantBucketPrefix}*`];

  // The Langfuse bucket is withheld from the general-purpose `grid` credential
  // for the same reason `grid-backend-read` is scoped to the documents bucket:
  // that credential is held by the BFF and the purger, neither of which has any
  // reason to read raw trace events — which are cross-tenant prompts and model
  // output in their most unredacted form. Langfuse reaches its own bucket with
  // its own identity below. Excluding it here is what keeps adding a platform
  // bucket from silently widening an existing credential.
  const gridBuckets = platformBuckets.filter((bucket) => bucket !== langfuseBucket);

  const perBucket = (action: string): string[] => [
    ...gridBuckets.map((bucket) => `${action}:${bucket}`),
    ...tenantScope(action),
  ];

  const identities: S3IdentityShape[] = [
    {
      name: "grid",
      // NOT `Admin`, and never bucket-unscoped. `Admin` would grant every
      // action on every bucket including DeleteBucket, and this credential
      // is on the hot path of every upload, preview and purge. Bucket
      // creation goes through `grid-tenant-admin` instead; the platform
      // buckets are created by the init Job over `weed shell`, which talks
      // gRPC to the master and never passes through S3 auth at all.
      actions: OBJECT_ACTIONS.flatMap(perBucket),
    },
    {
      name: "grid-backend-read",
      // This used to be a bare `["Read"]` with a separate `buckets` field.
      // The `buckets` field is not consulted by `canDo` — only `actions` is
      // — so the bare `Read` matched every bucket in the deployment,
      // including `grid-pg-backups`: the aiq-agent tier could read the
      // Postgres PITR archive, i.e. every row of every database. ADR-0039
      // described this identity as scoped to the documents bucket; it now
      // actually is.
      //
      // `List` is deliberately absent. `view_knowledge_image` fetches an object
      // by the key its caller already holds (ADR-0039); enumerating a bucket is
      // not something the agent tier ever needs, and it is the one grant that
      // turns a leaked read credential into a map of the tenant.
      actions: [
        ...platformBuckets
          .filter((bucket) => bucket === documentsBucket)
          .map((bucket) => `Read:${bucket}`),
        ...tenantScope("Read"),
      ],
    },
  ];

  if (provisioning) {
    identities.push({
      name: "grid-tenant-admin",
      // `Admin:<prefix>*` and nothing else: may create and drop tenant
      // buckets, may not touch `grid-documents` or `grid-pg-backups`.
      actions: [`Admin:${tenantBucketPrefix}*`],
    });
  }

  if (langfuseBucket) {
    identities.push({
      name: LANGFUSE.s3Identity,
      // Object CRUD on exactly one bucket. Not `Admin` (which would authorise
      // DeleteBucket on the trace archive), and not bucket-unscoped — a bare
      // `"Write"` here would match EVERY bucket in the deployment, including
      // the Postgres PITR archive. That is not a hypothetical failure mode:
      // it is the exact bug this catalogue's `grid-backend-read` entry was
      // written to fix, and the shape that caused it is one word shorter than
      // the shape that does not.
      actions: OBJECT_ACTIONS.map((action) => `${action}:${langfuseBucket}`),
    });
  }

  return identities;
}

/** Render `s3.json` by zipping this stack's credentials onto the catalogue. */
export function renderS3Config(
  cfg: GridConfig,
  { platformBuckets, tenantBucketPrefix, provisioning }: S3IdentityInputs,
): pulumi.Output<string> {
  return pulumi
    .all([
      pulumi.output(cfg.seaweedfs.accessKey),
      cfg.seaweedfs.secretKey,
      pulumi.output(cfg.seaweedfs.backendReadAccessKey),
      cfg.seaweedfs.backendReadSecretKey,
      pulumi.output(cfg.seaweedfs.tenantAdminAccessKey),
      cfg.seaweedfs.tenantAdminSecretKey,
      pulumi.output(cfg.langfuse.s3AccessKey),
      cfg.langfuse.s3SecretKey,
    ])
    .apply(([ak, sk, brak, brsk, taak, task, lfak, lfsk]) => {
      const credentials: Record<string, { accessKey: string; secretKey: string }> = {
        grid: { accessKey: ak, secretKey: sk },
        "grid-backend-read": { accessKey: brak, secretKey: brsk },
        "grid-tenant-admin": { accessKey: taak, secretKey: task },
        [LANGFUSE.s3Identity]: { accessKey: lfak, secretKey: lfsk },
      };

      const identities = s3IdentityCatalog({
        documentsBucket: cfg.seaweedfs.bucket,
        platformBuckets,
        tenantBucketPrefix,
        provisioning,
        langfuseBucket: cfg.langfuse.enabled ? LANGFUSE.bucket : undefined,
      }).map((identity) => ({
        name: identity.name,
        credentials: [credentials[identity.name]],
        actions: identity.actions,
      }));

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

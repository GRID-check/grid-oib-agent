import * as pulumi from "@pulumi/pulumi";
import { hostsOutsideZone, managedHosts } from "./platform/dns";

/**
 * Typed configuration for the Grid OIB Kubernetes deployment.
 *
 * Every tunable lives here so the rest of the program never touches
 * `pulumi.Config` directly. Set values with `pulumi config set grid-oib:<key>`
 * (add `--secret` for the secret ones). See deploy/pulumi/README.md for the
 * full list and docs/deployment/kubernetes.md for the operator guide.
 *
 * Secret values are typed as `pulumi.Output<string>` — they stay encrypted in
 * the stack state and are only ever materialised inside k8s Secrets.
 */
/**
 * Server-side-encryption modes CloudNativePG accepts on `barmanObjectStore`'s
 * `wal.encryption` / `data.encryption`. Mirrors the CRD enum exactly
 * (`Enum=AES256;"aws:kms"`) — "off" is the absence of the key, not `""`, so it
 * has no member here.
 */
export type BarmanEncryption = "AES256" | "aws:kms";

/**
 * Postgres database AND role name for the SeaweedFS filer namespace.
 *
 * Not a knob. It is referenced from four places that must agree exactly — the
 * CNPG `managed.roles` entry, the CNPG `Database` CR, the `filer.toml` the
 * filer mounts, and the `REVOKE CONNECT` in the init Job — and a name is not
 * something an operator gains anything by choosing. It is deliberately NOT one
 * of the three application databases: the filer store holds a decryption key
 * for every chunk in the object store, so it gets its own database, owned by
 * its own login, with `CONNECT` revoked from `PUBLIC`.
 */
const SEAWEED_FILER_DB = "seaweedfs_filer";

export interface GridConfig {
  namespace: string;
  /** Raw kubeconfig for the target cluster (from the provider). Secret. */
  kubeconfig: pulumi.Output<string>;

  images: {
    /** e.g. ghcr.io/grid-check */
    registry: string;
    /** Immutable tag both images share (a git SHA in CI, or "latest"). */
    tag: string;
    /** Full override for the backend image ref (registry+tag ignored if set). */
    backend?: string;
    /** Full override for the frontend image ref. */
    frontend?: string;
    /** Full override for the landing-site (web) image ref. */
    web?: string;
    /**
     * Explicit imagePullPolicy override for the app images. When unset the
     * policy is derived PER IMAGE REF (`appPullPolicy`): a moving tag must
     * re-pull, an immutable one must not — deriving one value from `tag`
     * alone is wrong whenever a per-service override points at a different
     * kind of reference (e.g. imageTag is a SHA while `frontendImage` is a
     * `:latest` fallback).
     */
    pullPolicyOverride?: string;
    /**
     * Registry credentials for pulling the app images when they are PRIVATE
     * (e.g. a private GHCR package — the kubelet pulls anonymously, so a
     * private image is an instant ImagePullBackOff without this). When set,
     * the program creates a dockerconfigjson Secret ("grid-registry-pull") in
     * the app namespace and wires it as imagePullSecrets on every app
     * workload. Omit both values when the images are publicly pullable.
     * Any long-lived token with read access works as the password (a GitHub
     * PAT/OAuth token with read:packages for GHCR).
     */
    pullCredentials?: { username: string; password: pulumi.Output<string> };
  };

  storage: {
    /**
     * StorageClass backing every PVC. On the target cluster this is the
     * provider's Lightbits (NVMe/TCP) class — discover it with
     * `kubectl get storageclass`. The CSI driver is provider-installed; we only
     * reference the class by name.
     *
     * **Encryption at rest is NOT something this program can request.**
     * Kubernetes has no per-PVC encryption field: whether a volume is encrypted
     * is decided entirely by the StorageClass's `parameters`, which are fixed
     * when the class is created — and nothing in this repo creates a
     * StorageClass. So there is no config key here that could turn PVC
     * encryption on; inventing one would be a setting that does nothing.
     *
     * It is an OPERATOR action against the provider: obtain (or have the
     * provider create) a StorageClass whose backing volumes are encrypted, then
     * point this key at it. `kubectl get storageclass <name> -o yaml` shows the
     * parameters actually in force. See docs/deployment/kubernetes.md
     * § Encryption posture.
     */
    className: string;
  };

  ingress: {
    /** Public host for the app (frontend + BFF + WS). Derived: `app.<baseDomain>` unless the `appDomain` key overrides it. */
    appDomain: string;
    /** Public host for the S3 endpoint used to sign browser preview/download URLs. Derived: `s3.<baseDomain>` unless the `s3Domain` key overrides it. */
    s3Domain: string;
    /** Public host for the landing site (frontends/web). Derived: the `baseDomain` apex itself unless the `webDomain` key overrides it. */
    webDomain: string;
    /** Email for the Let's Encrypt ACME account. */
    letsEncryptEmail: string;
    /** Use the LE staging CA (avoids rate limits while wiring DNS/TLS). */
    useStagingIssuer: boolean;
    /**
     * Install metrics-server (needed by the HPAs). Leave FALSE on the managed
     * provider: it already provisions base metrics components that serve
     * `metrics.k8s.io` and cannot be removed, so a second install just fights
     * the built-in one. Only set true on a bare cluster with no metrics API.
     */
    installMetricsServer: boolean;
    /**
     * Optional fixed external IP for the Envoy Gateway LoadBalancer. The provider
     * assigns one automatically on first deploy and then RESERVES a released IP
     * for 14 days, reclaimable via the `k8s.at/managed-loadbalancer-ip` service
     * annotation. Set this to that IP so DNS never has to chase a new address
     * across a Gateway/service re-creation. Empty = let the provider assign one.
     */
    loadBalancerIp?: string;
    /**
     * Trusted hops when deriving the client IP from `X-Forwarded-For` (ADR-0040
     * layer L0). This is the setting every per-IP limit depends on, and getting
     * it wrong is silent in both directions: too low and every client is
     * bucketed as the load balancer (one shared limit for the whole product),
     * too high and a client can forge its own address by sending an XFF header.
     *
     * 0 = trust Envoy's own downstream connection address, correct when the
     * LoadBalancer preserves the source IP (the common case with
     * `externalTrafficPolicy: Local` or a DSR/L2 load balancer). Raise to 1 when
     * a SNATing proxy sits in front and appends exactly one hop.
     *
     * VERIFY THIS ON A LIVE CLUSTER before trusting any per-IP number: compare
     * the edge access-log client address against a known external IP.
     */
    xffNumTrustedHops: number;
    /**
     * Maximum concurrent downstream connections per Envoy proxy replica, or 0
     * to leave it unbounded. A blunt backstop underneath the request-rate
     * limits: it bounds file descriptors and memory when something opens
     * connections without ever completing a request.
     */
    maxConnectionsPerProxy: number;
  };

  /**
   * Public DNS, managed in Cloudflare (`platform/dns.ts`).
   *
   * OFF by default, and off is a supported posture: a stack whose records are
   * maintained by hand deploys exactly as before. Turning it on replaces the
   * manual "read the LoadBalancer IP, retype it per host" step at the end of
   * every deploy — the step whose failure mode is a healthy cluster nobody can
   * reach and an ACME challenge that never solves.
   *
   * Cloudflare operates the zone; the registrar is irrelevant to this program
   * so long as the domain's NS records delegate there.
   */
  dns: {
    /** Manage records for this stack's hosts. When false nothing here is read. */
    enabled: boolean;
    /** Cloudflare zone id (dashboard → the zone → Overview → API section). */
    zoneId: string;
    /**
     * The zone's apex name (`piloti.at`), which is NOT `baseDomain` — a stack
     * can live on a subdomain of its zone. Used to name the zone-level records
     * and to check that every managed host actually falls inside this zone.
     */
    zoneName: string;
    /** Token with Zone:DNS:Edit (plus Zone:Dynamic Redirect:Edit when `apexRedirectTo` is set). */
    apiToken: pulumi.Output<string>;
    /** Address every host record points at — the Envoy LoadBalancer's external IP. */
    targetIp: string;
    /**
     * The hosts that get an A record: exactly the Gateway's HTTPS listeners
     * (`platform/gateway.ts`), derived once here so the two cannot drift.
     */
    hosts: string[];
    /** TTL in seconds for unproxied records. */
    ttl: number;
    /**
     * Whether THIS stack owns the zone-level records (`www`, `_dmarc`, and the
     * apex redirect) rather than just its own hosts.
     *
     * At most one stack may set it. Two stacks that both claim the zone do not
     * conflict in any way Cloudflare reports — the later `pulumi up` overwrites
     * the earlier one's records and prints success — so `loadConfig` refuses
     * the combinations it can detect and this flag carries the rest.
     */
    zoneBaseline: boolean;
    /**
     * Value of the `_dmarc` TXT record. Optional, and carried in config rather
     * than hardcoded because a DMARC policy is a property of the domain's mail
     * posture, not of this deployment.
     */
    dmarc?: string;
    /**
     * Absolute URL the apex and `www` redirect to, for the window in which no
     * stack serves the apex yet.
     *
     * Scaffolding with an explicit end: as soon as a stack's `baseDomain` IS
     * the zone apex, that stack serves it for real and this must be unset.
     * `loadConfig` refuses to have both at once.
     */
    apexRedirectTo?: string;
  };

  /**
   * Edge rate limiting — ADR-0040 layer L1. Enforced by Envoy Gateway's global
   * rate limit service against a dedicated counter store, so no application
   * implements it.
   *
   * Everything here is an ABUSE BOUND: fail-open by default, per client IP, per
   * route. Cost and quota live in other layers (ADR-0015 budgets, job
   * admission) and are deliberately not expressible here.
   */
  rateLimit: {
    /**
     * Install the rate limit service + counter store and attach the per-route
     * rules. When false, nothing edge-side is created and the app-layer limiters
     * remain the only ones — which is the pre-ADR-0040 behaviour.
     */
    enabled: boolean;
    /**
     * Evaluate every rule and emit its telemetry, but never actually refuse a
     * request (`shadowMode` on each rule).
     *
     * This is how the feature is meant to be introduced: run it here, read the
     * would-have-blocked counts off the ADR-0029 pane, and only then pick real
     * numbers. Enforcing limits chosen from intuition is how a rate limiter
     * becomes an outage. Defaults to TRUE for exactly that reason.
     */
    shadowMode: boolean;
    /**
     * Refuse traffic when the rate limit service cannot be reached.
     *
     * FALSE (the default, and Envoy Gateway's) is the right answer for abuse
     * bounds: a counter-store blip must not read as an outage. Set true only if
     * an unlimited flood is genuinely worse than a refused one.
     */
    failClosed: boolean;
    /** Per-client-IP request budgets, per minute. See `EDGE_RATE_LIMIT`. */
    limits: {
      /** Everything on the app host that no more specific rule claims. */
      app: number;
      /** `/api/auth/*` — the credential-stuffing surface. */
      appAuth: number;
      /** `/websocket` upgrades. Mirrors `GRID_WS_UPGRADE_RATE_LIMIT`. */
      appWsUpgrade: number;
      /** Presigned S3 preview/download URLs. */
      s3: number;
      /** The public landing site + blog. */
      web: number;
    };
    /** Counter-store dataset cap. Counters are tiny and expire on their own. */
    /**
     * Counter-store `--maxmemory`. Floor: 256mb — Dragonfly refuses to boot
     * below 256MiB per proactor thread, and we pin `--proactor_threads=1`
     * (enforced in `data/dragonfly.ts`).
     */
    storeMaxmemory: string;
    /** Counter-store pod memory limit; must sit above `storeMaxmemory`. */
    storeMemoryLimit: string;
    /**
     * `requirepass` for the counter store. Required (with the same
     * `allowUnauthenticatedRedis` opt-out) whenever rate limiting is enabled,
     * and deliberately a SEPARATE key from `dragonflyPassword`.
     *
     * The distinctness is the point, for the same reason `pgRuntimePassword`
     * stopped defaulting to `pgAppPassword`: every app pod holds the cache
     * credential in its own `REDIS_URL`. Share one password and any app pod —
     * or anything that reads one app pod's env — can also authenticate to the
     * counter store and `FLUSHALL` the edge rate limits, which is precisely the
     * control the app tier is not supposed to be able to lift.
     *
     * Consumed by Envoy Gateway's rate limit service (`REDIS_AUTH`), which runs
     * in `envoy-gateway-system`, so it is materialised into a Secret there
     * rather than in the app namespace.
     */
    storePassword?: pulumi.Output<string>;
  };

  postgres: {
    /** CloudNativePG instance count (1 = single primary; ≥2 = HA with replicas). */
    instances: number;
    storageSize: string;
    /** App role name that owns the three databases. */
    appUser: string;
    /** App role password. Secret. Drives every DSN. */
    appPassword: pulumi.Output<string>;
    /**
     * Password for `grid_app_rw`, the least-privilege role the app tier
     * connects as under row-level security (ADR-0041). REQUIRED, and
     * deliberately without a fallback to `pgAppPassword`.
     *
     * It used to default to the app password, on the reasoning that what bounds
     * this role is its PRIVILEGES — DML only, RLS enforced, no DDL — rather than
     * password distinctness. That reasoning is wrong: Postgres authenticates by
     * (role, password), so anyone holding the runtime DSN could present the same
     * password as `appUser`, the schema owner, who is exempt from every policy.
     * The privilege split is only worth what the credential split is worth.
     *
     * `pulumi config set --secret pgRuntimePassword <value>` on each stack; an
     * existing stack must set it (and rotate) before the next deploy.
     */
    runtimePassword: pulumi.Output<string>;
    /**
     * How CNPG rolls the primary during an operator/image update.
     * "unsupervised" = automatic switchover + restart (no human), which is what
     * you want on a provider that drains/replaces nodes automatically.
     */
    primaryUpdateStrategy: "unsupervised" | "supervised";
    /**
     * Continuous WAL archiving + scheduled base backups to SeaweedFS via CNPG's
     * Barman object-store integration — the only real defence against the
     * provider's `Delete` reclaim policy (a dropped PVC is otherwise
     * unrecoverable). Gives point-in-time recovery.
     */
    backups: {
      enabled: boolean;
      /**
       * S3 endpoint Barman writes to. Default: the in-cluster SeaweedFS —
       * which protects against Postgres PVC loss but NOT against cluster
       * deletion (it lives on the same Delete-reclaim CSI). Point this at an
       * external S3 (with matching bucket + credentials via
       * pgBackupAccessKey/pgBackupSecretKey) for real offsite PITR.
       */
      endpoint: string;
      /** Override credentials for an external endpoint (default: SeaweedFS's). */
      accessKey?: string;
      secretKey?: pulumi.Output<string>;
      /** Bucket for base backups + WAL (auto-created only on in-cluster SeaweedFS). */
      bucket: string;
      /** Barman retention (e.g. "30d"). */
      retention: string;
      /** 6-field cron (CNPG uses seconds-first): default nightly 02:00. */
      schedule: string;
      /**
       * **Server-side** encryption barman-cloud asks the destination for, on
       * both the WAL stream and the base backups. Undefined (the default) means
       * the key is omitted entirely and the bucket's own policy decides — which,
       * on a bucket with no policy, means the archive is written in the clear.
       *
       * This matters more than any other encryption knob in the program: the
       * PITR archive is a byte-for-byte copy of every database — every
       * conversation, every LangGraph checkpoint, every WAL record — sitting in
       * object storage.
       *
       * The accepted values are CloudNativePG's, not ours. The field lives on
       * `wal` and `data` inside `barmanObjectStore` (NOT at its top level) and
       * the CRD pins it to an enum:
       *
       *   `+kubebuilder:validation:Enum=AES256;"aws:kms"`
       *   "Whenever to force the encryption of files (if the bucket is not
       *    already configured for that). Allowed options are empty string (use
       *    the bucket policy, default), `AES256` and `aws:kms`."
       *   — barman-cloud `pkg/api`, {Wal,Data}BackupConfiguration.Encryption
       *
       * Because the enum has no empty member, an explicit `encryption: ""` is
       * REJECTED by the webhook; "off" must be the key being absent, which is
       * why this is `undefined` rather than `""`.
       *
       * **SSE only encrypts if the DESTINATION implements it.** barman-cloud
       * turns this into an `x-amz-server-side-encryption` header; a store that
       * does not implement SSE answers 200 and writes plaintext. The default
       * destination here is the in-cluster SeaweedFS, which has NO SSE at all on
       * the pinned 3.80 image (SSE-S3/KMS/C first appear in 3.97, and this
       * program configures no KMS for them even on a newer image). Setting this
       * against that endpoint would be a setting that reads as encryption and
       * is not — so `loadConfig` REFUSES the combination outright rather than
       * letting it ship. Use it with an external S3 destination
       * (`pgBackupEndpoint` + `pgBackupAccessKey`/`pgBackupSecretKey`) that
       * documents SSE support.
       */
      encryption?: BarmanEncryption;
    };
  };

  dragonfly: {
    maxmemory: string;
    /**
     * Pod memory LIMIT. Must sit ABOVE `maxmemory`: that flag caps the dataset,
     * but RSS (fragmentation, dashtable overhead, serialization buffers) runs
     * higher, so limit == maxmemory guarantees OOMKills under load.
     */
    memoryLimit: string;
    /**
     * `requirepass` for the ADR-0020 shared cache. REQUIRED unless
     * `allowUnauthenticatedRedis` is set — see the check in `loadConfig`.
     *
     * Undefined ONLY in the explicit opt-out case, where the instance keeps its
     * historical behaviour: no password, no TLS, reachable at
     * `redis://dragonfly:6379/0` by any pod in the namespace (the
     * intra-namespace NetworkPolicy allows it).
     *
     * That default was not a small hole. This instance carries the ADR-0028
     * conversation bus — every WebSocket frame of every chat, with a replayable
     * 500-event backlog per conversation — plus the cached WorkOS directory
     * (`directory:<orgId>`: email, display name, avatar), authorization
     * decisions and budget state. A password does not make it confidential on
     * the wire (Dragonfly here still speaks plaintext RESP; see
     * docs/deployment/kubernetes.md § Encryption posture), but it does stop any
     * pod that can open a TCP connection from reading and rewriting all of it.
     */
    password?: pulumi.Output<string>;
  };

  /**
   * Namespace-scoped NetworkPolicies: a default-deny for ingress into `grid`
   * plus least-privilege allows (edge→frontend/s3, intra-tier data access).
   * Egress stays open (the agent calls many external LLM/search endpoints).
   * On Cilium, kubelet health probes are not affected by these policies.
   */
  networkPolicies: boolean;

  /**
   * Pulumi `protect` on the resources whose loss is not recoverable by
   * re-running `pulumi up`: the CloudNativePG `Cluster` (the operator owns its
   * PVCs, so deleting the CR destroys the databases) and the SeaweedFS / Chroma
   * StatefulSets (their PVCs are pinned `Retain`, but a delete is still a
   * full-outage event for object storage and the vector index).
   *
   * A protected resource makes Pulumi REFUSE to delete or replace it — a
   * mis-typed rename, a `pulumi destroy`, or an accidental immutable-field
   * change fails loudly with the resource still standing, instead of succeeding
   * quietly. Recovering is deliberate and auditable:
   * `pulumi state unprotect <urn>`.
   *
   * ON by default. Ephemeral stacks that are genuinely meant to be torn down
   * (a scratch dev cluster) set this false — see Pulumi.dev.yaml.
   */
  protectDataResources: boolean;

  chroma: {
    /**
     * Run a shared Chroma server (horizontal scaling). When true, the backend
     * points AIQ_CHROMA_URL at it instead of using an embedded per-pod store.
     */
    enabled: boolean;
    image: string;
    storageSize: string;
  };

  seaweedfs: {
    /**
     * SeaweedFS server image. Defaults to `latest` (project preference for
     * fresh components); for prod consider pinning (the compose stack pins
     * 3.80) — this is the storage engine, and the provider's automatic node
     * replacement re-pulls the tag at unpredictable times.
     */
    image: string;
    storageSize: string;
    bucket: string;
    accessKey: string;
    secretKey: pulumi.Output<string>;
    /**
     * How SeaweedFS is laid out (ADR-0043).
     *
     * `single` — one `weed server -s3` process running master + volume + filer
     * + gateway against one PVC. What every deployment ran before ADR-0043.
     *
     * `split` — three workloads: a master StatefulSet, a horizontally scalable
     * volume StatefulSet, and a filer StatefulSet carrying the S3 gateway. This
     * is what makes volume capacity a replica count instead of a PVC resize,
     * and what lets the filer store (which holds every chunk's AES key) live
     * somewhere other than the disk holding the ciphertext.
     *
     * **Switching is a data migration, not a config change.** The two
     * topologies use different PVCs, so flipping this on a stack that already
     * holds objects starts an EMPTY cluster while the old volumes sit
     * untouched on a PVC nothing mounts. `docs/deployment/kubernetes.md`
     * § "Migrating SeaweedFS to the split topology" is the runbook; existing
     * stacks pin `single` in their own `Pulumi.<stack>.yaml` until they have
     * run it.
     */
    topology: "single" | "split";
    /** Master replicas (split only). Raft — must be odd. 1 = no HA. */
    masterReplicas: number;
    /** Volume-server replicas (split only). This is the capacity knob. */
    volumeReplicas: number;
    /** Filer+gateway replicas (split only). See `filerStore` before raising. */
    filerReplicas: number;
    /** PVC size for the master's `-mdir` (raft log + volume-id sequence). */
    masterStorageSize: string;
    /**
     * PVC size for the filer's `-defaultStoreDir` (split only).
     *
     * Its own knob rather than the master's, which it used to borrow. The two
     * disks hold nothing alike: the master's is a raft log and a volume-id
     * sequence and is genuinely tiny, while under `filerStore: "leveldb"` the
     * filer's holds the metadata entry AND the per-chunk AES key for every
     * object in the deployment. Sharing the knob meant an operator whose filer
     * store was filling had nothing to raise but the master's claim, and a full
     * filer store stops every write.
     *
     * The default is deliberately larger than the master's for that reason. Under
     * `filerStore: "postgres"` the namespace lives in Postgres and this claim
     * holds almost nothing — but it is still mounted, so it still needs a size.
     */
    filerStorageSize: string;
    /**
     * Size cap for a single volume file, in MB (master `-volumeSizeLimitMB`).
     *
     * SeaweedFS's own default is 30000 (≈30 GB), which is sized for bare-metal
     * disks and is a trap on a PVC: the volume server derives its writable-slot
     * count from `free / volumeSizeLimit`, so a 20 Gi PVC with a 30 GB limit
     * computes ONE slot, and a 10 Gi PVC computed zero — which surfaced live as
     * "No writable volumes and no free volumes left" on every upload. 1 GiB
     * volumes keep that arithmetic sane at PVC sizes and cost nothing:
     * SeaweedFS grows volumes lazily, so slots are not preallocated.
     */
    volumeSizeLimitMB: number;
    /** Writable volume slots per volume server (`-max`). */
    volumeMaxCount: number;
    /**
     * Free space below which a volume server marks ALL its volumes read-only
     * (`-minFreeSpace`). Must exceed one `volumeSizeLimitMB`, or the disk can
     * hit ENOSPC in the middle of growing a volume before the brake engages.
     */
    volumeMinFreeSpace: string;
    /**
     * SeaweedFS replica placement, `<diffDC><diffRack><sameRack>` (master
     * `-defaultReplication`). `000` = one copy. `010` = two copies in
     * different racks — and each volume pod reports its Kubernetes NODE as its
     * rack, so `010` is what actually puts the two copies on two machines.
     * `loadConfig` refuses a placement that needs more volume servers than the
     * deployment runs.
     */
    defaultReplication: string;
    /**
     * Where the filer keeps the namespace (split only).
     *
     * `postgres` — a dedicated database and role on the existing CNPG cluster,
     * via SeaweedFS's `[postgres2]` store. The filer's PVC goes unused, the
     * metadata inherits Postgres' backups and replication, and — the reason
     * this exists — the per-chunk encryption keys stop living on the same disk
     * as the chunks they open.
     *
     * `leveldb` — an embedded store on the filer's own PVC. No extra moving
     * parts, but single-replica only, and it puts the keys back beside the
     * ciphertext (one disk, both halves).
     */
    filerStore: "postgres" | "leveldb";
    /** Postgres role/database name for the `postgres` filer store. */
    filerDatabase: string;
    filerDatabaseUser: string;
    filerDatabasePassword: pulumi.Output<string>;
    /**
     * Dedicated READ-ONLY, bucket-scoped S3 identity for the aiq-agent tier
     * (ADR-0039 `view_knowledge_image`): its SeaweedFS s3.json entry grants
     * `Read` on the documents bucket only — no Write/Admin — and the backend
     * never receives the root `grid` access key. The secret key MUST be
     * distinct from `seaweedfsSecretKey`: shared key material would let the
     * backend pod authenticate as the root Admin identity.
     */
    backendReadAccessKey: string;
    backendReadSecretKey: pulumi.Output<string>;
    /**
     * Give every organization its own S3 bucket instead of a key prefix inside
     * one shared bucket (ADR-0043).
     *
     * What it buys, concretely: tenant erasure becomes `DeleteBucket` instead
     * of a paginated list-and-delete that can half-finish; a prefix bug can no
     * longer read across tenants because the bucket, not the key, is the
     * boundary; and usage becomes measurable per tenant at the storage layer
     * rather than only in the application's own ledger.
     *
     * Objects written before this was switched on stay exactly where they are.
     * The bucket is persisted on each document row (`documents.storage_bucket`,
     * NULL meaning "the shared bucket"), so old and new coexist indefinitely
     * and there is no cutover moment.
     */
    perOrgBuckets: boolean;
    /**
     * Bucket-name prefix for per-organization buckets. Load-bearing for
     * authorization: the S3 identities are scoped with `<Action>:<prefix>*`,
     * so this prefix is what separates "every tenant bucket" from "also the
     * Postgres backup archive". `loadConfig` refuses a prefix that overlaps
     * any platform bucket name.
     */
    tenantBucketPrefix: string;
    /**
     * Credential for the ONLY identity allowed to create and drop tenant
     * buckets. Held by the provisioning and purge paths, never by the ordinary
     * object-CRUD path — SeaweedFS's `Admin:<bucket>` authorises DeleteBucket
     * as well as CreateBucket, so separating the credential is the only way to
     * keep bucket lifecycle off the request path.
     */
    tenantAdminAccessKey: string;
    tenantAdminSecretKey: pulumi.Output<string>;
    /**
     * Offsite backup for the documents bucket (ADR-0042).
     *
     * Disabled by default because it needs an EXTERNAL S3 target to mean
     * anything: pointing it back at this cluster's own SeaweedFS reproduces the
     * exact hole it exists to close. Enabling it without `endpoint`/keys is
     * refused at load time rather than silently running a backup to nowhere.
     */
    backup: {
      enabled: boolean;
      /** External S3 endpoint. MUST NOT be the in-cluster SeaweedFS. */
      endpoint: string;
      bucket: string;
      region: string;
      accessKey: pulumi.Output<string>;
      secretKey: pulumi.Output<string>;
      /** 5-field cron for the `fs.meta.save` snapshot. Default: nightly 03:00. */
      metadataSchedule: string;
    };
    /**
     * Encrypt chunk data written to volume servers. ON by default.
     *
     * A FILER flag (`-filer.encryptVolumeData`) — the volume server has no
     * concept of encryption and stores the ciphertext as opaque bytes. Each
     * chunk gets its own AES-256-GCM key, generated at write time from
     * crypto/rand.
     *
     * TWO THINGS TO KNOW, both consequences rather than reasons not to:
     *
     * 1. **New writes only.** Objects already in the bucket stay plaintext and
     *    keep working (each chunk carries its own key, or none). There is no
     *    bulk-encrypt tool; encrypting the existing corpus means rewriting every
     *    object. Turning the flag back OFF is safe for reads — already-encrypted
     *    chunks keep their keys.
     *
     * 2. **The filer store becomes the key store for every object.** Lose or
     *    corrupt it and the volume data is unrecoverable ciphertext — no master
     *    key, no escrow, no recovery. That makes the metadata snapshot
     *    (`seaweedfsBackupEnabled`, ADR-0042 Layer B) load-bearing rather than
     *    nice to have, and it is why `loadConfig` warns below when encryption is
     *    on without a backup.
     *
     * Scope of protection: someone who obtains volume disks WITHOUT the filer
     * store. In the current single-node topology the filer's leveldb store sits
     * on the SAME PVC as the volume data, so that separation does not exist yet
     * and the real gain is the GDPR-erasure property (drop the metadata and the
     * bytes become undecryptable). Moving the filer store to Postgres — the
     * topology split ADR-0042 defers — is what turns this into disk-theft
     * protection.
     */
    encryptVolumeData: boolean;
  };

  /**
   * The agent (backend) is a hard singleton today (embedded Chroma + private
   * Dask + in-process job state — see docs/architecture/scaling-review-2026-07.md).
   * It scales VERTICALLY: give it CPU/memory and Dask workers/threads here, and
   * bound concurrent work with the admission knobs. Horizontal scaling is a
   * documented follow-up (retire local Dask for DB-claimed workers).
   */
  backend: {
    resources: ResourceSpec;
    daskWorkers: number;
    daskThreads: number;
    /** Global cap on non-terminal async research jobs (0 disables). */
    maxActiveJobs: number;
    /** Per-org cap on non-terminal async research jobs (0 disables). */
    maxActiveJobsPerOrg: number;
    /** Max concurrent document-ingestion workers in the backend process. */
    ingestMaxWorkers: number;
    /** Backend web config file (baked into the image under /app/configs). */
    configFile: string;
    /** Chroma persistence dir on the data PVC. */
    chromaDir: string;
    /** Persistent /app/data volume size (Chroma vectors + uploaded corpus). */
    dataStorageSize: string;
    /**
     * Web/chat replica count. Only applied when jobExecution="db" (in "dask"
     * mode the agent is a hard singleton and this is forced to 1). The
     * chat/retrieval path is replica-safe via shared Chroma + Postgres + cache;
     * see the base-corpus-upload caveat in docs/deployment/kubernetes.md §6.4.
     */
    replicas: number;
  };

  frontend: {
    resources: ResourceSpec;
    minReplicas: number;
    maxReplicas: number;
    /** HPA target average CPU utilisation (%). */
    hpaCpuTargetPercent: number;
  };

  /** Landing site (frontends/web) — a static-first Astro service; tiny resources. */
  web: {
    resources: ResourceSpec;
    minReplicas: number;
    maxReplicas: number;
    /** HPA target average CPU utilisation (%). */
    hpaCpuTargetPercent: number;
  };

  /**
   * Research execution backend (ADR-0021). "dask" = per-pod cluster (the agent
   * is a singleton). "db" = DB-claimed workers: the web tier runs no Dask and
   * dedicated agent-worker replicas execute jobs, so both tiers scale
   * horizontally.
   */
  jobExecution: "dask" | "db";
  /**
   * Enable the Dragonfly pub/sub conversation bus (ADR-0028) so the chat tier is
   * fully stateless — any replica serves any conversation's WebSocket. ON by
   * default (the intended architecture; uses REDIS_URL and fails open to local
   * delivery). Set false to fall back to conversation affinity, e.g. while
   * validating the bus cross-replica in a new environment.
   */
  conversationBus: boolean;
  agentWorker: {
    resources: ResourceSpec;
    minReplicas: number;
    maxReplicas: number;
    hpaCpuTargetPercent: number;
    /** Concurrent research jobs per worker process (GRID_RESEARCH_WORKERS). */
    concurrency: number;
    /**
     * Seconds a terminating worker may spend finishing the research jobs it has
     * already claimed, before the kubelet SIGKILLs it
     * (`terminationGracePeriodSeconds`).
     *
     * This is the single most consequential rollout knob in the stack. On
     * SIGTERM the worker stops claiming and awaits its in-flight jobs
     * (`aiq_api/jobs/worker.py`); Kubernetes' 30s default kills that drain
     * part-way, so *every* deploy and *every* node drain destroyed research a
     * user was waiting on. Set it at or above the p99 job duration.
     *
     * The cost is deploy latency: workers roll one at a time and a draining one
     * can hold its slot for this long, so `pulumi up` may take
     * (drain × replicas) in the worst case. Lower it only if you would rather
     * lose in-flight research than wait.
     */
    drainSeconds: number;
  };

  /** LLM / model-provider settings shared by backend + frontend. */
  llm: {
    openrouterApiKey: pulumi.Output<string>;
    tavilyApiKey: pulumi.Output<string>;
    embedModel: string;
    embedBaseUrl: string;
    vlmModel: string;
    vlmBaseUrl: string;
    budgetEurPerUsd: string;
  };

  /** WorkOS AuthKit + platform-tier settings (frontend). */
  auth: {
    requireAuth: boolean;
    workosClientId: string;
    workosApiKey: pulumi.Output<string>;
    workosCookiePassword: pulumi.Output<string>;
    platformOwnerEmails: string;
    platformOrgExternalId: string;
    disableSelfServeOrgs: boolean;
    enforceFeatureFlags: boolean;
    byokSecretBackend: string;
    byokLocalKek: pulumi.Output<string>;
    allowAgentOrgMemory: boolean;
  };

  /** Cross-service internal token + admin token (must match across services). */
  internal: {
    apiToken: pulumi.Output<string>;
    adminToken: pulumi.Output<string>;
    /**
     * 32-byte base64 KEK encrypting DB-claimed job payloads at rest (they carry
     * the user auth token). Empty = plaintext (dev only). Strongly recommended
     * whenever jobExecution="db". Generate: `openssl rand -base64 32`.
     */
    jobPayloadKek: pulumi.Output<string>;
  };

  workflows: {
    enabled: boolean;
    minIntervalMinutes: number;
  };

  storageAlerts: {
    /**
     * The storage-quota warning sweep (ADR-0042).
     *
     * Enabled by default, unlike most gates here: the quota already REFUSES the
     * upload that would cross it, so with no alert the first person to learn
     * about the limit is whoever happens to break mid-task. A deployment that
     * sets no quota at all is unaffected — an org with no quota is skipped, so
     * the sweep costs one grouped aggregate per tick and emits nothing.
     */
    enabled: boolean;
    /**
     * Share of the quota at which the first warning goes out, as a percentage.
     * Reaches the frontend as `GRID_STORAGE_ALERT_THRESHOLD_PERCENT`. Escalation
     * to 90% and 100% is automatic and not configurable — "you have run out" is
     * a different message from "you are nearly out", and a computed step can
     * straddle 100%.
     */
    thresholdPercent: number;
    /**
     * 5-field cron for the sweep. Hourly by default: the condition it reports
     * changes on the timescale of an ingest, and the alert is suppressed while
     * it is already live, so a shorter period costs queries without telling
     * anybody anything new.
     */
    schedule: string;
  };

  collaboration: {
    /**
     * Dark-launch gate for collaboration (ADR-0032…0035: shared chats,
     * `@`-mentions with the agent hand-off, the inbox). Reaches the frontend as
     * `GRID_COLLABORATION_ENABLED`, which the BFF only consults while
     * `enforceFeatureFlags` is off; with enforcement on, the per-org
     * `collaboration` WorkOS flag decides instead. Default-deny, like the
     * feature itself: it changes who can see a conversation, so an operator has
     * to choose it. No paired capability — without `REDIS_URL` live updates
     * simply degrade to polling.
     */
    enabled: boolean;
  };

  memory: {
    /**
     * Runtime gate for the post-answer memory-reflection stage (the agent's
     * cross-chat learning loop, `docs/architecture/project-memory-design.md`
     * §3.5). Reaches the frontend as `GRID_MEMORY_REFLECTION_ENABLED`, which
     * the BFF only consults while `enforceFeatureFlags` is off; with
     * enforcement on, the per-org `memory-reflection` WorkOS flag decides
     * instead. Unlike collaboration this is **default-on**: reflection is a
     * shipped core capability, not a dark-launched product gate.
     */
    reflectionEnabled: boolean;
  };

  observability: {
    /**
     * Whether the observability tier (OTel Collector + Aspire dashboard) is
     * deployed: the `observabilityEnabled` flag AND the capability derived from
     * its dependencies (otelPrimaryApiKey and the dashboard's
     * dedicated WorkOS Connect application). When false nothing is provisioned
     * and no producer gets an OTLP endpoint.
     */
    enabled: boolean;
    /** Public hostname for the Aspire dashboard. Derived: `otel.<baseDomain>` unless the `otelDomain` key overrides it. */
    otelDomain: string;
    /**
     * Aspire dashboard image reference, digest-pinned by default (override
     * only for deliberate upgrades).
     */
    dashboardImage: string;
    /**
     * OpenTelemetry Collector image reference, digest-pinned by default —
     * the single OTLP ingestion point that fans out to the dashboard
     * (ADR-0029 amendment).
     */
    collectorImage: string;
    /**
     * Telemetry ring-buffer limits inside the dashboard pod. Aspire defaults
     * to 10000/10000; raised to 50000 for a live view window.
     */
    telemetryLimits: {
      maxLogCount: number;
      maxTraceCount: number;
    };
    /**
     * OTLP ingestion key. Held by the dashboard (`Dashboard:Otlp:PrimaryApiKey`)
     * and the collector (exporter header) only — producers send unauthenticated
     * OTLP to the collector and never see it. Empty when observability is off.
     */
    otelPrimaryApiKey: pulumi.Output<string>;
    /**
     * Issuer of the dedicated WorkOS **Connect** application, i.e. the
     * environment's AuthKit domain (`https://<tenant>.authkit.app`). Its
     * `/oauth2/*` endpoints are a spec-complete OIDC provider; the app's own
     * `/user_management/*` endpoints are not, and cannot serve this flow at all
     * (see the capability check in `loadConfig`).
     *
     * Required for the observability tier. As a side benefit the dashboard no
     * longer shares the app's AuthKit client, so an ordinary app sign-in does
     * not mint a dashboard credential, dashboard access is separately
     * revocable, and the client secret is purpose-scoped instead of being the
     * WorkOS management API key.
     */
    oidcIssuer: string;
    /** Client id of that Connect application. */
    oidcClientId: string;
    /** Its client secret — the application must be a confidential client. */
    oidcClientSecret: pulumi.Output<string>;
  };

  /**
   * err2issue — ERROR-severity telemetry becomes deduplicated GitHub issues
   * (ADR-0031). A second consumer on the collector's logs signal, alongside the
   * Aspire dashboard.
   */
  err2issue: {
    /**
     * Whether the sink is deployed: the `err2issueEnabled` flag AND the
     * capability derived from its dependencies (a GitHub token, a fallback
     * repo) AND `observability.enabled` — it receives nothing without the
     * collector in front of it.
     */
    enabled: boolean;
    /**
     * Image reference. Upstream publishes no version tags yet, so this
     * defaults to a MOVING `:latest` (pulled Always — see err2issue.ts).
     * Digest-pin it before enabling in prod.
     */
    image: string;
    /** Fallback destination repo (`owner/repo`) for unrouted services. */
    githubRepo: string;
    /** PAT with Issues read/write. Empty when the sink is off. */
    githubToken: pulumi.Output<string>;
    /**
     * Optional `service=owner/repo` routing, globs allowed
     * (`aiq-agent=grid-check/grid-oib-agent,*-worker=grid-check/workers`).
     * Empty string means route everything to `githubRepo`.
     */
    routeMap: string;
    /**
     * Optional Claude API key for AI-written issue titles. Empty falls back to
     * rule-based titles — a degraded title, not a broken sink. Note this is a
     * console API key; a Claude subscription OAuth token will not work here.
     */
    anthropicApiKey: pulumi.Output<string>;
    /** Repeat-occurrence coalescing window, seconds (upstream default 600). */
    suppressWindowSeconds: number;
    /** Ceiling on NEW issues per day — the blast-radius control. */
    maxNewFingerprintsPerDay: number;
    /** Drop errors from services the route map does not match. */
    dropUnrouted: boolean;
  };
}

export interface ResourceSpec {
  requestsCpu: string;
  requestsMemory: string;
  limitsCpu: string;
  limitsMemory: string;
}

function num(cfg: pulumi.Config, key: string, fallback: number): number {
  const v = cfg.getNumber(key);
  return v === undefined ? fallback : v;
}

function bool(cfg: pulumi.Config, key: string, fallback: boolean): boolean {
  const v = cfg.getBoolean(key);
  return v === undefined ? fallback : v;
}

/**
 * Require a SET of secrets together, naming the ones that are missing.
 *
 * Credentials arrive in pairs — an access key and a secret key — and a guard
 * written from the error message rather than from the requirement tests one of
 * them. That is not a hypothetical: the documents-backup guard named both keys
 * and checked only the access key, so a stack that set one and omitted the other
 * planned clean, substituted `pulumi.secret("")`, and `weed filer.backup` signed
 * every request with an empty secret — `SignatureDoesNotMatch`, i.e. exactly the
 * silent backup-to-nowhere the guard existed to refuse.
 *
 * Reporting ALL the missing keys rather than the first also matters: a plan that
 * fails once per missing key is three plans.
 *
 * Read with `cfg.get`, and an EMPTY value counts as missing. `getSecret("")`
 * returns a defined output, so an unset-vs-set check would pass for
 * `pulumi config set --secret grid-oib:… ""` — which is not a hypothetical
 * either, it is what the failure this guard was written for actually looked
 * like: a signing key that exists, is empty, and turns every request into
 * `SignatureDoesNotMatch`. A credential that cannot sign is not a credential,
 * so the guard measures usability rather than presence. `cfg.get` is safe here
 * because nothing is returned — only the KEY NAMES reach the message.
 */
function requireSecretsTogether(
  cfg: pulumi.Config,
  keys: string[],
  because: string,
): void {
  const missing = keys.filter((key) => (cfg.get(key) ?? "").trim() === "");
  if (missing.length === 0) return;
  throw new Error(
    `${missing.map((k) => `grid-oib:${k}`).join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
      `required ${because}. Set ${missing.length === 1 ? "it" : "them"} with ` +
      `\`pulumi config set --secret\`.`,
  );
}

export function loadConfig(): GridConfig {
  const cfg = new pulumi.Config();

  // Reject the Pulumi.prod.yaml template placeholders up front. `require()`
  // happily returns "REPLACE_ME"/"app.example.com", so without this the failure
  // only surfaces ~20 min later as PVCs stuck Pending / TLS never issuing.
  const rejectPlaceholder = (key: string, markers: string[]) => {
    const v = cfg.get(key);
    if (v !== undefined && markers.some((m) => v.includes(m))) {
      throw new Error(
        `grid-oib:${key} is still the template placeholder ("${v}"). Set a real value before deploying.`,
      );
    }
  };
  rejectPlaceholder("storageClass", ["REPLACE_ME"]);
  // Single source for every public host: app/s3/otel subdomains derive from
  // baseDomain, so a domain move is a one-key change. The per-host keys
  // (appDomain/s3Domain/otelDomain) survive only as explicit overrides.
  const baseDomain = cfg.require("baseDomain");
  const appDomain = cfg.get("appDomain") ?? `app.${baseDomain}`;
  const s3Domain = cfg.get("s3Domain") ?? `s3.${baseDomain}`;
  // The landing site owns the apex: dev.piloti.at is the marketing/blog host,
  // the app lives at app.dev.piloti.at. `webDomain` survives only as an override.
  const webDomain = cfg.get("webDomain") ?? baseDomain;
  rejectPlaceholder("baseDomain", ["example.com"]);
  rejectPlaceholder("appDomain", ["example.com"]);
  rejectPlaceholder("s3Domain", ["example.com"]);
  rejectPlaceholder("webDomain", ["example.com"]);
  rejectPlaceholder("workosClientId", ["REPLACE_ME"]);
  // Let's Encrypt refuses ACME account registration for example.com contacts —
  // without this guard a deploy that fixed the domains but not the email passes
  // everything and then TLS silently never issues (the exact delayed-failure
  // class this guard exists to kill).
  rejectPlaceholder("letsEncryptEmail", ["example.com"]);
  rejectPlaceholder("otelDomain", ["example.com"]);

  // The BFF clamps a nonsense threshold back to 80 rather than switching the
  // warning off, which is the right runtime behaviour and a terrible deploy-time
  // one: an operator who set 800 meaning 80 would get the default forever and no
  // sign of it. Caught here, where there is somebody to read the message.
  const storageAlertThresholdPercent = num(cfg, "storageAlertThresholdPercent", 80);
  if (
    !Number.isFinite(storageAlertThresholdPercent) ||
    storageAlertThresholdPercent <= 0 ||
    storageAlertThresholdPercent > 100
  ) {
    throw new Error(
      `grid-oib:storageAlertThresholdPercent must be a percentage in (0, 100]; got ` +
        `"${storageAlertThresholdPercent}". This is the share of its storage quota at which an ` +
        "organization is warned (ADR-0042); escalation to 90% and 100% is automatic.",
    );
  }

  const jobExecution: "dask" | "db" = (cfg.get("jobExecution") ?? "dask") === "db" ? "db" : "dask";
  const conversationBus = bool(cfg, "conversationBus", true);
  const imageTag = cfg.get("imageTag") ?? "latest";

  // Fail fast: the web PDB allows maxUnavailable 1, so a webMinReplicas of 1
  // means a voluntary disruption (node drain, rolling update) takes the whole
  // landing site down. Two replicas is the floor the PDB contract assumes.
  const webMinReplicas = num(cfg, "webMinReplicas", 2);
  if (webMinReplicas < 2) {
    throw new Error(
      `grid-oib:webMinReplicas must be >= 2 (got ${webMinReplicas}). The web PodDisruptionBudget ` +
        "allows maxUnavailable 1, so a single replica means a full landing-site outage during " +
        "any voluntary disruption.",
    );
  }

  // ── SeaweedFS topology (ADR-0043) ─────────────────────────────────────────
  // Every check here is about one thing: the two topologies do not share PVCs,
  // and the two filer stores do not share a namespace. Getting either wrong
  // produces a cluster that starts cleanly, reports healthy, and cannot see a
  // single existing object — the worst possible failure shape, because nothing
  // is broken enough to page anyone.
  const seaweedTopologyRaw = (cfg.get("seaweedfsTopology") ?? "split").trim();
  if (seaweedTopologyRaw !== "single" && seaweedTopologyRaw !== "split") {
    throw new Error(
      `grid-oib:seaweedfsTopology must be "single" or "split" (got "${seaweedTopologyRaw}").`,
    );
  }
  const seaweedTopology: "single" | "split" = seaweedTopologyRaw;

  const seaweedFilerStoreRaw = (cfg.get("seaweedfsFilerStore") ?? "postgres").trim();
  if (seaweedFilerStoreRaw !== "postgres" && seaweedFilerStoreRaw !== "leveldb") {
    throw new Error(
      `grid-oib:seaweedfsFilerStore must be "postgres" or "leveldb" (got "${seaweedFilerStoreRaw}").`,
    );
  }
  const seaweedFilerStore: "postgres" | "leveldb" = seaweedFilerStoreRaw;

  const seaweedMasterReplicas = num(cfg, "seaweedfsMasterReplicas", 1);
  const seaweedFilerReplicas = num(cfg, "seaweedfsFilerReplicas", 1);
  if (seaweedTopology === "split") {
    // Raft cannot form a majority from an even number of voters: 2 masters
    // tolerate zero failures and deadlock on a split, which is strictly worse
    // than 1. Refuse rather than let someone "add HA" and reduce availability.
    if (seaweedMasterReplicas < 1 || seaweedMasterReplicas % 2 === 0) {
      throw new Error(
        `grid-oib:seaweedfsMasterReplicas must be an odd number >= 1 (got ${seaweedMasterReplicas}). ` +
          "The masters form a Raft quorum, and an even count tolerates no more failures than " +
          "the odd number below it while adding a way to deadlock.",
      );
    }
    if (num(cfg, "seaweedfsVolumeReplicas", 1) < 1) {
      throw new Error("grid-oib:seaweedfsVolumeReplicas must be >= 1.");
    }
    // An embedded leveldb lives on the pod's own PVC, so a second replica gets
    // a second, DIFFERENT namespace. Both would answer S3 requests and each
    // would see roughly half the objects, depending on which pod the Service
    // picked. Nothing would error.
    if (seaweedFilerStore === "leveldb" && seaweedFilerReplicas > 1) {
      throw new Error(
        `grid-oib:seaweedfsFilerReplicas is ${seaweedFilerReplicas} with the embedded leveldb ` +
          "filer store. Each replica would keep its own private namespace on its own PVC, so " +
          "the same object would exist or not depending on which pod answered. Use " +
          'seaweedfsFilerStore="postgres" to run more than one filer.',
      );
    }
    if (seaweedFilerReplicas < 1) {
      throw new Error("grid-oib:seaweedfsFilerReplicas must be >= 1.");
    }
    if (seaweedFilerStore === "postgres" && cfg.getSecret("seaweedfsFilerDbPassword") === undefined) {
      throw new Error(
        "grid-oib:seaweedfsFilerDbPassword is required when seaweedfsFilerStore is \"postgres\". " +
          "It is the login for the dedicated Postgres role that owns the filer namespace — " +
          'set it with `pulumi config set --secret grid-oib:seaweedfsFilerDbPassword "$(openssl rand -base64 24)"`.',
      );
    }
  } else {
    // Non-default replica counts on the single-node topology are a silent
    // no-op: there is exactly one process and one PVC. Say so at plan time
    // rather than let someone believe they scaled something.
    if (seaweedMasterReplicas !== 1 || num(cfg, "seaweedfsVolumeReplicas", 1) !== 1 || seaweedFilerReplicas !== 1) {
      pulumi.log.warn(
        'grid-oib:seaweedfsTopology is "single", so seaweedfsMasterReplicas / ' +
          "seaweedfsVolumeReplicas / seaweedfsFilerReplicas are ignored — the single-node " +
          'topology is one process on one PVC. Set seaweedfsTopology="split" to scale it.',
      );
    }
  }

  // Volume sizing. Both numbers are only meaningful relative to each other and
  // to the PVC, which is why they are checked together rather than clamped
  // individually.
  const seaweedVolumeSizeLimitMB = num(cfg, "seaweedfsVolumeSizeLimitMB", 1024);
  if (seaweedVolumeSizeLimitMB < 1 || seaweedVolumeSizeLimitMB > 30000) {
    // 30000 is SeaweedFS's own hard ceiling — `weed master` fatals above it.
    throw new Error(
      `grid-oib:seaweedfsVolumeSizeLimitMB must be between 1 and 30000 (got ${seaweedVolumeSizeLimitMB}).`,
    );
  }
  {
    // A volume server marks every volume read-only once free space drops below
    // `-minFreeSpace`. If that threshold is smaller than one volume, the disk
    // can run out WHILE a volume is growing into it — the brake engages after
    // the crash it exists to prevent.
    const minFree = cfg.get("seaweedfsVolumeMinFreeSpace") ?? "2GiB";
    const match = /^(\d+(?:\.\d+)?)\s*(GiB|GB|MiB|MB)$/i.exec(minFree.trim());
    if (match) {
      const value = Number(match[1]);
      const unit = match[2].toUpperCase();
      const mib = unit.startsWith("G") ? value * 1024 : value;
      if (mib < seaweedVolumeSizeLimitMB) {
        throw new Error(
          `grid-oib:seaweedfsVolumeMinFreeSpace (${minFree}) is smaller than one volume ` +
            `(seaweedfsVolumeSizeLimitMB=${seaweedVolumeSizeLimitMB}MB). The read-only brake would ` +
            "engage only after a volume had already run the disk out mid-write.",
        );
      }
    }
    // A bare number means "percent" to SeaweedFS, which we cannot check against
    // a PVC size here — leave it to the operator.
  }

  const seaweedReplication = (cfg.get("seaweedfsDefaultReplication") ?? "000").trim();
  if (!/^[0-9]{3}$/.test(seaweedReplication)) {
    throw new Error(
      `grid-oib:seaweedfsDefaultReplication must be three digits, ` +
        `<diffDataCenter><diffRack><sameRack> (got "${seaweedReplication}").`,
    );
  }
  {
    // Copies = the three digits plus the original. SeaweedFS does not fail the
    // deployment when it cannot place them; it fails each volume-grow attempt
    // with "Only has N racks, not enough for M", which surfaces as uploads that
    // stop working once the first volume fills. Catch it at plan time.
    const copies =
      Number(seaweedReplication[0]) + Number(seaweedReplication[1]) + Number(seaweedReplication[2]) + 1;
    const volumeReplicas = num(cfg, "seaweedfsVolumeReplicas", 1);
    if (seaweedTopology === "split" && copies > volumeReplicas) {
      throw new Error(
        `grid-oib:seaweedfsDefaultReplication "${seaweedReplication}" asks for ${copies} copies but ` +
          `seaweedfsVolumeReplicas is ${volumeReplicas}. Volume growth would fail once the first ` +
          "volume fills, which looks like uploads spontaneously breaking rather than a config error.",
      );
    }
    if (seaweedTopology === "single" && copies > 1) {
      throw new Error(
        `grid-oib:seaweedfsDefaultReplication "${seaweedReplication}" asks for ${copies} copies, but ` +
          'seaweedfsTopology="single" runs exactly one volume server. Use "000".',
      );
    }
  }

  // ── Per-organization buckets (ADR-0043) ───────────────────────────────────
  const seaweedPerOrgBuckets = bool(cfg, "seaweedfsPerOrgBuckets", false);
  const seaweedTenantPrefix = (cfg.get("seaweedfsTenantBucketPrefix") ?? "grid-org-").trim();

  // Validated UNCONDITIONALLY, not only when the feature is on, because the
  // grants are issued unconditionally. `Read:<prefix>*` is emitted whether or
  // not per-organization buckets are enabled — that is what keeps a rollback
  // from revoking access to everything written while they were — so the prefix
  // is load-bearing even in a deployment that has never created a tenant
  // bucket. Gating these checks on the flag would let
  // `seaweedfsTenantBucketPrefix: grid-` sail through with the feature off and
  // hand `grid-documents` AND `grid-pg-backups` to every identity holding a
  // tenant scope, including the read-only agent credential. That is the exact
  // bug ADR-0043 exists to fix, re-entered through a side door.
  //
  // S3 bucket names: 3–63 chars, lowercase alphanumeric and hyphens, must start
  // with a letter or digit. The prefix is only part of a name, so the length
  // floor does not apply to it — but every other rule does, and the trailing
  // hyphen is what keeps `grid-org-*` from also matching a hypothetical
  // `grid-organizations` bucket.
  if (!/^[a-z0-9][a-z0-9-]*-$/.test(seaweedTenantPrefix)) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix must be lowercase alphanumeric/hyphen, start with a ` +
        `letter or digit, and end with "-" (got "${seaweedTenantPrefix}").`,
    );
  }
  if (seaweedTenantPrefix.length > 32) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix is ${seaweedTenantPrefix.length} chars. S3 caps a ` +
        "bucket name at 63, and the organization id plus a collision-proof hash needs the rest.",
    );
  }
  // Reserved by S3 and rejected by SeaweedFS's own `VerifyS3BucketName`, so a
  // prefix starting with it produces names that fail at CreateBucket time for
  // every tenant.
  if (seaweedTenantPrefix.startsWith("xn--")) {
    throw new Error(
      `grid-oib:seaweedfsTenantBucketPrefix must not start with "xn--" (got "${seaweedTenantPrefix}") — ` +
        "S3 reserves that prefix and SeaweedFS rejects such a bucket name outright.",
    );
  }
  // THE load-bearing check. The S3 identities are scoped with
  // `<Action>:<prefix>*`, matched by string prefix — so a prefix that is itself
  // a prefix of a platform bucket name silently re-grants that bucket to every
  // identity holding a tenant scope, including the read-only agent credential.
  // `grid-` as a prefix would hand out `grid-documents` AND `grid-pg-backups`,
  // i.e. the entire Postgres PITR archive.
  {
    const platformBuckets = [
      cfg.get("seaweedfsBucket") ?? "grid-documents",
      cfg.get("pgBackupBucket") ?? "grid-pg-backups",
      cfg.get("seaweedfsBackupBucket") ?? "grid-documents-backup",
    ];
    for (const bucket of platformBuckets) {
      if (bucket.startsWith(seaweedTenantPrefix)) {
        throw new Error(
          `grid-oib:seaweedfsTenantBucketPrefix "${seaweedTenantPrefix}" is a prefix of the platform ` +
            `bucket "${bucket}". Tenant grants are wildcard-scoped (\`Read:${seaweedTenantPrefix}*\`) and ` +
            "match by string prefix, so this would hand that bucket to every identity holding a " +
            "tenant scope — including the read-only agent credential.",
        );
      }
    }
  }
  // Only the CREDENTIAL is gated, because creating buckets is the one thing
  // that genuinely stops when the feature is off.
  if (seaweedPerOrgBuckets && cfg.getSecret("seaweedfsTenantAdminSecretKey") === undefined) {
    throw new Error(
      "grid-oib:seaweedfsTenantAdminSecretKey is required when seaweedfsPerOrgBuckets is true. " +
        "It is the credential for the only identity allowed to create and drop tenant buckets — " +
        'set it with `pulumi config set --secret grid-oib:seaweedfsTenantAdminSecretKey "$(openssl rand -base64 24)"`.',
    );
  }

  // Fail fast: a documents backup that writes back into this cluster's own
  // SeaweedFS is not a backup — it is a second copy on the disk you are trying
  // to survive losing. Refuse the two ways that happens: no endpoint at all, and
  // an endpoint pointing at the in-cluster service.
  const seaweedBackupEnabled = cfg.getBoolean("seaweedfsBackupEnabled") ?? false;
  if (seaweedBackupEnabled) {
    const backupEndpoint = cfg.get("seaweedfsBackupEndpoint") ?? "";
    if (!backupEndpoint) {
      throw new Error(
        "grid-oib:seaweedfsBackupEndpoint is required when seaweedfsBackupEnabled is true. " +
          "Point it at an EXTERNAL S3 endpoint — an in-cluster target does not survive the " +
          "cluster loss the backup exists to cover.",
      );
    }
    // Plaintext offsite is worse than no offsite: every document, and the
    // long-lived S3 secret key that signs for them, would cross the open
    // internet in the clear. The previous check only refused an in-CLUSTER
    // endpoint, so `http://backup.example.com` sailed through.
    if (!backupEndpoint.startsWith("https://")) {
      throw new Error(
        `grid-oib:seaweedfsBackupEndpoint must be https:// (got ${backupEndpoint}). ` +
          "The mirror ships every document plus a long-lived S3 credential; over plaintext " +
          "HTTP both are readable by anyone on the path.",
      );
    }
    if (backupEndpoint.includes("seaweedfs:8333") || backupEndpoint.includes("//seaweedfs")) {
      throw new Error(
        `grid-oib:seaweedfsBackupEndpoint points at the in-cluster SeaweedFS (${backupEndpoint}). ` +
          "That stores the backup on the same volumes as the data. Use an external S3 endpoint.",
      );
    }
    // BOTH keys. Half a credential is worse than none: the plan succeeds, the
    // sidecar starts, and every request fails `SignatureDoesNotMatch` against a
    // mirror the operator believes is running.
    requireSecretsTogether(
      cfg,
      ["seaweedfsBackupAccessKey", "seaweedfsBackupSecretKey"],
      "when seaweedfsBackupEnabled is true",
    );
  }

  // Encryption on + no metadata backup is the one combination that loses data
  // PERMANENTLY rather than temporarily. Chunk keys live in the filer store, so
  // without a snapshot of that store there is no path back from its corruption —
  // the volume files survive as ciphertext nobody can open. Warn rather than
  // refuse: an operator may be running encryption deliberately in dev, and a
  // hard failure would make the safer default (encryption on) harder to adopt
  // than the unsafe one.
  const seaweedEncrypt = cfg.getBoolean("seaweedfsEncryptVolumeData") ?? true;
  if (seaweedEncrypt && !seaweedBackupEnabled) {
    pulumi.log.warn(
      "SeaweedFS volume encryption is ON but seaweedfsBackupEnabled is false. Chunk keys live in " +
        "the filer metadata store, so losing it makes every encrypted object unrecoverable — " +
        "there is no master key and no escrow. Enable the backup (ADR-0042) before storing " +
        "anything you cannot afford to lose, or set seaweedfsEncryptVolumeData=false.",
    );
  }
  // Chunk encryption only protects against someone who gets the CIPHERTEXT
  // without the KEYS. On the single-node topology, and on the split topology
  // with the embedded store, both halves sit on disks in the same cluster —
  // and under `single` they sit on the SAME PVC. The feature is still worth
  // having there (dropping the metadata makes the bytes undecryptable, which is
  // the GDPR-erasure property), but calling it at-rest protection would be a
  // lie, so say what it is.
  if (
    seaweedEncrypt &&
    (seaweedTopology === "single" || seaweedFilerStore === "leveldb")
  ) {
    pulumi.log.warn(
      "SeaweedFS volume encryption is ON, but the filer store shares a cluster (and under " +
        'seaweedfsTopology="single", the same PVC) with the volume data it encrypts. Anyone who ' +
        "can read the volume files can read the keys beside them, so this is not disk-theft " +
        'protection yet — it buys crypto-erasure only. seaweedfsTopology="split" with ' +
        'seaweedfsFilerStore="postgres" is what separates the two (ADR-0043).',
    );
  }

  // ── Postgres PITR archive encryption ──────────────────────────────────────
  // The archive is the single largest plaintext surface in the stack when it is
  // on: WAL + base backups are a byte-for-byte copy of all three databases.
  // `pgBackupEncryption` asks the DESTINATION for server-side encryption, so it
  // is only ever as real as the destination — hence the two checks below and
  // the warning that names the exposure when there is none.
  const pgBackupsEnabled = bool(cfg, "pgBackupsEnabled", false);
  const pgBackupEndpoint = cfg.get("pgBackupEndpoint") ?? "http://seaweedfs:8333";
  const pgBackupEncryptionRaw = (cfg.get("pgBackupEncryption") ?? "").trim();
  const pgBackupEncryption: BarmanEncryption | undefined =
    pgBackupEncryptionRaw === "" ? undefined : (pgBackupEncryptionRaw as BarmanEncryption);
  if (pgBackupEncryption !== undefined && !["AES256", "aws:kms"].includes(pgBackupEncryption)) {
    // The CNPG webhook would reject this too, but only ~20 min into a `pulumi
    // up` that has already started mutating the cluster.
    throw new Error(
      `grid-oib:pgBackupEncryption must be "AES256" or "aws:kms" (got "${pgBackupEncryptionRaw}"). ` +
        "Leave it unset to inherit the bucket policy — CloudNativePG's enum has no empty member, " +
        "so \"off\" is the key being absent, not an empty string.",
    );
  }
  // `//seaweedfs` also catches `http://seaweedfs.grid.svc.cluster.local:8333`.
  const pgBackupIsInCluster =
    pgBackupEndpoint.includes("//seaweedfs") || pgBackupEndpoint.includes("seaweedfs:8333");
  if (pgBackupEncryption !== undefined && pgBackupIsInCluster) {
    // Refuse rather than warn. barman-cloud turns this into an
    // `x-amz-server-side-encryption` request header; SeaweedFS 3.80 (the pinned
    // production image) implements no SSE at all, answers 200, and stores the
    // object unencrypted. Accepting the setting here would put "encryption:
    // AES256" in the Cluster spec, in the plan, and in any audit of it — while
    // the bytes on disk are plaintext. That is worse than no setting.
    throw new Error(
      `grid-oib:pgBackupEncryption is set ("${pgBackupEncryptionRaw}") but pgBackupEndpoint points at ` +
        `the in-cluster SeaweedFS (${pgBackupEndpoint}), which implements no server-side encryption ` +
        "(SSE-S3/KMS/C first appear in 3.97; prod pins 3.80, and this program configures no KMS for " +
        "them on any image). SeaweedFS answers such a request 200 and stores the object in the clear, " +
        "so the setting would claim an encryption that does not exist. Point pgBackupEndpoint at an " +
        "external S3 destination that documents SSE support, or leave pgBackupEncryption unset.",
    );
  }
  if (pgBackupsEnabled && pgBackupEncryption === undefined) {
    pulumi.log.warn(
      "Postgres PITR archive is UNENCRYPTED at rest. WAL and base backups are a byte-for-byte copy " +
        "of all three databases (conversations, LangGraph checkpoints, the whole grid_app schema) " +
        `and go to ${pgBackupEndpoint} with no encryption requested. On the in-cluster SeaweedFS ` +
        "there is no fix available in this program — SeaweedFS 3.80 has no SSE, and volume-chunk " +
        "encryption (seaweedfsEncryptVolumeData) is the only at-rest control that applies. For a " +
        "real guarantee use an external S3 destination and set grid-oib:pgBackupEncryption=AES256. " +
        "See docs/deployment/kubernetes.md § Encryption posture.",
    );
  }

  // ── Dragonfly authentication ──────────────────────────────────────────────
  // Both instances shipped with NO password and NO TLS while the intra-namespace
  // NetworkPolicy lets any pod open 6379. The cache is the serious one: it
  // carries the ADR-0028 conversation bus (every chat frame, replayable), the
  // cached WorkOS directory (email/name/avatar), authz decisions and budget
  // state. Fail closed like `jobPayloadKek` does — a password must be a
  // decision, in one direction or the other, never a default nobody noticed.
  const rateLimitEnabled = bool(cfg, "rateLimitEnabled", true);
  const allowUnauthenticatedRedis = bool(cfg, "allowUnauthenticatedRedis", false);
  const dragonflyPassword = cfg.getSecret("dragonflyPassword");
  const rateLimitStorePassword = cfg.getSecret("rateLimitStorePassword");
  const missingRedisPasswords = [
    dragonflyPassword === undefined ? "dragonflyPassword" : undefined,
    rateLimitEnabled && rateLimitStorePassword === undefined ? "rateLimitStorePassword" : undefined,
  ].filter((k): k is string => k !== undefined);
  if (missingRedisPasswords.length > 0 && !allowUnauthenticatedRedis) {
    throw new Error(
      `Dragonfly would run with no authentication: ${missingRedisPasswords
        .map((k) => `grid-oib:${k}`)
        .join(", ")} unset. Any pod in the namespace could then read the conversation bus (every ` +
        "chat frame), the cached user directory, authorization decisions and budget state — or reset " +
        "the edge rate-limit counters. Set them:\n" +
        "  pulumi config set --secret grid-oib:dragonflyPassword $(openssl rand -base64 32)\n" +
        "  pulumi config set --secret grid-oib:rateLimitStorePassword $(openssl rand -base64 32)\n" +
        "To deliberately run WITHOUT authentication (dev/single-node only), set:\n" +
        "  pulumi config set grid-oib:allowUnauthenticatedRedis true",
    );
  }
  // Distinctness, for the same reason pgRuntimePassword stopped falling back to
  // pgAppPassword: every app pod holds the cache credential in its own
  // REDIS_URL, so reusing it for the counter store hands the app tier the
  // ability to flush the edge rate limits. Compared, never printed.
  if (
    dragonflyPassword !== undefined &&
    rateLimitStorePassword !== undefined &&
    cfg.get("dragonflyPassword") === cfg.get("rateLimitStorePassword")
  ) {
    throw new Error(
      "grid-oib:rateLimitStorePassword must differ from grid-oib:dragonflyPassword. Every app pod " +
        "carries the cache password in REDIS_URL; sharing it would let the app tier authenticate to " +
        "the edge counter store and lift its own rate limits.",
    );
  }
  if (allowUnauthenticatedRedis && missingRedisPasswords.length > 0) {
    pulumi.log.warn(
      "Dragonfly is running WITHOUT authentication (allowUnauthenticatedRedis=true): " +
        missingRedisPasswords.map((k) => `grid-oib:${k}`).join(", ") +
        " unset. Any pod in the namespace can read and rewrite the conversation bus, the cached " +
        "user directory, authorization decisions and budget state.",
    );
  }

  const registryUsername = cfg.get("registryUsername");
  const registryPassword = cfg.getSecret("registryPassword");
  if ((registryUsername === undefined) !== (registryPassword === undefined)) {
    throw new Error(
      "grid-oib:registryUsername and grid-oib:registryPassword must be set together (or neither).",
    );
  }

  // Fail closed: db-claimed job payloads carry the user's auth token and persist
  // in Postgres (table + WAL + backups + replicas). Refuse to deploy db mode
  // without a KEK to encrypt them at rest, unless plaintext is explicitly opted
  // into for dev. Guards against the silent plaintext-token-at-rest default.
  // Fail closed: db mode REQUIRES the shared Chroma server. Without it every
  // web replica and worker opens an embedded per-pod store — workers ingest
  // into stores no web replica can read (retrieval silently empty), and the
  // volume-less agent-worker can't even write its store (image FS, root-owned).
  // The deploy would report success and be functionally broken.
  const chromaEnabled = bool(cfg, "chromaEnabled", true);
  if (jobExecution === "db" && !chromaEnabled) {
    throw new Error(
      "jobExecution=db requires the shared Chroma server (workers and web replicas must " +
        "read/write one vector store). Set grid-oib:chromaEnabled=true, or use jobExecution=dask.",
    );
  }

  const jobPayloadKek = cfg.getSecret("jobPayloadKek");
  const allowPlaintextJobPayloads = bool(cfg, "allowPlaintextJobPayloads", false);
  if (jobExecution === "db" && jobPayloadKek === undefined && !allowPlaintextJobPayloads) {
    throw new Error(
      "jobExecution=db persists research-job payloads (which carry the user auth token) in Postgres, " +
        "so they must be encrypted at rest. Set a 32-byte base64 KEK:\n" +
        "  pulumi config set --secret grid-oib:jobPayloadKek $(openssl rand -base64 32)\n" +
        "To deliberately run with PLAINTEXT payloads (dev/single-node only), set:\n" +
        "  pulumi config set grid-oib:allowPlaintextJobPayloads true",
    );
  }

  // ── Observability (ADR-0029): availability = flag AND capability ───────────
  // `observabilityEnabled` is the product decision; the capability is DERIVED
  // from the dependencies the tier cannot run without — never duplicated as a
  // second flag. Without them the components deploy broken, not degraded: the
  // Gateway SecurityPolicy in front of the dashboard has no usable OIDC client
  // to authenticate anyone with — and the dashboard itself runs `AuthMode=Unsecured`
  // precisely because the edge is doing that job, so a half-configured tier is
  // an OPEN telemetry dashboard, not a locked one. The collector likewise has
  // no key to authenticate its export. So the whole tier (dashboard, collector,
  // SecurityPolicy, Gateway listener, producer env) is skipped instead, with a
  // warning naming exactly what is missing.
  const workosClientId = cfg.get("workosClientId") ?? "";
  const workosApiKey = cfg.getSecret("workosApiKey");
  const otelDomain = cfg.get("otelDomain") ?? `otel.${baseDomain}`;
  const otelPrimaryApiKey = cfg.getSecret("otelPrimaryApiKey");
  // Dedicated WorkOS **Connect** application for the dashboard. REQUIRED — the
  // app's own AuthKit client cannot be reused, and this is not a preference:
  //
  //   Envoy Gateway hardcodes HTTP Basic auth for the token exchange
  //   (`internal/xds/translator/oidc.go`, "every OIDC provider supports basic
  //   auth"), with no SecurityPolicy field to change it. WorkOS's
  //   /user_management/authenticate ignores the Basic header and answers
  //   "Missing required parameter: client_id", so the flow dies at the
  //   callback with "OAuth flow failed." A Connect application's issuer
  //   (https://<tenant>.authkit.app) is a spec-complete OIDC provider that
  //   does accept client_secret_basic — and, as a bonus, needs no
  //   `provider=authkit` connection selector on /authorize.
  //
  // The application must be a CONFIDENTIAL client with a generated secret; a
  // public (PKCE-only) client has no secret and SecurityPolicy requires one.
  const otelOidcIssuer = (cfg.get("otelOidcIssuer") ?? "").replace(/\/+$/, "");
  const otelOidcClientId = cfg.get("otelOidcClientId") ?? "";
  const otelOidcClientSecret = cfg.getSecret("otelOidcClientSecret");
  const observabilityFlag = bool(cfg, "observabilityEnabled", true);
  const missingObservabilityDeps = [
    otelPrimaryApiKey === undefined ? "otelPrimaryApiKey" : undefined,
    otelOidcIssuer === "" ? "otelOidcIssuer" : undefined,
    otelOidcClientId === "" ? "otelOidcClientId" : undefined,
    otelOidcClientSecret === undefined ? "otelOidcClientSecret" : undefined,
  ].filter((k): k is string => k !== undefined);
  const observabilityEnabled = observabilityFlag && missingObservabilityDeps.length === 0;

  // Fail closed: the Aspire dashboard authenticates nobody itself (ADR-0029
  // Amendment 2 moved auth to the Gateway SecurityPolicy), and the ONLY thing
  // keeping the rest of the namespace off its unauthenticated :18888 is the
  // NetworkPolicy set. Turning policies off while the tier is deployed would
  // publish every tenant's prompts, retrieved snippets, LLM output and
  // presigned S3 URLs to any pod that gets a foothold. Refuse the combination
  // rather than silently shipping it.
  if (observabilityEnabled && !bool(cfg, "networkPolicies", true)) {
    throw new Error(
      "grid-oib:observabilityEnabled requires grid-oib:networkPolicies. The Aspire dashboard " +
        "runs AuthMode=Unsecured and relies on NetworkPolicies to keep the namespace off its " +
        "unauthenticated UI port. Set networkPolicies=true, or observabilityEnabled=false.",
    );
  }
  if (observabilityFlag && !observabilityEnabled) {
    pulumi.log.warn(
      "Observability (ADR-0029) not deployed: missing " +
        missingObservabilityDeps.map((k) => `grid-oib:${k}`).join(", ") +
        ". Set them to deploy the OTel Collector + Aspire dashboard, or set " +
        "grid-oib:observabilityEnabled=false to silence this.",
    );
  }

  // ── Public DNS (Cloudflare) ────────────────────────────────────────────────
  //
  // Everything below is validated eagerly rather than at `installDns`, because
  // every one of these mistakes produces records that Cloudflare accepts and
  // reports as created. There is no failing resource to read afterwards — only
  // a name that resolves somewhere unhelpful, weeks later, to whoever tries it.
  const loadBalancerIp = cfg.get("loadBalancerIp");
  const dnsEnabled = bool(cfg, "dnsEnabled", false);
  const dnsZoneId = cfg.get("dnsZoneId") ?? "";
  const dnsZoneName = (cfg.get("dnsZoneName") ?? "").replace(/\.$/, "");
  const cloudflareApiToken = cfg.getSecret("cloudflareApiToken");
  const dnsApexRedirectTo = cfg.get("dnsApexRedirectTo");
  const dnsZoneBaseline = bool(cfg, "dnsZoneBaseline", false);
  const dnsHosts = managedHosts({
    webDomain,
    appDomain,
    s3Domain,
    otelDomain: observabilityEnabled ? otelDomain : undefined,
  });

  if (dnsEnabled) {
    const missingDnsDeps = [
      dnsZoneId === "" ? "dnsZoneId" : undefined,
      dnsZoneName === "" ? "dnsZoneName" : undefined,
      cloudflareApiToken === undefined ? "cloudflareApiToken" : undefined,
    ].filter((k): k is string => k !== undefined);
    if (missingDnsDeps.length > 0) {
      throw new Error(
        `grid-oib:dnsEnabled is set but ${missingDnsDeps
          .map((k) => `grid-oib:${k}`)
          .join(", ")} ${missingDnsDeps.length === 1 ? "is" : "are"} missing. DNS is all-or-nothing ` +
          "on purpose: a half-configured zone leaves some hosts managed and the rest silently stale.",
      );
    }
    // The whole point of managing DNS here is that the address is known and
    // stable. Without `loadBalancerIp` the provider assigns one on first deploy
    // and can assign a different one after a Gateway re-creation — records
    // written from an unpinned address are wrong the moment that happens, and
    // nothing in this program would notice.
    if (loadBalancerIp === undefined || loadBalancerIp === "") {
      throw new Error(
        "grid-oib:dnsEnabled requires grid-oib:loadBalancerIp. The A records need an address to " +
          "point at, and an unpinned LoadBalancer IP can change under a Gateway re-creation — " +
          "which would leave the records pointing at an address the provider has since reassigned. " +
          "Deploy once without DNS, read the IP (`kubectl -n envoy-gateway-system get svc`), pin " +
          "it, then enable this.",
      );
    }
    const strays = hostsOutsideZone(dnsHosts, dnsZoneName);
    if (strays.length > 0) {
      throw new Error(
        `grid-oib:dnsZoneName is "${dnsZoneName}" but ${strays.join(", ")} ` +
          `${strays.length === 1 ? "is" : "are"} not inside it. Cloudflare treats a name outside ` +
          `the zone as RELATIVE and appends the zone to it, so this would create ` +
          `"${strays[0]}.${dnsZoneName}" and report success. Fix baseDomain, or point dnsZoneName ` +
          "at the zone that actually contains these hosts.",
      );
    }
    // The redirect is scaffolding for a zone apex no stack serves yet. Once a
    // stack's own baseDomain IS the apex, that stack publishes a real A record
    // for it — and both would be the same Cloudflare record, so whichever
    // resource is created second wins and the outcome depends on graph order.
    if (dnsApexRedirectTo !== undefined && webDomain === dnsZoneName) {
      throw new Error(
        `grid-oib:dnsApexRedirectTo is set while this stack already serves the apex ` +
          `("${webDomain}"). Both would write the same record. Unset dnsApexRedirectTo — the ` +
          "redirect exists only for the window before a stack owns the apex.",
      );
    }
    if (dnsApexRedirectTo !== undefined && !dnsZoneBaseline) {
      throw new Error(
        "grid-oib:dnsApexRedirectTo requires grid-oib:dnsZoneBaseline. The apex, www and _dmarc " +
          "are zone-level records with at most one owning stack; the baseline flag is what " +
          "declares this stack to be it.",
      );
    }
    if (dnsApexRedirectTo !== undefined && !/^https?:\/\//.test(dnsApexRedirectTo)) {
      throw new Error(
        `grid-oib:dnsApexRedirectTo must be an absolute URL (got "${dnsApexRedirectTo}"). ` +
          "Cloudflare sends it to the browser as a Location header verbatim.",
      );
    }
  }

  // ── err2issue (ADR-0031): same availability = flag AND capability rule ─────
  // Opt-in (default false) because turning it on starts writing to a GitHub
  // repo — a side effect outside the cluster, unlike every other component
  // here. The dependency on `observabilityEnabled` is structural, not stylistic:
  // err2issue has no receiver of its own in this design, it is fed by the
  // collector's logs pipeline, so without the collector it is a pod that can
  // only ever sit idle.
  const err2issueFlag = bool(cfg, "err2issueEnabled", false);
  const err2issueGithubRepo = cfg.get("err2issueGithubRepo") ?? "";
  const err2issueGithubToken = cfg.getSecret("err2issueGithubToken");
  const missingErr2IssueDeps = [
    err2issueGithubRepo === "" ? "err2issueGithubRepo" : undefined,
    err2issueGithubToken === undefined ? "err2issueGithubToken" : undefined,
    observabilityEnabled ? undefined : "observabilityEnabled (err2issue is fed by the collector)",
  ].filter((k): k is string => k !== undefined);
  const err2issueEnabled = err2issueFlag && missingErr2IssueDeps.length === 0;
  if (err2issueFlag && !err2issueEnabled) {
    pulumi.log.warn(
      "err2issue (ADR-0031) not deployed: missing " +
        missingErr2IssueDeps.map((k) => (k.includes(" ") ? k : `grid-oib:${k}`)).join(", ") +
        ". Set them to deploy the error→issue sink, or set " +
        "grid-oib:err2issueEnabled=false to silence this.",
    );
  }

  return {
    namespace: cfg.get("namespace") ?? "grid",
    kubeconfig: cfg.requireSecret("kubeconfig"),

    images: {
      registry: cfg.get("imageRegistry") ?? "ghcr.io/grid-check",
      tag: imageTag,
      backend: cfg.get("backendImage"),
      frontend: cfg.get("frontendImage"),
      web: cfg.get("webImage"),
      // Explicit escape hatch only; the default is derived per image ref —
      // see `appPullPolicy` and the field's doc comment.
      pullPolicyOverride: cfg.get("imagePullPolicy"),
      pullCredentials:
        registryUsername && registryPassword
          ? { username: registryUsername, password: registryPassword }
          : undefined,
    },

    storage: {
      className: cfg.require("storageClass"),
    },

    ingress: {
      appDomain,
      s3Domain,
      webDomain,
      letsEncryptEmail: cfg.require("letsEncryptEmail"),
      // Default to the LE STAGING CA: on a first deploy the LoadBalancer IP (and
    // therefore DNS) doesn't exist yet, so HTTP-01 can't be solved and every
    // failed prod attempt burns Let's Encrypt rate limits. Flip to false only
    // after DNS resolves to the gateway and a staging cert has issued.
    useStagingIssuer: bool(cfg, "useStagingIssuer", true),
      // Default FALSE: the managed provider ships an unremovable metrics stack.
      installMetricsServer: bool(cfg, "installMetricsServer", false),
      loadBalancerIp,
      // 0 = trust Envoy's own downstream address. See the interface comment:
      // this is the one setting every per-IP limit rests on, and it must be
      // confirmed against a live cluster rather than assumed.
      xffNumTrustedHops: num(cfg, "xffNumTrustedHops", 0),
      maxConnectionsPerProxy: num(cfg, "maxConnectionsPerProxy", 10000),
    },

    dns: {
      enabled: dnsEnabled,
      zoneId: dnsZoneId,
      zoneName: dnsZoneName,
      // `??` only reached when disabled — the guard above requires the token
      // whenever `dnsEnabled`, so `installDns` never sees this empty.
      apiToken: cloudflareApiToken ?? pulumi.secret(""),
      targetIp: loadBalancerIp ?? "",
      hosts: dnsHosts,
      // 600s, matching what these records already carried at the previous
      // operator. Low enough that a LoadBalancer IP change is a ten-minute
      // event rather than an hour-long one, high enough not to matter.
      ttl: num(cfg, "dnsTtl", 600),
      zoneBaseline: dnsZoneBaseline,
      dmarc: cfg.get("dnsDmarc"),
      apexRedirectTo: dnsApexRedirectTo,
    },

    postgres: {
      instances: num(cfg, "pgInstances", 1),
      storageSize: cfg.get("pgStorageSize") ?? "20Gi",
      appUser: cfg.get("pgAppUser") ?? "aiq",
      appPassword: cfg.requireSecret("pgAppPassword"),
      runtimePassword: cfg.requireSecret("pgRuntimePassword"),
      primaryUpdateStrategy:
        cfg.get("pgPrimaryUpdateStrategy") === "supervised" ? "supervised" : "unsupervised",
      backups: {
        enabled: pgBackupsEnabled,
        endpoint: pgBackupEndpoint,
        accessKey: cfg.get("pgBackupAccessKey"),
        secretKey: cfg.getSecret("pgBackupSecretKey"),
        bucket: cfg.get("pgBackupBucket") ?? "grid-pg-backups",
        retention: cfg.get("pgBackupRetention") ?? "30d",
        schedule: cfg.get("pgBackupSchedule") ?? "0 0 2 * * *",
        encryption: pgBackupEncryption,
      },
    },

    dragonfly: {
      maxmemory: cfg.get("dragonflyMaxmemory") ?? "512mb",
      memoryLimit: cfg.get("dragonflyMemoryLimit") ?? "768Mi",
      password: dragonflyPassword,
    },

    rateLimit: {
      enabled: rateLimitEnabled,
      // Ships observing, not enforcing. Flip this to false only with the
      // would-have-blocked counts in front of you.
      shadowMode: bool(cfg, "rateLimitShadowMode", true),
      failClosed: bool(cfg, "rateLimitFailClosed", false),
      limits: {
        // Starting points, not measurements. A chat session is chatty (polling
        // the inbox, presence, conversation reads), so the catch-all is
        // deliberately loose — it is there to stop a runaway loop, not to shape
        // traffic. The two narrow rules are the ones with a real threat behind
        // them.
        app: num(cfg, "rateLimitApp", 600),
        appAuth: num(cfg, "rateLimitAppAuth", 20),
        appWsUpgrade: num(cfg, "rateLimitAppWsUpgrade", 30),
        s3: num(cfg, "rateLimitS3", 300),
        web: num(cfg, "rateLimitWeb", 120),
      },
      storeMaxmemory: cfg.get("rateLimitStoreMaxmemory") ?? "256mb",
      storeMemoryLimit: cfg.get("rateLimitStoreMemoryLimit") ?? "384Mi",
      storePassword: rateLimitStorePassword,
    },

    networkPolicies: bool(cfg, "networkPolicies", true),

    protectDataResources: bool(cfg, "protectDataResources", true),

    chroma: {
      enabled: chromaEnabled,
      // Deliberately pinned (NOT latest): the server API/wire protocol is
      // coupled to the backend's `chromadb` Python client. It MUST match — a 1.x
      // client against a 0.5.x server fails ingestion with KeyError('_type'),
      // and 1.x moved the API/probe surface /api/v1 -> /api/v2. The backend
      // currently ships chromadb 1.5.9; bump this only together with it.
      image: cfg.get("chromaImage") ?? "chromadb/chroma:1.5.9",
      storageSize: cfg.get("chromaStorageSize") ?? "20Gi",
    },

    seaweedfs: {
      image: cfg.get("seaweedfsImage") ?? "chrislusf/seaweedfs:latest",
      storageSize: cfg.get("seaweedfsStorageSize") ?? "20Gi",
      bucket: cfg.get("seaweedfsBucket") ?? "grid-documents",
      accessKey: cfg.get("seaweedfsAccessKey") ?? "grid",
      secretKey: cfg.requireSecret("seaweedfsSecretKey"),
      // Read-only, bucket-scoped identity for the aiq-agent tier (see the type
      // doc above). The secret key must be its own value, set like the root:
      // `pulumi config set --secret grid-oib:seaweedfsBackendReadSecretKey "…"`.
      backendReadAccessKey: cfg.get("seaweedfsBackendReadAccessKey") ?? "grid-backend-read",
      backendReadSecretKey: cfg.requireSecret("seaweedfsBackendReadSecretKey"),
      perOrgBuckets: seaweedPerOrgBuckets,
      tenantBucketPrefix: seaweedTenantPrefix,
      tenantAdminAccessKey: cfg.get("seaweedfsTenantAdminAccessKey") ?? "grid-tenant-admin",
      tenantAdminSecretKey: cfg.getSecret("seaweedfsTenantAdminSecretKey") ?? pulumi.secret(""),
      topology: seaweedTopology,
      masterReplicas: seaweedMasterReplicas,
      volumeReplicas: num(cfg, "seaweedfsVolumeReplicas", 1),
      filerReplicas: seaweedFilerReplicas,
      masterStorageSize: cfg.get("seaweedfsMasterStorageSize") ?? "1Gi",
      // 10Gi, not the master's 1Gi: under the leveldb store this claim is the
      // key store for every object in the deployment, and it is the one PVC
      // whose exhaustion stops all writes.
      filerStorageSize: cfg.get("seaweedfsFilerStorageSize") ?? "10Gi",
      volumeSizeLimitMB: seaweedVolumeSizeLimitMB,
      volumeMaxCount: num(cfg, "seaweedfsVolumeMaxCount", 64),
      volumeMinFreeSpace: cfg.get("seaweedfsVolumeMinFreeSpace") ?? "2GiB",
      defaultReplication: seaweedReplication,
      filerStore: seaweedFilerStore,
      filerDatabase: SEAWEED_FILER_DB,
      filerDatabaseUser: SEAWEED_FILER_DB,
      // Only read when the split topology uses the Postgres store — see the
      // validation above, which is what turns a missing value into a clear
      // error instead of a filer that boots and cannot reach its store.
      filerDatabasePassword:
        cfg.getSecret("seaweedfsFilerDbPassword") ?? pulumi.secret(""),
      backup: {
        enabled: cfg.getBoolean("seaweedfsBackupEnabled") ?? false,
        endpoint: cfg.get("seaweedfsBackupEndpoint") ?? "",
        bucket: cfg.get("seaweedfsBackupBucket") ?? "grid-documents-backup",
        region: cfg.get("seaweedfsBackupRegion") ?? "us-east-1",
        accessKey: cfg.getSecret("seaweedfsBackupAccessKey") ?? pulumi.secret(""),
        secretKey: cfg.getSecret("seaweedfsBackupSecretKey") ?? pulumi.secret(""),
        metadataSchedule: cfg.get("seaweedfsMetaSnapshotSchedule") ?? "0 3 * * *",
      },
      encryptVolumeData: cfg.getBoolean("seaweedfsEncryptVolumeData") ?? true,
    },

    backend: {
      resources: {
        requestsCpu: cfg.get("backendRequestsCpu") ?? "1",
        requestsMemory: cfg.get("backendRequestsMemory") ?? "2Gi",
        limitsCpu: cfg.get("backendLimitsCpu") ?? "4",
        limitsMemory: cfg.get("backendLimitsMemory") ?? "8Gi",
      },
      daskWorkers: num(cfg, "backendDaskWorkers", 1),
      daskThreads: num(cfg, "backendDaskThreads", 4),
      maxActiveJobs: num(cfg, "backendMaxActiveJobs", 8),
      maxActiveJobsPerOrg: num(cfg, "backendMaxActiveJobsPerOrg", 3),
      ingestMaxWorkers: num(cfg, "backendIngestMaxWorkers", 2),
      configFile: cfg.get("backendConfigFile") ?? "/app/configs/config_oib_openrouter.yml",
      chromaDir: cfg.get("backendChromaDir") ?? "/app/data/chroma_data",
      dataStorageSize: cfg.get("backendDataStorageSize") ?? "20Gi",
      // Multi-replica chat/web tier. Safe because the frontend WS proxy pins each
      // conversation to its owning replica by hash (conversation affinity,
      // ADR-0028), so the in-process WS/HITL/task state is always reachable. The
      // headless service (backend.ts) provides the per-pod DNS this needs.
      replicas: num(cfg, "backendReplicas", 2),
    },

    frontend: {
      /**
       * `requests` is load-bearing twice over, and both uses want the same
       * number: roughly what a pod actually consumes at steady state.
       *
       *   1. **The HPA divides by it.** `averageUtilization` is a percentage of
       *      REQUESTS, not of limits. At the previous `100m`, the 70% target
       *      meant 70 millicores — 7% of the pod's own 1-core limit — which a
       *      Next.js SSR pod clears the moment it serves anything. The HPA
       *      therefore had no proportional range: idle sat at `minReplicas` and
       *      any traffic at all pinned it to `maxReplicas`. At `500m` the target
       *      is 350m, i.e. scale out at ~35% of the limit, leaving burst room.
       *   2. **The scheduler bin-packs on it.** `100m` told the scheduler each
       *      pod was tiny, so all `maxReplicas` could land on one node — and
       *      `topologySpreadConstraints` is `ScheduleAnyway` (soft, by design),
       *      so it would not prevent that. The PDB and the spread policy both
       *      assume replicas are actually spread.
       *
       * Tune from real usage (`kubectl top pods -l app.kubernetes.io/name=frontend`)
       * rather than from this default; the invariant to preserve is
       * `requests ≈ steady-state` and `limits ≈ 2x requests` for burst.
       */
      resources: {
        requestsCpu: cfg.get("frontendRequestsCpu") ?? "500m",
        requestsMemory: cfg.get("frontendRequestsMemory") ?? "512Mi",
        limitsCpu: cfg.get("frontendLimitsCpu") ?? "1",
        limitsMemory: cfg.get("frontendLimitsMemory") ?? "1Gi",
      },
      minReplicas: num(cfg, "frontendMinReplicas", 2),
      maxReplicas: num(cfg, "frontendMaxReplicas", 6),
      hpaCpuTargetPercent: num(cfg, "frontendHpaCpuTargetPercent", 70),
    },

    web: {
      // Static-first site: requests are a floor for the HPA and the scheduler,
      // limits only a burst ceiling. The Astro server barely idles above zero,
      // but the request must stay proportional to the HPA: at 70% target the
      // trigger (70m at 100m requests) must clear ~15% of the 250m limit or
      // assertHpaTargetIsProportional fails the deploy (see frontend tier).
      resources: {
        requestsCpu: cfg.get("webRequestsCpu") ?? "100m",
        requestsMemory: cfg.get("webRequestsMemory") ?? "128Mi",
        limitsCpu: cfg.get("webLimitsCpu") ?? "250m",
        limitsMemory: cfg.get("webLimitsMemory") ?? "256Mi",
      },
      minReplicas: webMinReplicas,
      maxReplicas: num(cfg, "webMaxReplicas", 4),
      hpaCpuTargetPercent: num(cfg, "webHpaCpuTargetPercent", 70),
    },

    jobExecution,
    conversationBus,
    agentWorker: {
      resources: {
        requestsCpu: cfg.get("agentWorkerRequestsCpu") ?? "1",
        requestsMemory: cfg.get("agentWorkerRequestsMemory") ?? "2Gi",
        limitsCpu: cfg.get("agentWorkerLimitsCpu") ?? "4",
        limitsMemory: cfg.get("agentWorkerLimitsMemory") ?? "8Gi",
      },
      minReplicas: num(cfg, "agentWorkerMinReplicas", 2),
      maxReplicas: num(cfg, "agentWorkerMaxReplicas", 8),
      hpaCpuTargetPercent: num(cfg, "agentWorkerHpaCpuTargetPercent", 70),
      concurrency: num(cfg, "agentWorkerConcurrency", 1),
      // 10 minutes: long enough for a typical deep-research run to land, short
      // enough that a rolling deploy of the tier stays inside the CD timeout.
      // Clamped to a sane floor — a value below the default 30s would be a
      // silent downgrade from Kubernetes' own behaviour.
      drainSeconds: Math.max(30, num(cfg, "agentWorkerDrainSeconds", 600)),
    },

    llm: {
      openrouterApiKey: cfg.requireSecret("openrouterApiKey"),
      tavilyApiKey: cfg.requireSecret("tavilyApiKey"),
      embedModel: cfg.get("embedModel") ?? "openai/text-embedding-3-large",
      embedBaseUrl: cfg.get("embedBaseUrl") ?? "https://openrouter.ai/api/v1",
      vlmModel: cfg.get("vlmModel") ?? "google/gemma-4-31b-it",
      vlmBaseUrl: cfg.get("vlmBaseUrl") ?? "https://openrouter.ai/api/v1",
      budgetEurPerUsd: cfg.get("budgetEurPerUsd") ?? "0.86",
    },

    auth: {
      requireAuth: bool(cfg, "requireAuth", true),
      workosClientId,
      workosApiKey: workosApiKey ?? pulumi.output(""),
      workosCookiePassword: cfg.getSecret("workosCookiePassword") ?? pulumi.output(""),
      platformOwnerEmails: cfg.get("platformOwnerEmails") ?? "",
      platformOrgExternalId: cfg.get("platformOrgExternalId") ?? "grid-platform",
      disableSelfServeOrgs: bool(cfg, "disableSelfServeOrgs", false),
      enforceFeatureFlags: bool(cfg, "enforceFeatureFlags", false),
      byokSecretBackend: cfg.get("byokSecretBackend") ?? "",
      byokLocalKek: cfg.getSecret("byokLocalKek") ?? pulumi.output(""),
      allowAgentOrgMemory: bool(cfg, "allowAgentOrgMemory", false),
    },

    internal: {
      apiToken: cfg.requireSecret("gridInternalApiToken"),
      adminToken: cfg.requireSecret("gridAdminToken"),
      jobPayloadKek: jobPayloadKek ?? pulumi.output(""),
    },

    workflows: {
      enabled: bool(cfg, "workflowsEnabled", false),
      minIntervalMinutes: num(cfg, "workflowMinIntervalMinutes", 15),
    },

    storageAlerts: {
      enabled: bool(cfg, "storageAlertsEnabled", true),
      thresholdPercent: storageAlertThresholdPercent,
      schedule: cfg.get("storageAlertSchedule") ?? "0 * * * *",
    },

    collaboration: {
      enabled: bool(cfg, "collaborationEnabled", false),
    },

    memory: {
      reflectionEnabled: bool(cfg, "memoryReflectionEnabled", true),
    },

    observability: {
      enabled: observabilityEnabled,
      otelDomain,
      // Digest-pinned (supply chain): 13.4.2 and 0.157.0 respectively. Bump
      // deliberately via config when upgrading — the pins are scanned by the
      // trivy job in .github/workflows/security.yml, which blocks on fixable
      // HIGH/CRITICAL, so a stale pin surfaces as a failing check.
      dashboardImage:
        cfg.get("dashboardImage") ??
        "mcr.microsoft.com/dotnet/aspire-dashboard@sha256:d71f709233fdd53092a9a562ca6fb74264aec7c16c9aff03da94091f18ea2394",
      collectorImage:
        cfg.get("collectorImage") ??
        "otel/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6",
      telemetryLimits: {
        maxLogCount: num(cfg, "dashboardMaxLogCount", 50000),
        maxTraceCount: num(cfg, "dashboardMaxTraceCount", 50000),
      },
      otelPrimaryApiKey: otelPrimaryApiKey ?? pulumi.output(""),
      oidcIssuer: otelOidcIssuer,
      oidcClientId: otelOidcClientId,
      oidcClientSecret: otelOidcClientSecret ?? pulumi.output(""),
    },

    err2issue: {
      enabled: err2issueEnabled,
      // NOT digest-pinned, unlike every other image here: upstream publishes
      // no tags or releases yet, so `:latest` is the only reference that
      // exists. Pin this before prod — see the dev/prod stack notes.
      image: cfg.get("err2issueImage") ?? "ghcr.io/matthiasbigl/err2issue:latest",
      githubRepo: err2issueGithubRepo,
      githubToken: err2issueGithubToken ?? pulumi.output(""),
      routeMap: cfg.get("err2issueRouteMap") ?? "",
      anthropicApiKey: cfg.getSecret("err2issueAnthropicApiKey") ?? pulumi.output(""),
      suppressWindowSeconds: num(cfg, "err2issueSuppressWindowSeconds", 600),
      // Deliberately below the upstream default of 50. This is the first
      // deployment of an error sink against a repo that has never had one: the
      // realistic failure is a long tail of pre-existing, never-noticed errors
      // arriving at once and burying the issue tracker on day one. Raise it
      // once the steady-state volume is known.
      maxNewFingerprintsPerDay: num(cfg, "err2issueMaxNewFingerprintsPerDay", 20),
      dropUnrouted: bool(cfg, "err2issueDropUnrouted", true),
    },
  };
}

/** Resolve the concrete backend image reference. */
export function backendImage(c: GridConfig): string {
  return c.images.backend ?? `${c.images.registry}/grid-oib-backend:${c.images.tag}`;
}

/** Resolve the concrete frontend image reference. */
export function frontendImage(c: GridConfig): string {
  return c.images.frontend ?? `${c.images.registry}/grid-oib-frontend:${c.images.tag}`;
}

/** Resolve the concrete landing-site (web) image reference. */
export function webImage(c: GridConfig): string {
  return c.images.web ?? `${c.images.registry}/grid-oib-web:${c.images.tag}`;
}

/**
 * Pull policy for an app-tier image: the explicit `imagePullPolicy` override
 * when set, otherwise derived from the resolved reference (`pullPolicyFor`).
 * Every app workload must use this rather than a single stack-wide value:
 * CI deploys routinely mix reference kinds (a SHA `imageTag` for rebuilt
 * services, `:latest` fallbacks for the rest), and only the per-image rule
 * keeps a moving tag on `Always` — which the `moving-tag-must-repull`
 * policy-pack rule enforces.
 */
export function appPullPolicy(c: GridConfig, image: string): string {
  return c.images.pullPolicyOverride ?? pullPolicyFor(image);
}

/**
 * The only correct `imagePullPolicy` for a given image reference.
 *
 * Same rule the app images follow (see `appPullPolicy`), applied to
 * the upstream data-tier images too: a MOVING tag (`latest`, or no tag at all)
 * must re-pull on every pod start or a rescheduled pod silently keeps a stale
 * cached layer; a digest-pinned or version-pinned reference is immutable, so
 * re-pulling is pure latency. Kubernetes already infers this, but stating it
 * makes the intent reviewable — and lets the policy pack enforce it.
 */
export function pullPolicyFor(image: string): string {
  if (image.includes("@sha256:")) return "IfNotPresent"; // digest-pinned = immutable
  const tag = image.split("/").pop()?.split(":")[1];
  return tag === undefined || tag === "latest" ? "Always" : "IfNotPresent";
}

/** Map a ResourceSpec to a k8s ResourceRequirements literal. */
export function toResourceRequirements(r: ResourceSpec) {
  return {
    requests: { cpu: r.requestsCpu, memory: r.requestsMemory },
    limits: { cpu: r.limitsCpu, memory: r.limitsMemory },
  };
}

/** Parse a k8s CPU quantity ("500m", "1", "1500m") into millicores. */
export function cpuMillicores(quantity: string): number {
  const trimmed = quantity.trim();
  return trimmed.endsWith("m")
    ? Number(trimmed.slice(0, -1))
    : Number(trimmed) * 1000;
}

/** Parse a k8s memory quantity ("512Mi", "2Gi", "1000000") into bytes. */
export function memoryBytes(quantity: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(
    quantity.trim(),
  );
  if (!match) return NaN;
  const multipliers: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return Number(match[1]) * (match[2] ? multipliers[match[2]] : 1);
}

/**
 * Guard memory requests against memory limits.
 *
 * `toResourceRequirements` forwards whatever strings the config carries, and
 * Kubernetes only rejects them at admission — i.e. after `pulumi up` has already
 * started mutating the cluster. A typo ("512M1") or an inverted pair
 * (request 2Gi, limit 512Mi) fails the preview here instead.
 */
export function assertMemoryFitsLimit(tier: string, r: ResourceSpec): void {
  const requests = memoryBytes(r.requestsMemory);
  const limits = memoryBytes(r.limitsMemory);

  if (
    !Number.isFinite(requests) ||
    !Number.isFinite(limits) ||
    requests <= 0 ||
    limits <= 0
  ) {
    throw new Error(
      `${tier}: could not parse memory resources ` +
        `(requests=${r.requestsMemory}, limits=${r.limitsMemory}).`,
    );
  }

  if (limits < requests) {
    throw new Error(
      `${tier}: memory limit (${r.limitsMemory}) is below the request (${r.requestsMemory}).`,
    );
  }
}

/**
 * Guard the relationship between CPU requests, CPU limits and the HPA target.
 *
 * An HPA's `averageUtilization` is a percentage of **requests**. That makes a
 * too-small request silently destroy the control loop: the absolute trigger
 * drops far below what a pod uses at idle, so the HPA is pinned at
 * `maxReplicas` under any load at all and the "70%" in the config reads
 * reassuring while meaning nothing. It is invisible in review because each
 * individual number looks defensible — only the ratio is wrong.
 *
 * Same spirit as `assertDrainFitsGrace` in rollout.ts: encode the invariant
 * where it can fail the deploy, not in a comment nobody re-reads.
 */
export function assertHpaTargetIsProportional(
  tier: string,
  r: ResourceSpec,
  hpaCpuTargetPercent: number,
): void {
  const requests = cpuMillicores(r.requestsCpu);
  const limits = cpuMillicores(r.limitsCpu);

  if (!Number.isFinite(requests) || !Number.isFinite(limits) || requests <= 0) {
    throw new Error(
      `${tier}: could not parse CPU resources ` +
        `(requests=${r.requestsCpu}, limits=${r.limitsCpu}).`,
    );
  }

  // A NaN or Infinity target would slip past both comparisons below (every
  // comparison against NaN is false), so the validator would accept it.
  if (!Number.isFinite(hpaCpuTargetPercent) || hpaCpuTargetPercent <= 0) {
    throw new Error(
      `${tier}: HPA CPU target must be a finite positive number ` +
        `(got ${hpaCpuTargetPercent}).`,
    );
  }

  const trigger = (requests * hpaCpuTargetPercent) / 100;

  // Below ~15% of the limit the HPA stops being proportional control and
  // becomes an on/off switch to maxReplicas.
  const triggerFractionOfLimit = trigger / limits;
  if (triggerFractionOfLimit < 0.15) {
    throw new Error(
      `${tier}: HPA target of ${hpaCpuTargetPercent}% of ${r.requestsCpu} requests ` +
        `= ${trigger}m, only ${(triggerFractionOfLimit * 100).toFixed(1)}% of the ` +
        `${r.limitsCpu} limit. The HPA will pin to maxReplicas under any load. ` +
        `Raise the CPU request toward real steady-state usage.`,
    );
  }

  if (limits < requests) {
    throw new Error(
      `${tier}: CPU limit (${r.limitsCpu}) is below the request (${r.requestsCpu}).`,
    );
  }
}

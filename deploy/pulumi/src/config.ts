import * as pulumi from "@pulumi/pulumi";

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
    pullPolicy: string;
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
      // A MOVING tag (`latest`) must re-pull on every pod start, or a rescheduled
      // pod silently keeps a stale cached image and a deploy "succeeds" without
      // shipping the new code. Only a pinned/immutable tag (a SHA) is safe as
      // IfNotPresent. Explicit `imagePullPolicy` always wins.
      pullPolicy:
        cfg.get("imagePullPolicy") ?? (imageTag === "latest" ? "Always" : "IfNotPresent"),
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
      loadBalancerIp: cfg.get("loadBalancerIp"),
    },

    postgres: {
      instances: num(cfg, "pgInstances", 1),
      storageSize: cfg.get("pgStorageSize") ?? "20Gi",
      appUser: cfg.get("pgAppUser") ?? "aiq",
      appPassword: cfg.requireSecret("pgAppPassword"),
      primaryUpdateStrategy:
        cfg.get("pgPrimaryUpdateStrategy") === "supervised" ? "supervised" : "unsupervised",
      backups: {
        enabled: bool(cfg, "pgBackupsEnabled", false),
        endpoint: cfg.get("pgBackupEndpoint") ?? "http://seaweedfs:8333",
        accessKey: cfg.get("pgBackupAccessKey"),
        secretKey: cfg.getSecret("pgBackupSecretKey"),
        bucket: cfg.get("pgBackupBucket") ?? "grid-pg-backups",
        retention: cfg.get("pgBackupRetention") ?? "30d",
        schedule: cfg.get("pgBackupSchedule") ?? "0 0 2 * * *",
      },
    },

    dragonfly: {
      maxmemory: cfg.get("dragonflyMaxmemory") ?? "512mb",
      memoryLimit: cfg.get("dragonflyMemoryLimit") ?? "768Mi",
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
 * The only correct `imagePullPolicy` for a given image reference.
 *
 * Same rule the app images follow (see `images.pullPolicy` above), applied to
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

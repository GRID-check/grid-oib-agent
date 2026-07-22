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
    pullPolicy: string;
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
    /** Public host for the app (frontend + BFF + WS). */
    appDomain: string;
    /** Public host for the S3 endpoint used to sign browser preview/download URLs. */
    s3Domain: string;
    /** Email for the Let's Encrypt ACME account. */
    letsEncryptEmail: string;
    /** Use the LE staging CA (avoids rate limits while wiring DNS/TLS). */
    useStagingIssuer: boolean;
  };

  postgres: {
    /** CloudNativePG instance count (1 = single primary; ≥2 = HA with replicas). */
    instances: number;
    storageSize: string;
    /** App role name that owns the three databases. */
    appUser: string;
    /** App role password. Secret. Drives every DSN. */
    appPassword: pulumi.Output<string>;
  };

  dragonfly: {
    maxmemory: string;
  };

  seaweedfs: {
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
  };

  frontend: {
    resources: ResourceSpec;
    minReplicas: number;
    maxReplicas: number;
    /** HPA target average CPU utilisation (%). */
    hpaCpuTargetPercent: number;
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
  };

  workflows: {
    enabled: boolean;
    minIntervalMinutes: number;
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

  return {
    namespace: cfg.get("namespace") ?? "grid",
    kubeconfig: cfg.requireSecret("kubeconfig"),

    images: {
      registry: cfg.get("imageRegistry") ?? "ghcr.io/grid-check",
      tag: cfg.get("imageTag") ?? "latest",
      backend: cfg.get("backendImage"),
      frontend: cfg.get("frontendImage"),
      pullPolicy: cfg.get("imagePullPolicy") ?? "IfNotPresent",
    },

    storage: {
      className: cfg.require("storageClass"),
    },

    ingress: {
      appDomain: cfg.require("appDomain"),
      s3Domain: cfg.require("s3Domain"),
      letsEncryptEmail: cfg.require("letsEncryptEmail"),
      useStagingIssuer: bool(cfg, "useStagingIssuer", false),
    },

    postgres: {
      instances: num(cfg, "pgInstances", 1),
      storageSize: cfg.get("pgStorageSize") ?? "20Gi",
      appUser: cfg.get("pgAppUser") ?? "aiq",
      appPassword: cfg.requireSecret("pgAppPassword"),
    },

    dragonfly: {
      maxmemory: cfg.get("dragonflyMaxmemory") ?? "512mb",
    },

    seaweedfs: {
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
    },

    frontend: {
      resources: {
        requestsCpu: cfg.get("frontendRequestsCpu") ?? "100m",
        requestsMemory: cfg.get("frontendRequestsMemory") ?? "256Mi",
        limitsCpu: cfg.get("frontendLimitsCpu") ?? "1",
        limitsMemory: cfg.get("frontendLimitsMemory") ?? "1Gi",
      },
      minReplicas: num(cfg, "frontendMinReplicas", 2),
      maxReplicas: num(cfg, "frontendMaxReplicas", 6),
      hpaCpuTargetPercent: num(cfg, "frontendHpaCpuTargetPercent", 70),
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
      workosClientId: cfg.get("workosClientId") ?? "",
      workosApiKey: cfg.getSecret("workosApiKey") ?? pulumi.output(""),
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
    },

    workflows: {
      enabled: bool(cfg, "workflowsEnabled", false),
      minIntervalMinutes: num(cfg, "workflowMinIntervalMinutes", 15),
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

/** Map a ResourceSpec to a k8s ResourceRequirements literal. */
export function toResourceRequirements(r: ResourceSpec) {
  return {
    requests: { cpu: r.requestsCpu, memory: r.requestsMemory },
    limits: { cpu: r.limitsCpu, memory: r.limitsMemory },
  };
}

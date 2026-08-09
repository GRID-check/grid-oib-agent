import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IHTTPRouteSpec } from "@kubernetes-models/gateway-api/gateway.networking.k8s.io/v1/HTTPRouteSpec";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "./namespaces";
import {
  ROLLOUT,
  gracefulShutdown,
  recreateRollout,
  secretChecksum,
  secretChecksumAnnotations,
  surgeRollout,
} from "./rollout";
import { GATEWAY_NAME } from "./gateway";
import { platformOidcSecurityPolicySpec } from "./platform-oidc";
import { EDGE_TIMEOUT, LANGFUSE, PORT } from "../constants";

/** Secret name. A constant rather than `secret.metadata.name` because the
 *  SecurityPolicy spec is a plain (typed) object, not a Pulumi resource input. */
const SECRETS_NAME = "langfuse-secrets"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)

/**
 * Envoy Gateway requires the OIDC client secret under exactly this key
 * (`OIDC.ClientSecret`). Do not rename.
 */
const OIDC_CLIENT_SECRET_KEY = "client-secret"; // pragma: allowlist secret (Secret key name fixed by the Envoy Gateway API, not a credential)

/**
 * Keys in the Langfuse Secret. Exported for the collector's Basic-auth header.
 *
 * Every value here is a Secret KEY NAME — the string a `secretKeyRef` looks up
 * — not a credential.
 */
export const LANGFUSE_SECRET_KEYS = {
  databaseUrl: "database-url",
  clickhousePassword: "clickhouse-password", // pragma: allowlist secret (Secret key name, not a credential)
  redisUrl: "redis-url",
  salt: "salt",
  encryptionKey: "encryption-key",
  nextAuthSecret: "nextauth-secret", // pragma: allowlist secret (Secret key name, not a credential)
  publicKey: "public-key",
  secretKey: "secret-key", // pragma: allowlist secret (Secret key name, not a credential)
  initUserPassword: "init-user-password", // pragma: allowlist secret (Secret key name, not a credential)
  s3AccessKey: "s3-access-key",
  s3SecretKey: "s3-secret-key", // pragma: allowlist secret (Secret key name, not a credential)
  oidcClientSecret: OIDC_CLIENT_SECRET_KEY,
  /**
   * `Basic base64(publicKey:secretKey)` — precomputed here so the OTel
   * Collector can put it straight into an exporter header.
   *
   * The collector's config is a ConfigMap and its only secret-injection
   * mechanism is `${env:VAR}` interpolation of a whole header value. It cannot
   * base64 two env vars together, so building the header anywhere else would
   * mean either putting the credential in the ConfigMap or teaching the
   * collector to shell out. One derived Secret key is the smaller thing.
   */
  otlpBasicAuth: "otlp-basic-auth",
} as const;

/**
 * In-cluster OTLP/HTTP traces endpoint on the web tier.
 *
 * A function rather than two string literals because the collector and the
 * stack output both need it, and the collector's copy is the one that has to
 * be right — an endpoint that has drifted by a path segment fails as HTTP 404s
 * inside the exporter, which surfaces only as "no traces in Langfuse".
 */
export function langfuseOtlpTracesEndpoint(): string {
  return `http://${LANGFUSE.web}:${PORT.langfuseWeb}${LANGFUSE.otlpTracesPath}`;
}

export interface Langfuse {
  web: k8s.apps.v1.Deployment;
  worker: k8s.apps.v1.Deployment;
  webService: k8s.core.v1.Service;
  secret: k8s.core.v1.Secret;
  route: k8s.apiextensions.CustomResource;
  /** Edge-enforced OIDC + platform-permission gate in front of the UI. */
  securityPolicy: k8s.apiextensions.CustomResource;
  /** Full OTLP/HTTP traces endpoint the collector exports to. */
  otlpTracesEndpoint: pulumi.Output<string>;
}

export interface LangfuseInputs {
  /** DSN for the dedicated `langfuse` database, as its own role. */
  databaseUrl: pulumi.Output<string>;
  /** `CLICKHOUSE_URL` (HTTP) and `CLICKHOUSE_MIGRATION_URL` (native TCP). */
  clickhouseHttpUrl: pulumi.Output<string>;
  clickhouseMigrationUrl: pulumi.Output<string>;
  /** `redis://…` for the dedicated ingestion queue. */
  redisUrl: pulumi.Output<string>;
  /** In-cluster SeaweedFS S3 endpoint (`http://seaweedfs:8333`). */
  s3Endpoint: pulumi.Output<string>;
}

/**
 * Langfuse — the durable LLM-observability backend (ADR-0044).
 *
 * Two workloads over four backing stores, which is simply what Langfuse v3 is:
 *
 *   - **web** serves the UI, the public API, and the OTLP receiver the
 *     collector exports to. It does NOT write traces to ClickHouse inline: it
 *     parks each event in S3 and enqueues a reference.
 *   - **worker** drains that queue into ClickHouse and runs the background
 *     jobs (evaluators, batch exports).
 *
 * **This is the free, self-hosted OSS build.** No license key is set anywhere
 * in this module, deliberately. Everything wired here — tracing, sessions,
 * users, cost tracking, prompt management, datasets, evals, SSO — is
 * MIT-licensed core. The visible absence is retention: data-retention policies
 * are an Enterprise feature, so nothing here expires anything, and the
 * ClickHouse PVC is the resource that consequence lands on.
 *
 * **Access.** Two independent gates, and both are wanted:
 *
 *   1. The Envoy SecurityPolicy on the route (`platformOidcSecurityPolicySpec`)
 *      admits only WorkOS identities holding `platform:organizations:view` —
 *      the same rule that protects the Aspire dashboard, because the data is
 *      the same data: every tenant's prompts and model output.
 *   2. Langfuse's own SSO (`AUTH_CUSTOM_*`) against that same issuer then
 *      establishes a real Langfuse session.
 *
 * The second is not redundant. Unlike the Aspire dashboard, Langfuse cannot run
 * unauthenticated — it has users, projects and API keys of its own, and needs
 * to know who is asking. But it would, on its own, accept anyone who can sign
 * in to the WorkOS environment at all; the permission check that narrows that
 * to platform operators exists only at the edge. Removing either one is a real
 * widening of who can read cross-tenant telemetry.
 *
 * The two OIDC flows chain without conflicting: Envoy claims only
 * `/oauth2/callback` and `/logout`, while NextAuth uses
 * `/api/auth/callback/custom`, and by the time Langfuse redirects the browser
 * the WorkOS session already exists, so the second hop is silent.
 */
export function installLangfuse(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  inputs: LangfuseInputs,
  dependsOn: pulumi.Resource[],
): Langfuse {
  const { langfuse: lf } = cfg;
  const publicUrl = `https://${lf.domain}`;

  // Everything sensitive in one Secret, reached by `secretKeyRef` so no
  // credential is ever a plain value on a pod spec (readable by anything with
  // `get pod` in the namespace).
  const secretValues: Record<string, pulumi.Input<string>> = {
    [LANGFUSE_SECRET_KEYS.databaseUrl]: inputs.databaseUrl,
    [LANGFUSE_SECRET_KEYS.clickhousePassword]: lf.clickhousePassword,
    [LANGFUSE_SECRET_KEYS.redisUrl]: inputs.redisUrl,
    [LANGFUSE_SECRET_KEYS.salt]: lf.salt,
    [LANGFUSE_SECRET_KEYS.encryptionKey]: lf.encryptionKey,
    [LANGFUSE_SECRET_KEYS.nextAuthSecret]: lf.nextAuthSecret,
    [LANGFUSE_SECRET_KEYS.publicKey]: lf.publicKey,
    [LANGFUSE_SECRET_KEYS.secretKey]: lf.secretKey,
    [LANGFUSE_SECRET_KEYS.initUserPassword]: lf.initUserPassword,
    [LANGFUSE_SECRET_KEYS.s3AccessKey]: lf.s3AccessKey,
    [LANGFUSE_SECRET_KEYS.s3SecretKey]: lf.s3SecretKey,
    [LANGFUSE_SECRET_KEYS.oidcClientSecret]: cfg.observability.oidcClientSecret,
    [LANGFUSE_SECRET_KEYS.otlpBasicAuth]: pulumi
      .all([lf.publicKey, lf.secretKey])
      .apply(([pk, sk]) => `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`),
  };

  const secret = new k8s.core.v1.Secret(
    SECRETS_NAME,
    {
      metadata: { name: SECRETS_NAME, namespace, labels: commonLabels(LANGFUSE.web) },
      stringData: secretValues,
    },
    { provider, dependsOn },
  );

  const fromSecret = (key: string): k8s.types.input.core.v1.EnvVarSource => ({
    secretKeyRef: { name: SECRETS_NAME, key },
  });

  /**
   * Env shared by both containers. Langfuse requires the SAME database,
   * ClickHouse, Redis and S3 configuration on web and worker — they are two
   * halves of one application, not a client and a server — so this is built
   * once rather than kept in sync by hand.
   */
  const sharedEnv: k8s.types.input.core.v1.EnvVar[] = [
    { name: "DATABASE_URL", valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.databaseUrl) },
    { name: "SALT", valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.salt) },
    { name: "ENCRYPTION_KEY", valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.encryptionKey) },
    { name: "REDIS_CONNECTION_STRING", valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.redisUrl) },

    { name: "CLICKHOUSE_URL", value: inputs.clickhouseHttpUrl },
    { name: "CLICKHOUSE_MIGRATION_URL", value: inputs.clickhouseMigrationUrl },
    { name: "CLICKHOUSE_DB", value: LANGFUSE.clickhouseDatabase },
    { name: "CLICKHOUSE_USER", value: LANGFUSE.clickhouseUser },
    {
      name: "CLICKHOUSE_PASSWORD",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.clickhousePassword),
    },
    // Single node (data/clickhouse.ts): this makes the migrator emit plain
    // `MergeTree` DDL instead of the `Replicated*` engines, which is a SCHEMA
    // decision, not a performance one. Flipping it on an existing deployment
    // does not convert anything.
    { name: "CLICKHOUSE_CLUSTER_ENABLED", value: "false" },

    // S3 event upload — REQUIRED, not an optimisation. This is where the raw
    // ingestion event lands before the queue reference is pushed, so it is the
    // reason a queue drop is recoverable at all.
    { name: "LANGFUSE_S3_EVENT_UPLOAD_BUCKET", value: LANGFUSE.bucket },
    { name: "LANGFUSE_S3_EVENT_UPLOAD_PREFIX", value: LANGFUSE.eventPrefix },
    { name: "LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT", value: inputs.s3Endpoint },
    { name: "LANGFUSE_S3_EVENT_UPLOAD_REGION", value: "us-east-1" },
    {
      name: "LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.s3AccessKey),
    },
    {
      name: "LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.s3SecretKey),
    },
    // SeaweedFS serves buckets as PATHS (`/bucket/key`), never as virtual-host
    // subdomains. Without this the SDK addresses `http://langfuse.seaweedfs:8333`,
    // which does not resolve — surfacing as a DNS error inside the S3 client
    // rather than anything that names the bucket.
    { name: "LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE", value: "true" },

    // Batch export (CSV/JSON download of filtered traces) — same bucket, its
    // own prefix. Core OSS, not an Enterprise feature.
    { name: "LANGFUSE_S3_BATCH_EXPORT_ENABLED", value: "true" },
    { name: "LANGFUSE_S3_BATCH_EXPORT_BUCKET", value: LANGFUSE.bucket },
    { name: "LANGFUSE_S3_BATCH_EXPORT_PREFIX", value: LANGFUSE.batchExportPrefix },
    { name: "LANGFUSE_S3_BATCH_EXPORT_ENDPOINT", value: inputs.s3Endpoint },
    { name: "LANGFUSE_S3_BATCH_EXPORT_REGION", value: "us-east-1" },
    {
      name: "LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.s3AccessKey),
    },
    {
      name: "LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.s3SecretKey),
    },
    { name: "LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE", value: "true" },

    // NOT configured, deliberately: LANGFUSE_S3_MEDIA_UPLOAD_*. Media capture
    // is opt-in by presence of that bucket, and nothing in this deployment
    // produces it — OTLP spans from the collector carry text attributes only.
    // Wiring it would add a browser-facing presign path (and therefore the
    // public S3 endpoint) to buy a feature with no producer.

    { name: "TELEMETRY_ENABLED", value: "false" },
    { name: "LANGFUSE_LOG_LEVEL", value: "info" },
  ];

  /** Headless initialization (`LANGFUSE_INIT_*`) — see the config doc comment. */
  const initEnv: k8s.types.input.core.v1.EnvVar[] = [
    { name: "LANGFUSE_INIT_ORG_ID", value: lf.orgId },
    { name: "LANGFUSE_INIT_ORG_NAME", value: "Grid" },
    { name: "LANGFUSE_INIT_PROJECT_ID", value: lf.projectId },
    { name: "LANGFUSE_INIT_PROJECT_NAME", value: "Grid OIB" },
    {
      name: "LANGFUSE_INIT_PROJECT_PUBLIC_KEY",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.publicKey),
    },
    {
      name: "LANGFUSE_INIT_PROJECT_SECRET_KEY",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.secretKey),
    },
    { name: "LANGFUSE_INIT_USER_EMAIL", value: lf.initUserEmail },
    { name: "LANGFUSE_INIT_USER_NAME", value: "Grid Platform" },
    {
      name: "LANGFUSE_INIT_USER_PASSWORD",
      valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.initUserPassword),
    },
  ];

  const hardened: k8s.types.input.core.v1.SecurityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    capabilities: { drop: ["ALL"] },
  };
  const podSecurity: k8s.types.input.core.v1.PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
  };

  // ── web ────────────────────────────────────────────────────────────────────
  const webLabels = commonLabels(LANGFUSE.web);
  const web = new k8s.apps.v1.Deployment(
    LANGFUSE.web,
    {
      metadata: { name: LANGFUSE.web, namespace, labels: webLabels },
      spec: {
        // Single replica. Not a scaling statement — a migration one: this
        // container runs the Postgres and ClickHouse migrations at startup
        // (see `LANGFUSE_AUTO_*_MIGRATION_DISABLED` on the worker), and two
        // replicas starting together would run them concurrently. Langfuse
        // takes an advisory lock, so the second would wait rather than
        // corrupt — but a rollout that blocks on a lock is a worse first
        // failure than one that cannot happen.
        replicas: 1,
        ...surgeRollout(ROLLOUT.observability),
        selector: { matchLabels: webLabels },
        template: {
          metadata: {
            labels: webLabels,
            // Rotating any credential must roll the pods that read it once at
            // startup, or the Secret changes and nothing picks it up
            // (rollout.ts §5).
            annotations: secretChecksumAnnotations(secretChecksum(secretValues)),
          },
          spec: {
            enableServiceLinks: false,
            automountServiceAccountToken: false,
            securityContext: podSecurity,
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
            containers: [
              {
                name: "langfuse-web",
                image: lf.webImage,
                imagePullPolicy: pullPolicyFor(lf.webImage),
                securityContext: hardened,
                ports: [{ containerPort: PORT.langfuseWeb, name: "http" }],
                env: [
                  ...sharedEnv,
                  ...initEnv,
                  { name: "PORT", value: String(PORT.langfuseWeb) },
                  { name: "HOSTNAME", value: "0.0.0.0" },
                  { name: "NEXTAUTH_URL", value: publicUrl },
                  {
                    name: "NEXTAUTH_SECRET",
                    valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.nextAuthSecret),
                  },
                  // SSO against the platform Connect application. Free in OSS
                  // Langfuse; only SSO *enforcement* is an Enterprise feature,
                  // which is why password sign-in stays available as the
                  // break-glass path for the headless-init account.
                  { name: "AUTH_CUSTOM_NAME", value: "WorkOS" },
                  { name: "AUTH_CUSTOM_ISSUER", value: cfg.observability.oidcIssuer },
                  { name: "AUTH_CUSTOM_CLIENT_ID", value: cfg.observability.oidcClientId },
                  {
                    name: "AUTH_CUSTOM_CLIENT_SECRET",
                    valueFrom: fromSecret(LANGFUSE_SECRET_KEYS.oidcClientSecret),
                  },
                  { name: "AUTH_CUSTOM_SCOPE", value: "openid profile email" },
                  // Same human arriving by SSO after the init account was
                  // created by email must land on THAT account, not a second
                  // one that owns nothing. Safe here because the edge already
                  // proved the identity: an unverified-email provider is what
                  // makes account linking dangerous, and WorkOS is not one.
                  { name: "AUTH_CUSTOM_ALLOW_ACCOUNT_LINKING", value: "true" },
                  // TLS terminates at the Gateway; without this NextAuth builds
                  // its callback as http:// and the SSO hop fails.
                  { name: "AUTH_TRUST_HOST", value: "true" },
                ],
                resources: LANGFUSE.webResources,
                // Migrations run before the server listens, and a cold
                // ClickHouse makes that slow. A generous startup budget keeps
                // the kubelet from killing a pod that is mid-migration — which
                // on a first deploy would restart the migration from the top.
                startupProbe: {
                  httpGet: { path: "/api/public/health", port: PORT.langfuseWeb },
                  periodSeconds: 10,
                  failureThreshold: 60,
                },
                readinessProbe: {
                  httpGet: { path: "/api/public/health", port: PORT.langfuseWeb },
                  periodSeconds: 15,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/api/public/health", port: PORT.langfuseWeb },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, secret] },
  );

  const webService = new k8s.core.v1.Service(
    LANGFUSE.web,
    {
      metadata: { name: LANGFUSE.web, namespace, labels: webLabels },
      spec: {
        selector: webLabels,
        ports: [{ port: PORT.langfuseWeb, targetPort: PORT.langfuseWeb, name: "http" }],
      },
    },
    { provider, dependsOn: web },
  );

  // ── worker ─────────────────────────────────────────────────────────────────
  const workerLabels = commonLabels(LANGFUSE.worker);
  const worker = new k8s.apps.v1.Deployment(
    LANGFUSE.worker,
    {
      metadata: { name: LANGFUSE.worker, namespace, labels: workerLabels },
      spec: {
        replicas: 1,
        // Recreate, not surge. Two workers draining one queue is safe
        // (Langfuse's queue is designed for it), but during a roll the OLD
        // worker is mid-batch against a schema the NEW web tier may have just
        // migrated. A gap costs queue depth, which is bounded and visible;
        // an overlap costs failed inserts, which are neither.
        ...recreateRollout(ROLLOUT.observability),
        selector: { matchLabels: workerLabels },
        template: {
          metadata: {
            labels: workerLabels,
            annotations: secretChecksumAnnotations(secretChecksum(secretValues)),
          },
          spec: {
            enableServiceLinks: false,
            automountServiceAccountToken: false,
            securityContext: podSecurity,
            terminationGracePeriodSeconds:
              gracefulShutdown(ROLLOUT.observability).terminationGracePeriodSeconds,
            containers: [
              {
                name: "langfuse-worker",
                image: lf.workerImage,
                imagePullPolicy: pullPolicyFor(lf.workerImage),
                securityContext: hardened,
                ports: [{ containerPort: PORT.langfuseWorker, name: "http" }],
                env: [
                  ...sharedEnv,
                  { name: "PORT", value: String(PORT.langfuseWorker) },
                  { name: "HOSTNAME", value: "0.0.0.0" },
                  // Migrations belong to ONE container. Both images ship them
                  // and both run them by default, so leaving this unset means
                  // web and worker race at every deploy — they contend on an
                  // advisory lock rather than corrupting anything, but the
                  // loser sits blocked for the length of the migration and can
                  // exhaust its startup probe. The web tier owns them because
                  // it is the one that must not serve a stale schema.
                  { name: "LANGFUSE_AUTO_POSTGRES_MIGRATION_DISABLED", value: "true" },
                  { name: "LANGFUSE_AUTO_CLICKHOUSE_MIGRATION_DISABLED", value: "true" },
                ],
                resources: LANGFUSE.workerResources,
                startupProbe: {
                  httpGet: { path: "/api/health", port: PORT.langfuseWorker },
                  periodSeconds: 10,
                  failureThreshold: 30,
                },
                readinessProbe: {
                  httpGet: { path: "/api/health", port: PORT.langfuseWorker },
                  periodSeconds: 15,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  httpGet: { path: "/api/health", port: PORT.langfuseWorker },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
              },
            ],
          },
        },
      },
    },
    // The worker is gated on the WEB deployment, which is what runs the
    // migrations: started first it would query tables that do not exist yet and
    // crash-loop until the web tier caught up.
    { provider, dependsOn: [...dependsOn, secret, web] },
  );

  // ── edge ───────────────────────────────────────────────────────────────────
  const routeSpec: IHTTPRouteSpec = {
    parentRefs: [{ name: GATEWAY_NAME, sectionName: LANGFUSE.listenerName }],
    hostnames: [lf.domain],
    rules: [
      {
        backendRefs: [{ name: LANGFUSE.web, port: PORT.langfuseWeb }],
        // Langfuse's trace views and CSV exports run analytical ClickHouse
        // queries over an unbounded date range, which Envoy's 15s default cuts
        // off as a 504 mid-render. Same budget the app routes already use.
        timeouts: { request: EDGE_TIMEOUT, backendRequest: EDGE_TIMEOUT },
      },
    ],
  };
  const route = new k8s.apiextensions.CustomResource(
    "grid-langfuse-route",
    {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name: LANGFUSE.routeName, namespace, labels: webLabels },
      spec: routeSpec,
    },
    { provider, dependsOn: webService },
  );

  const securityPolicy = new k8s.apiextensions.CustomResource(
    "grid-langfuse-security-policy",
    {
      apiVersion: "gateway.envoyproxy.io/v1alpha1",
      kind: "SecurityPolicy",
      metadata: { name: "grid-langfuse-auth", namespace, labels: webLabels },
      spec: platformOidcSecurityPolicySpec(cfg, {
        routeName: LANGFUSE.routeName,
        domain: lf.domain,
        secretName: SECRETS_NAME,
      }),
    },
    { provider, dependsOn: [route, secret] },
  );

  return {
    web,
    worker,
    webService,
    secret,
    route,
    securityPolicy,
    // Cluster-internal: the collector never traverses the edge, so it never
    // meets the SecurityPolicy. Its credential is the project API key.
    otlpTracesEndpoint: pulumi.output(langfuseOtlpTracesEndpoint()),
  };
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GridConfig, appPullPolicy, backendImage, pullPolicyFor } from "../config";
import { CHROMA_MIGRATION, UID } from "../constants";
import { commonLabels } from "../platform/namespaces";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { AppSecrets, AppWiring, backendEnv } from "./config";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/** The exporter in the repository (`deploy/migration/`), carried into the pod by ConfigMap. */
export const EXPORTER_SOURCE = resolve(__dirname, "../../../migration/chroma_export.py");

/** Mount points inside the pod. */
const MOUNT = {
  /** The scratch volume both steps share. */
  exchange: "/exchange",
  /** The exporter script from the ConfigMap. */
  migration: "/migration",
} as const;

/** Paths on the scratch volume. */
const SCRATCH = {
  /** What the exporter writes and the importer reads (`--out` / `--in`). */
  export: `${MOUNT.exchange}/export`,
  /** uv's cache: the environment holding the `chromadb` the script pins. */
  uvCache: `${MOUNT.exchange}/uv-cache`,
  /** HOME and TMPDIR of the exporter: the root filesystem is read-only. */
  home: `${MOUNT.exchange}/home`,
  tmp: `${MOUNT.exchange}/tmp`,
} as const;

/** The exporter's environment: everything it writes on the scratch volume, nothing on the root. */
function exporterEnv(): EnvVar[] {
  return [
    { name: "UV_CACHE_DIR", value: SCRATCH.uvCache },
    // The image's Python 3.12, never one uv would download.
    { name: "UV_PYTHON_DOWNLOADS", value: "never" },
    { name: "PYTHONUNBUFFERED", value: "1" },
    { name: "HOME", value: SCRATCH.home },
    { name: "TMPDIR", value: SCRATCH.tmp },
    // chromadb reports usage to PostHog unless told not to.
    { name: "ANONYMIZED_TELEMETRY", value: "False" },
  ];
}

/** The exporter source, or a plan-time error naming the file the Job needs. */
function exporterScript(): string {
  try {
    return readFileSync(EXPORTER_SOURCE, "utf8");
  } catch (error) {
    throw new Error(
      `grid-oib:chromaMigration needs the exporter at ${EXPORTER_SOURCE}, which cannot be read ` +
        `(${(error as Error).message}). Deploy from a checkout that has deploy/migration/.`,
    );
  }
}

/**
 * Moves the retired Chroma store into Qdrant, once (ADR-0113). Opt-in
 * (`chromaMigration`), on the deploy that removes Chroma; the order of
 * operations is the Qdrant runbook's "Migrating from Chroma on Kubernetes".
 *
 * One pod, two steps over a scratch volume they share:
 *
 * 1. `export` (init container) runs `deploy/migration/chroma_export.py` with
 *    `uv run --script`, which installs the `chromadb` the script pins (the
 *    release the Chroma server ran) in a pinned uv/Python image; the server
 *    image has no Python (see `CHROMA_MIGRATION.exporterImage`). It reads the
 *    Chroma server the previous release still runs, over HTTP
 *    (`CHROMA_MIGRATION.sourceUrl`): Pulumi deletes the resources this program
 *    dropped (the `chroma` StatefulSet and its Services) after every create
 *    and update of the deploy, and only when the deploy succeeded. Reading
 *    through the server, the Job never mounts the Chroma volume and cannot
 *    change it.
 * 2. `import`, in the backend image with the backend's Qdrant URL and key,
 *    runs `scripts/import_vectors.py --verify`: 0 is in step, 1 is drift, 2 is
 *    Qdrant unreachable, the export invalid, or an import that already
 *    verified into this Qdrant (refused, nothing written).
 *
 * Awaited, and before the backend tiers. Pulumi waits for the Job to complete
 * (up to `chromaMigration.timeoutMinutes`), and `index.ts` makes every backend
 * tier wait for the Job, so the deploy runs: Qdrant ready → export from the
 * running Chroma, import, verify → backend tiers roll onto Qdrant → Chroma
 * deleted. Until then the old backends serve retrieval from Chroma, and
 * nothing of the new release writes Qdrant while the import runs, so
 * `--verify` compares the export with exactly what the import wrote. A failed
 * or timed-out Job fails the deploy before any backend tier rolls and before
 * Chroma is deleted.
 *
 * The scratch volume is a generic ephemeral claim on the stack's StorageClass,
 * not an emptyDir: an export of a large store would otherwise fill the node's
 * own disk and evict its neighbours. Nothing retries (`restartPolicy: Never`,
 * `backoffLimit: 0`): a failed step leaves the pod, its log and the claim with
 * the export in place for the operator (`CHROMA_MIGRATION.backoffLimit`).
 */
export function migrateChromaToQdrant(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  const labels = commonLabels(CHROMA_MIGRATION.name);
  const { scratchSize, timeoutMinutes } = cfg.chromaMigration;

  const script = new k8s.core.v1.ConfigMap(
    CHROMA_MIGRATION.exporterConfigMap,
    {
      metadata: { name: CHROMA_MIGRATION.exporterConfigMap, namespace: w.namespace, labels },
      data: { "chroma_export.py": exporterScript() },
    },
    { provider: w.provider },
  );

  const exchangeMount = { name: "exchange", mountPath: MOUNT.exchange };
  const readOnlyRoot = { ...hardenedContainerSecurityContext(), readOnlyRootFilesystem: true };
  const image = CHROMA_MIGRATION.exporterImage;
  const timeout = `${timeoutMinutes}m`;

  return new k8s.batch.v1.Job(
    CHROMA_MIGRATION.name,
    {
      metadata: { name: CHROMA_MIGRATION.name, namespace: w.namespace, labels },
      spec: {
        backoffLimit: CHROMA_MIGRATION.backoffLimit,
        // No ttlSecondsAfterFinished: CHROMA_MIGRATION.backoffLimit says why.
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "Never",
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID.backend,
              runAsGroup: UID.backend,
              // Owns the fresh scratch volume.
              fsGroup: UID.backend,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            ...onNodeGroup(cfg.nodeGroups.batch),
            volumes: [
              {
                name: "exchange",
                ephemeral: {
                  volumeClaimTemplate: {
                    metadata: { labels },
                    spec: {
                      accessModes: ["ReadWriteOnce"],
                      storageClassName: cfg.storage.className,
                      resources: { requests: { storage: scratchSize } },
                    },
                  },
                },
              },
              { name: "migration", configMap: { name: CHROMA_MIGRATION.exporterConfigMap } },
            ],
            initContainers: [
              {
                name: "export",
                image,
                imagePullPolicy: pullPolicyFor(image),
                securityContext: readOnlyRoot,
                command: [
                  "sh",
                  "-c",
                  [
                    "set -eu",
                    `mkdir -p ${SCRATCH.home} ${SCRATCH.tmp}`,
                    `exec uv run --script ${MOUNT.migration}/chroma_export.py ` +
                      `--url ${CHROMA_MIGRATION.sourceUrl} --out ${SCRATCH.export}`,
                  ].join("\n"),
                ],
                env: exporterEnv(),
                volumeMounts: [exchangeMount, { name: "migration", mountPath: MOUNT.migration, readOnly: true }],
                resources: CHROMA_MIGRATION.exporterResources,
              },
            ],
            containers: [
              {
                name: "import",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                command: ["python", "scripts/import_vectors.py", "--in", SCRATCH.export, "--verify"],
                env: backendEnv(w, "grid-chroma-migration"),
                volumeMounts: [exchangeMount],
                resources: CHROMA_MIGRATION.importerResources,
              },
            ],
          },
        },
      },
    },
    {
      provider: w.provider,
      dependsOn: [secrets.secret, script, ...dependsOn],
      // The deploy waits for the Job, then rolls the backend tiers. Bounded
      // well inside the pipeline's hour: a runner killed mid-`up` leaves the
      // stack with pending operations, a timeout here only fails the deploy.
      customTimeouts: { create: timeout, update: timeout },
      // Once, not once per deploy. A Job's spec is immutable, so the next
      // backend image would otherwise replace it and run the import again
      // over a store that has moved on, bringing back the chunks of every
      // document deleted or re-indexed since. The importer refuses a second
      // import too, by the mark a verified one leaves in the collections.
      ignoreChanges: ["spec"],
      // A fixed name: should it ever be replaced, the old Job goes first.
      deleteBeforeReplace: true,
    },
  );
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, backendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, UID } from "../constants";
import { AppSecrets, AppWiring, backendEnv } from "./config";

/** Where the old data volume is mounted; the importer reads `oib/`, `oib_uploads/` and `oib_excluded.json` under it. */
const LEGACY_ROOT = "/legacy";

/**
 * Carries the pre-A2 base corpus off the old backend data volume into the
 * corpus store, once, on the deploy that removes the volume (ADR-0082 A2).
 *
 * The StatefulSet keeps its claims on delete (`whenDeleted: Retain`), so the
 * old `data-aiq-agent-0` survives the replacement with every operator PDF and
 * admin upload on it. This Job mounts it read-only and runs
 * `aiq_agent.legacy_corpus_import`, which stores each PDF through the same
 * path an admin upload takes; the base-corpus housekeeping cycle then queues
 * their ingestion. Nobody re-uploads anything by hand.
 *
 * It waits for the new StatefulSet, because the claim is ReadWriteOnce and the
 * old pod must be gone first, and for the frontend, because the BFF signs the
 * uploads. A rerun stores nothing that is already there, so re-firing on an
 * image change is harmless. Deleting the old claim stays an operator step: it
 * is the one copy that cannot be regenerated.
 */
export function importLegacyCorpus(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  claimName: string,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    "legacy-corpus-import",
    {
      metadata: { namespace: w.namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels("legacy-corpus-import") },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            volumes: [{ name: "legacy", persistentVolumeClaim: { claimName, readOnly: true } }],
            containers: [
              {
                name: "legacy-corpus-import",
                image: backendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, backendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                command: ["python", "-m", "aiq_agent.legacy_corpus_import", LEGACY_ROOT],
                env: backendEnv(w),
                volumeMounts: [{ name: "legacy", mountPath: LEGACY_ROOT, readOnly: true }],
                resources: LIGHT_WORKER_RESOURCES,
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
  );
}

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, SECRET_NAME } from "./config";

/** The TriggerAuthentication both claim-queue tiers' ScaledObjects name. */
export const JOBS_QUEUE_AUTH = "jobs-queue-auth";

/** The Secret key holding the DSN KEDA reads the queues through (`secretEnv` in `./config.ts`). */
export const JOBS_QUEUE_DSN_KEY = "KEDA_JOBS_QUEUE_DB_URL";

/**
 * How KEDA reads the Python claim queues (ADR-0076, ADR-0078): `ingest_job_queue`
 * and `research_job_queue` live in one database (`aiq_jobs`), so the ingest tier
 * and the research tier share one credential and one TriggerAuthentication,
 * created once here rather than by whichever tier happens to be enabled.
 *
 * A libpq DSN whose host is the FQDN, because the operator resolves names in its
 * own namespace and a bare service name resolves there to nothing: the scaler
 * would error on every poll and the tier would never scale out.
 */
export function installJobsQueueAuth(
  w: AppWiring,
  dependsOn: pulumi.Resource[],
): k8s.apiextensions.CustomResource {
  return new k8s.apiextensions.CustomResource(
    JOBS_QUEUE_AUTH,
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "TriggerAuthentication",
      metadata: { name: JOBS_QUEUE_AUTH, namespace: w.namespace, labels: commonLabels("jobs-queue") },
      spec: { secretTargetRef: [{ parameter: "connection", name: SECRET_NAME, key: JOBS_QUEUE_DSN_KEY }] },
    },
    { provider: w.provider, dependsOn },
  );
}

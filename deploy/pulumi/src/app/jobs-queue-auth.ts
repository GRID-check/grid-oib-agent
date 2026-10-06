import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, JOBS_QUEUE_DSN_KEY, SCALER_SECRET_NAME } from "./config";
import { installTriggerAuth } from "./keda-scaling";

/** The TriggerAuthentication both claim-queue tiers' ScaledObjects name. */
export const JOBS_QUEUE_AUTH = "jobs-queue-auth";

/**
 * How KEDA reads the Python claim queues (ADR-0076, ADR-0078): `ingest_job_queue`
 * and `research_job_queue` live in one database (`aiq_jobs`), so the ingest tier
 * and the research tier share one credential and one TriggerAuthentication,
 * created once here rather than by whichever tier happens to be enabled.
 *
 * The DSN is the read-only scaler login's, in the scaler's own Secret
 * (`buildScalerSecret`).
 */
export function installJobsQueueAuth(
  w: AppWiring,
  dependsOn: pulumi.Resource[],
): k8s.apiextensions.CustomResource {
  return installTriggerAuth(w, {
    name: JOBS_QUEUE_AUTH,
    parameter: "connection",
    secretName: SCALER_SECRET_NAME,
    key: JOBS_QUEUE_DSN_KEY,
    labels: commonLabels("jobs-queue"),
    dependsOn,
  });
}

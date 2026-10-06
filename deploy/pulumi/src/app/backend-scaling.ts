import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, SECRET_NAME } from "./config";
import { PORT } from "../constants";

/** The route that reports the fleet's running chat turns (`aiq_api/routes/chat_occupancy.py`). */
export const OCCUPANCY_PATH = "/v1/internal/chat-occupancy";

/** The field of its JSON answer KEDA reads: `{"activeTurns": 7, "maxActiveTurns": 24}`. */
export const OCCUPANCY_FIELD = "activeTurns";

/** The header KEDA sends the shared internal token in (`aiq_api/routes/internal_auth.py`). */
export const OCCUPANCY_TOKEN_HEADER = "x-grid-internal-token";

/**
 * The URL KEDA polls. The operator runs in its own namespace, so the Service name
 * is fully qualified: a bare `aiq-agent` resolves there to nothing and the
 * scaler errors on every poll. Through the load-balanced Service, so any ready
 * replica answers (the count is Dragonfly's, not the replica's).
 */
export function occupancyUrl(namespace: pulumi.Input<string>): pulumi.Output<string> {
  return pulumi.interpolate`http://aiq-agent.${namespace}.svc.cluster.local:${PORT.backend}${OCCUPANCY_PATH}`;
}

/**
 * The scale-out of the chat tier: a KEDA ScaledObject on the aiq-agent
 * StatefulSet (ADR-0079).
 *
 * SCALED ON TURNS IN FLIGHT, beside CPU. A chat turn mostly waits on a model, so
 * CPU alone says little about how close the tier is to its admission cap
 * (`GRID_MAX_ACTIVE_TURNS`). The `metrics-api` trigger asks the backend how many
 * turns run fleet-wide and holds `turnsPerReplica` of them per replica; the cpu
 * trigger adds replicas for the work that is not a turn (retrieval, ingest
 * status, the REST routes). The HPA takes the larger answer of the two.
 *
 * SLOW IN, FAST OUT. A replica leaving drains for up to `drainSeconds`, and which
 * one leaves is the highest ordinal, not the idlest, so scale-in is a pod at a
 * time after a long stabilisation window. A turn on the leaving replica keeps
 * running and publishing until it ends; its readers move to another replica.
 *
 * `fallback` is deliberately absent: KEDA only honours it for AverageValue
 * triggers and refuses it beside a cpu trigger. A scaler that cannot be read
 * makes the HPA hold the current count rather than scale in.
 */
export function installBackendScaling(
  w: AppWiring,
  cfg: GridConfig,
  statefulSet: k8s.apps.v1.StatefulSet,
  dependsOn: pulumi.Resource[],
): { scaledObject: k8s.apiextensions.CustomResource; auth: k8s.apiextensions.CustomResource } {
  const labels = commonLabels("aiq-agent");

  // The route is internal-token only. The operator reads the token from the
  // same Secret the pods get it from, so a rotation reaches both.
  const auth = new k8s.apiextensions.CustomResource(
    "aiq-agent-occupancy-auth",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "TriggerAuthentication",
      metadata: { name: "aiq-agent-occupancy-auth", namespace: w.namespace, labels },
      spec: { secretTargetRef: [{ parameter: "apiKey", name: SECRET_NAME, key: "GRID_INTERNAL_API_TOKEN" }] },
    },
    { provider: w.provider, dependsOn },
  );

  const scaledObject = new k8s.apiextensions.CustomResource(
    "aiq-agent",
    {
      apiVersion: "keda.sh/v1alpha1",
      kind: "ScaledObject",
      metadata: { name: "aiq-agent", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "StatefulSet", name: statefulSet.metadata.name },
        minReplicaCount: cfg.backend.replicas,
        maxReplicaCount: cfg.backend.maxReplicas,
        pollingInterval: 15,
        advanced: {
          horizontalPodAutoscalerConfig: {
            behavior: {
              scaleUp: { stabilizationWindowSeconds: 0, policies: [{ type: "Pods", value: 1, periodSeconds: 60 }] },
              scaleDown: {
                stabilizationWindowSeconds: 900,
                policies: [{ type: "Pods", value: 1, periodSeconds: 300 }],
              },
            },
          },
        },
        triggers: [
          {
            type: "metrics-api",
            // AverageValue: the count divided by the replicas it is spread over.
            metricType: "AverageValue",
            metadata: {
              url: occupancyUrl(w.namespace),
              valueLocation: OCCUPANCY_FIELD,
              targetValue: String(cfg.backend.turnsPerReplica),
              authMode: "apiKey",
              method: "header",
              keyParamName: OCCUPANCY_TOKEN_HEADER,
            },
            authenticationRef: { name: auth.metadata.name },
          },
          {
            type: "cpu",
            metricType: "Utilization",
            metadata: { value: String(cfg.backend.cpuTargetPercent) },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: [statefulSet, auth, ...dependsOn] },
  );

  return { scaledObject, auth };
}

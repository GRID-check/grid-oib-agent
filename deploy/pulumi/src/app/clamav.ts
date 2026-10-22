import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GridConfig, pullPolicyFor } from "../config";
import { CLAMAV, PORT, UID } from "../constants";
import { commonLabels } from "../platform/namespaces";
import { ROLLOUT, assertStartupFitsRollout, gracefulShutdown, secretChecksum, secretChecksumAnnotations, surgeRollout } from "../platform/rollout";
import { onNodeGroup } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";

export interface ClamAV {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  /** The `GRID_MALWARE_SCAN_URL` the frontend and the bff-jobs pool get. */
  url: pulumi.Output<string>;
}

/**
 * The two config files, read from `deploy/compose/clamav/` so that Compose and
 * this program run the same clamd. Exported for the spec.
 */
export const CLAMAV_CONFIG_DIR = join(__dirname, "..", "..", "..", "compose", "clamav");
export function clamavConfigFiles(): { "clamd.conf": string; "freshclam.conf": string } {
  return {
    "clamd.conf": readFileSync(join(CLAMAV_CONFIG_DIR, "clamd.conf"), "utf8"),
    "freshclam.conf": readFileSync(join(CLAMAV_CONFIG_DIR, "freshclam.conf"), "utf8"),
  };
}

/**
 * The readiness check (busybox `sh`, `nc` and `date` ship in the image): clamd
 * answers `VERSION`, and the database it names is younger than
 * `CLAMAV.maxSignatureAgeHours`. A pod whose freshclam has stopped updating
 * leaves the Service and shows as not ready, the visible half of the rule the
 * BFF enforces per scan (`stale-signatures`). The date is ctime(3) in the
 * image's time zone, UTC.
 */
export function readinessScript(): string {
  const maxAgeSeconds = CLAMAV.maxSignatureAgeHours * 3600;
  return [
    `reply=$(printf 'zVERSION\\0' | nc -w 5 127.0.0.1 ${PORT.clamav} | tr -d '\\0')`,
    'built=$(date -u -D "%a %b %d %H:%M:%S %Y" -d "${reply##*/}" +%s) || exit 1',
    `[ $(( $(date -u +%s) - built )) -lt ${maxAgeSeconds} ]`,
  ].join("\n");
}

/** The liveness check: clamd answers `PING`. A stale database is not a reason to restart it. */
export function livenessScript(): string {
  return `[ "$(printf 'zPING\\0' | nc -w 5 127.0.0.1 ${PORT.clamav} | tr -d '\\0')" = "PONG" ]`;
}

/**
 * ClamAV: the malware scanner (ADR-0133). The BFF streams what strangers send
 * (attachments, and each raw message whole) through clamd's INSTREAM, and
 * serves or files nothing it did not answer `OK` for
 * (`frontends/ui/src/lib/malware-scan/`).
 *
 * One pod, three containers, the Gotenberg pattern otherwise:
 * - `seed` copies the signatures baked into the image onto an emptyDir, so a
 *   new pod serves at once instead of after a 300 MB download;
 * - `clamd` scans, on the database it shares with
 * - `freshclam`, which checks for new signatures twelve times a day and tells
 *   clamd to load them.
 *
 * All three run as the image's `clamav` user. The image's entrypoint starts as
 * root to chown and drop privileges; skipping it leaves nothing to drop.
 *
 * It holds no secret and no tenant data at rest: bytes arrive on a socket and
 * are gone with the reply. Being scanned is the point, so it parses the most
 * hostile input in the namespace, and `platform/network-policies.ts` admits
 * only the frontend and the bff-jobs pool. Egress stays open, as for every pod
 * but two: freshclam needs database.clamav.net, which no NetworkPolicy can name.
 *
 * Fail closed. One replica, surged on a rollout; while no pod is ready every
 * scan fails `unavailable` and is retried, and nothing waits on it at boot.
 */
export function installClamAV(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): ClamAV {
  const { name } = CLAMAV;
  const labels = commonLabels(name);
  const { image } = cfg.malwareScan;
  const files = clamavConfigFiles();
  // A scan cut by a rollout fails and is retried, so drain like Gotenberg: a
  // preStop `sleep` (busybox) while the Service stops routing here, then
  // SIGTERM, on which clamd finishes the scans it holds (`MaxScanTime` 120 s)
  // inside the converter profile's grace.
  const shutdown = gracefulShutdown(ROLLOUT.converter, "coreutils");

  // The first start loads about 1 GiB of signatures: up to five minutes.
  const startupBudgetSeconds = 10 * 30;
  assertStartupFitsRollout(name, ROLLOUT.converter, startupBudgetSeconds);

  const config = new k8s.core.v1.ConfigMap(
    `${name}-config`,
    { metadata: { name: `${name}-config`, namespace, labels }, data: files },
    { provider, dependsOn },
  );

  const asClamav = {
    ...hardenedContainerSecurityContext(),
    runAsNonRoot: true,
    runAsUser: UID.clamav,
    runAsGroup: UID.clamavGroup,
  };
  const mounts = [
    { name: "database", mountPath: CLAMAV.databasePath },
    { name: "config", mountPath: `${CLAMAV.configPath}/clamd.conf`, subPath: "clamd.conf", readOnly: true },
    { name: "config", mountPath: `${CLAMAV.configPath}/freshclam.conf`, subPath: "freshclam.conf", readOnly: true },
  ];

  const deployment = new k8s.apps.v1.Deployment(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.converter),
        template: {
          metadata: {
            labels,
            // clamd and freshclam read their files once, at start, and subPath
            // mounts never refresh: without the digest a config change would
            // deploy and take effect nowhere.
            annotations: secretChecksumAnnotations(secretChecksum(files)),
          },
          spec: {
            enableServiceLinks: false, // see platform/security.ts — service-link env collisions
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            securityContext: { runAsNonRoot: true, runAsUser: UID.clamav, runAsGroup: UID.clamavGroup, fsGroup: UID.clamavGroup },
            // Beside the bff-jobs pool, whose receive jobs are its main caller.
            ...onNodeGroup(cfg.nodeGroups.batch),
            initContainers: [
              {
                name: "seed",
                image,
                imagePullPolicy: pullPolicyFor(image),
                securityContext: asClamav,
                command: ["sh", "-c", `cp ${CLAMAV.databasePath}/* /seed/`],
                volumeMounts: [{ name: "database", mountPath: "/seed" }],
                resources: CLAMAV.seedResources,
              },
            ],
            containers: [
              {
                name: "clamd",
                image,
                imagePullPolicy: pullPolicyFor(image),
                securityContext: asClamav,
                lifecycle: shutdown.lifecycle,
                // `command`, not `args`: the entrypoint (`/init`) would start as
                // root and run freshclam in this container too.
                command: ["clamd", "--foreground", `--config-file=${CLAMAV.configPath}/clamd.conf`],
                ports: [{ containerPort: PORT.clamav, name: "clamd" }],
                volumeMounts: mounts,
                resources: CLAMAV.resources,
                startupProbe: {
                  exec: { command: ["sh", "-c", livenessScript()] },
                  periodSeconds: 10,
                  failureThreshold: startupBudgetSeconds / 10,
                },
                readinessProbe: {
                  exec: { command: ["sh", "-c", readinessScript()] },
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                },
                livenessProbe: {
                  exec: { command: ["sh", "-c", livenessScript()] },
                  periodSeconds: 30,
                  timeoutSeconds: 10,
                  failureThreshold: 4,
                },
              },
              {
                name: "freshclam",
                image,
                imagePullPolicy: pullPolicyFor(image),
                securityContext: asClamav,
                command: ["freshclam", "--daemon", "--foreground", "--stdout", `--config-file=${CLAMAV.configPath}/freshclam.conf`],
                volumeMounts: mounts,
                resources: CLAMAV.freshclamResources,
              },
            ],
            volumes: [
              { name: "database", emptyDir: { sizeLimit: "2Gi" } },
              { name: "config", configMap: { name: config.metadata.name } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...dependsOn, config] },
  );

  const service = new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.clamav, targetPort: PORT.clamav, name: "clamd" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  return { deployment, service, url: pulumi.output(`tcp://${name}:${PORT.clamav}`) };
}

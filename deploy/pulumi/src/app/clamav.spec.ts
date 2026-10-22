import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { load } from "js-yaml";
import { baseStackConfig } from "../test-support/stack-config";

/**
 * ClamAV, the malware scanner (ADR-0133).
 *
 * Every mistake worth catching here plans clean and runs green, while the
 * scanner quietly vouches for bytes it never inspected:
 *   - a clamd.conf without the alert settings answers `OK` for an encrypted
 *     archive, a macro document or a file over a limit (RT-S4);
 *   - a readiness probe on PING alone stays green on week-old signatures;
 *   - a scanner any pod may call, or one only the frontend may call while the
 *     bff-jobs pool scans what arrives;
 *   - Compose and Pulumi running different images or files (deploy/AGENTS.md);
 *   - the BFF and the probe disagreeing on how old is too old.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, any> }> = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
      };
    },
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) throw new Error(`no ${type} named "${name}"`);
  return hit;
}

function resolve<T>(value: pulumi.Input<T>): Promise<T> {
  return new Promise((done) => pulumi.output(value).apply((v) => done(v as T)));
}

const NETPOL = "kubernetes:networking.k8s.io/v1:NetworkPolicy";
const REPO = join(__dirname, "..", "..", "..", "..");

/** clamd.conf as `Directive value` pairs, comments dropped. */
function directives(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split(/\s+/);
    expect(map.has(key), `${key} set twice`).toBe(false);
    map.set(key, rest.join(" "));
  }
  return map;
}

type ComposeService = {
  image: string;
  profiles?: string[];
  ports?: unknown;
  volumes: string[];
  environment: string[];
  healthcheck: { test: string[] };
};
function composeService(name: string): ComposeService {
  const doc = load(readFileSync(join(REPO, "deploy", "compose", "docker-compose.yaml"), "utf8")) as {
    services: Record<string, ComposeService>;
  };
  return doc.services[name];
}

describe("clamav", () => {
  let cfgImage = "";
  let env: k8s.types.input.core.v1.EnvVar[] = [];
  let envDisabled: k8s.types.input.core.v1.EnvVar[] = [];
  let jobsEnv: k8s.types.input.core.v1.EnvVar[] = [];

  beforeAll(async () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:observabilityEnabled": "false",
      "grid-oib:malwareScanEnabled": "true",
    });
    const { loadConfig } = await import("../config");
    const { installClamAV } = await import("./clamav");
    const { installNetworkPolicies } = await import("../platform/network-policies");
    const { frontendEnv, bffJobsEnv } = await import("./config");
    const cfg = loadConfig();
    cfgImage = cfg.malwareScan.image;
    const provider = new k8s.Provider("test", { kubeconfig: "apiVersion: v1" });
    const clamav = installClamAV(cfg, provider, "grid", []);
    installNetworkPolicies(cfg, provider, "grid");
    const wiring = {
      cfg,
      namespace: "grid",
      provider,
      redisUrl: pulumi.output("redis://dragonfly:6379"),
      seaweedInternalEndpoint: pulumi.output("http://seaweedfs:8333"),
      seaweedPublicEndpoint: pulumi.output("https://s3.example.test"),
      qdrantUrl: pulumi.output("http://qdrant.grid.svc.cluster.local:6333"),
      dsn: () => pulumi.output("postgresql://x"),
      imagePullSecrets: [],
    };
    env = frontendEnv({ ...wiring, malwareScanUrl: clamav.url });
    jobsEnv = bffJobsEnv({ ...wiring, malwareScanUrl: clamav.url });
    envDisabled = frontendEnv(wiring);
    await new Promise((done) => clamav.service.id.apply(done));
  });

  it("closes, in clamd.conf, every way clamd answers OK for bytes it did not inspect (RT-S4)", async () => {
    const { clamavConfigFiles } = await import("./clamav");
    const conf = directives(clamavConfigFiles()["clamd.conf"]);
    for (const alert of [
      "HeuristicAlerts",
      "AlertExceedsMax",
      "AlertEncrypted",
      "AlertEncryptedArchive",
      "AlertEncryptedDoc",
      "AlertOLE2Macros",
      "AlertBrokenExecutables",
      "ScanMail",
      "ScanArchive",
    ]) {
      expect(conf.get(alert), alert).toBe("yes");
    }
    // A signature match is reported by name even inside an encrypted or oversized container.
    expect(conf.get("HeuristicScanPrecedence")).toBe("no");
    // The reply the BFF parses: `stream: <name> FOUND`, without a hash suffix.
    expect(conf.get("ExtendedDetectionInfo")).toBe("no");
    expect(conf.get("StreamMaxLength")).toBe("30M");
    expect(Number(conf.get("MaxScanTime"))).toBeGreaterThan(0);
    expect(conf.get("TCPSocket")).toBe("3310");
    expect(conf.get("DatabaseDirectory")).toBe("/var/lib/clamav");
  });

  it("holds the BFF to the limits clamd enforces, and to the same signature age as the probe", () => {
    const bff = readFileSync(join(REPO, "frontends", "ui", "src", "lib", "malware-scan", "config.ts"), "utf8");
    // `export const MAX_SIGNATURE_AGE_MS = 48 * 60 * 60 * 1000`
    const age = bff.match(/MAX_SIGNATURE_AGE_MS = (\d+) \* 60 \* 60 \* 1000/);
    expect(age?.[1]).toBe("48");
    const stream = bff.match(/STREAM_MAX_BYTES = (\d+) \* 1024 \* 1024/);
    expect(`${stream?.[1]}M`).toBe(directives(readFileSync(join(REPO, "deploy", "compose", "clamav", "clamd.conf"), "utf8")).get("StreamMaxLength"));
  });

  it("runs clamd and freshclam as the image's clamav user, past the root entrypoint", async () => {
    const spec = await resolve(find("kubernetes:apps/v1:Deployment", "clamav").inputs.spec);
    const pod = spec.template.spec;
    const [clamd, freshclam] = pod.containers;
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 100, runAsGroup: 101, fsGroup: 101 });
    expect(pod.automountServiceAccountToken).toBe(false);
    for (const c of [...pod.initContainers, clamd, freshclam]) {
      expect(c.image, c.name).toBe(cfgImage);
      // `command` replaces `/init`, which would start as root and run both daemons in one container.
      expect(c.command, c.name).toBeDefined();
      expect(c.securityContext, c.name).toMatchObject({ runAsUser: 100, allowPrivilegeEscalation: false });
    }
    expect(clamd.command).toEqual(["clamd", "--foreground", "--config-file=/etc/clamav/clamd.conf"]);
    expect(freshclam.command).toEqual(expect.arrayContaining(["freshclam", "--daemon", "--config-file=/etc/clamav/freshclam.conf"]));
    // Seeded from the image's baked signatures, so a new pod serves without a download.
    expect(pod.initContainers[0].command.join(" ")).toContain("cp /var/lib/clamav/* /seed/");
    expect(pod.volumes.find((v: { name: string }) => v.name === "database").emptyDir).toBeDefined();
    expect(clamd.resources.requests.memory).toBe("2Gi");
  });

  it("is ready only while clamd answers and its signatures are under 48 hours old", async () => {
    const { readinessScript, livenessScript } = await import("./clamav");
    const spec = await resolve(find("kubernetes:apps/v1:Deployment", "clamav").inputs.spec);
    const clamd = spec.template.spec.containers[0];
    expect(clamd.readinessProbe.exec.command).toEqual(["sh", "-c", readinessScript()]);
    expect(readinessScript()).toContain("zVERSION");
    expect(readinessScript()).toContain(`-lt ${48 * 3600}`);
    // A stale database is no reason to restart clamd: liveness is PING alone.
    expect(clamd.livenessProbe.exec.command).toEqual(["sh", "-c", livenessScript()]);
    expect(livenessScript()).toContain("zPING");
    expect(livenessScript()).not.toContain("VERSION");
    expect(clamd.startupProbe.exec.command).toEqual(["sh", "-c", livenessScript()]);
  });

  it("rolls the pod when either config file changes", async () => {
    const { clamavConfigFiles } = await import("./clamav");
    const cm = find("kubernetes:core/v1:ConfigMap", "clamav-config");
    expect(await resolve(cm.inputs.data)).toEqual(clamavConfigFiles());
    const spec = await resolve(find("kubernetes:apps/v1:Deployment", "clamav").inputs.spec);
    expect(Object.keys(spec.template.metadata.annotations)).toHaveLength(1);
  });

  it("hands the frontend and the bff-jobs pool the Service's address, and nothing when off", async () => {
    const svc = await resolve(find("kubernetes:core/v1:Service", "clamav").inputs.spec);
    expect(svc.ports[0].port).toBe(3310);
    for (const list of [env, jobsEnv]) {
      const url = list.find((e) => e.name === "GRID_MALWARE_SCAN_URL");
      expect(await resolve(url?.value)).toBe("tcp://clamav:3310");
    }
    // Absent, never `fake://`: the BFF then fails every scan closed.
    expect(envDisabled.some((e) => e.name === "GRID_MALWARE_SCAN_URL")).toBe(false);
  });

  it("admits the frontend and the bff-jobs pool alone", async () => {
    const pol = await resolve(find(NETPOL, "clamav-bff-only").inputs.spec);
    expect(pol.policyTypes).toEqual(["Ingress"]);
    expect(pol.ingress).toEqual([
      {
        from: [
          { podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } },
          { podSelector: { matchLabels: { "app.kubernetes.io/name": "bff-jobs" } } },
        ],
        ports: [{ protocol: "TCP", port: 3310 }],
      },
    ]);
    // Allows are additive: left in the intra-namespace allow, any pod could call it.
    const intra = await resolve(find(NETPOL, "allow-same-namespace").inputs.spec);
    expect(intra.podSelector.matchExpressions[0].values).toContain("clamav");
  });

  it("matches the Compose service: image, files, no port, and the same health check", async () => {
    const { readinessScript } = await import("./clamav");
    const svc = composeService("clamav");
    expect(svc.image).toBe(cfgImage);
    expect(svc.profiles).toEqual(["malware-scan"]);
    expect(svc.ports).toBeUndefined();
    expect(svc.volumes).toEqual(
      expect.arrayContaining([
        "./clamav/clamd.conf:/etc/clamav/clamd.conf:ro",
        "./clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro",
      ]),
    );
    // Compose escapes `$` as `$$`.
    expect(svc.healthcheck.test[0]).toBe("CMD-SHELL");
    expect(svc.healthcheck.test[1].split("$$").join("$")).toBe(readinessScript());
    // The entrypoint's default is one check a day; freshclam.conf says twelve.
    expect(svc.environment).toContain("FRESHCLAM_CHECKS=12");
    // Unset by default, never the fake: a plain `up` scans nothing and files nothing unscanned.
    expect(composeService("frontend").environment).toContain("GRID_MALWARE_SCAN_URL=${GRID_MALWARE_SCAN_URL:-}");
  });

  it("checks for signatures as often as freshclam.conf says, and notifies clamd", async () => {
    const { clamavConfigFiles } = await import("./clamav");
    const fresh = directives(clamavConfigFiles()["freshclam.conf"]);
    expect(fresh.get("Checks")).toBe("12");
    expect(fresh.get("NotifyClamd")).toBe("/etc/clamav/clamd.conf");
    expect(fresh.get("DatabaseDirectory")).toBe("/var/lib/clamav");
  });
});

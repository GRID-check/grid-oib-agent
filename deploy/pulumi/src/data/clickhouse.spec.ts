import { describe, it, expect, beforeAll } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "../config";
import { baseStackConfig, langfuseStackConfig } from "../test-support/stack-config";
import { installClickHouse } from "./clickhouse";

/**
 * ClickHouse self-cleaning: the server's own system logs are TTL-bounded.
 *
 * In August 2026 system.trace_log alone grew to 17 GiB on dev and filled the
 * PVC. From then on every insert failed with "Cannot reserve ... not enough
 * space", the Langfuse worker dropped every batch it flushed, and the UI sat
 * on "Waiting for first trace" - with all pods Ready. The bar for a test here
 * is that same shape: a healthy-looking deployment that ingests nothing.
 *
 * Would-be mistakes this pins:
 *
 *   - A TTL list that names a log table the pinned image does not create, or
 *     misses one it does: the first fails the server at startup, the second
 *     re-opens the unbounded growth that took the tier down.
 *   - A TTL over a column the table does not carry: opentelemetry_span_log
 *     has no event_date (only finish_date), and that mistake also fails the
 *     server at startup.
 *   - Mounting the ConfigMap over all of config.d: the image ships
 *     docker_related_config.xml there (listen_host ::/0.0.0.0), and shadowing
 *     it leaves ClickHouse on localhost only - Langfuse cannot connect, and
 *     no error names the mount.
 *   - A TTL change that never reaches the pod: subPath mounts do not refresh
 *     in running pods, so without the content checksum the new TTL would
 *     deploy successfully and apply nowhere.
 */

const RESOURCES: Array<{ type: string; name: string; inputs: Record<string, unknown> }> = [];

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

/** Resolve a possibly-Output resource input to a plain value. */
function resolve(value: unknown): Promise<any> {
  return new Promise((done) =>
    (pulumi.output(value) as pulumi.Output<any>).apply((v: any) => {
      done(v);
      return v;
    }),
  );
}

function find(type: string, name: string) {
  const hit = RESOURCES.find((r) => r.type === type && r.name === name);
  if (!hit) {
    throw new Error(
      `no ${type} named "${name}". Built: ${RESOURCES.filter((r) => r.type === type).map((r) => r.name).join(", ") || "(none)"}`,
    );
  }
  return hit;
}

/**
 * Every MergeTree-backed system log table the pinned 25.8 image creates,
 * verified live by SHOW TABLES FROM system LIKE '%log'. Exact, not
 * aspirational: a name here that the image does not configure fails the
 * server at startup, and a missing one re-opens unbounded growth.
 */
const SYSTEM_LOG_TABLES = [
  "asynchronous_insert_log",
  "asynchronous_metric_log",
  "error_log",
  "metric_log",
  "opentelemetry_span_log",
  "part_log",
  "processors_profile_log",
  "query_log",
  "query_metric_log",
  "text_log",
  "trace_log",
];

describe("ClickHouse system-log TTLs", () => {
  let ttlXml: string;
  let stsSpec: any;

  beforeAll(async () => {
    RESOURCES.length = 0;
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...langfuseStackConfig() });
    // Calls installClickHouse directly rather than importing the whole
    // program the way the tier specs do: every full-stack evaluation is
    // another parallel worker racing the fixed 200ms settle below, and this
    // unit needs only its own inputs. Keeps this file near-free in the suite.
    const provider = new k8s.Provider("test-provider", { kubeconfig: "apiVersion: v1" });
    installClickHouse(loadConfig(), provider, "grid", []);
    // Pulumi resolves resource inputs asynchronously; give the mock registry a
    // turn of the loop to receive them all.
    await new Promise((r) => setTimeout(r, 200));

    const cm = find("kubernetes:core/v1:ConfigMap", "clickhouse-config");
    ttlXml = ((await resolve(cm.inputs.data)) as Record<string, string>)["system-log-ttl.xml"];
    stsSpec = await resolve(find("kubernetes:apps/v1:StatefulSet", "clickhouse").inputs.spec);
  });

  it("bounds every system log table at fourteen days", () => {
    expect(ttlXml).toBeDefined();
    for (const table of SYSTEM_LOG_TABLES) {
      expect(ttlXml, `no TTL for ${table}`).toMatch(
        // Double backslashes: this is a template literal, so `\\s` is what
        // arrives at RegExp as `\s`. A single `\s` here would collapse to `s`.
        new RegExp(`<${table}>[\\s\\S]*?INTERVAL 14 DAY`),
      );
    }
  });

  it("gives opentelemetry_span_log the date column it actually carries", () => {
    // The only log table without event_date (verified live against the pinned
    // image - it carries finish_date instead). A TTL over a missing column
    // fails the server at startup, which is a total tier outage.
    const match = ttlXml.match(/<opentelemetry_span_log>[\s\S]*?<\/opentelemetry_span_log>/);
    expect(match, "opentelemetry_span_log section missing").not.toBeNull();
    const section = match?.[0] ?? "";
    expect(section).toContain("finish_date + INTERVAL 14 DAY");
    expect(section).not.toContain("event_date");
  });

  it("mounts the drop-in by subPath so docker_related_config.xml survives", () => {
    const mounts = stsSpec.template.spec.containers[0].volumeMounts as Array<{
      name: string;
      mountPath: string;
      subPath?: string;
    }>;
    const ttlMount = mounts.find((m) => m.mountPath.endsWith("system-log-ttl.xml"));
    expect(ttlMount?.subPath).toBe("system-log-ttl.xml");
    // A mount over the whole directory would shadow the image's
    // docker_related_config.xml (listen_host ::/0.0.0.0) and leave ClickHouse
    // listening on localhost only.
    expect(mounts.some((m) => m.mountPath === "/etc/clickhouse-server/config.d")).toBe(false);
    const volumes = stsSpec.template.spec.volumes as Array<{
      name: string;
      configMap: { name: string };
    }>;
    expect(volumes.find((v) => v.name === "syslog-ttl")?.configMap.name).toBe("clickhouse-config");
  });

  it("rolls the pod when the TTL file changes", async () => {
    // subPath mounts never refresh in a running pod, so the content hash in
    // the pod annotation is what turns a TTL edit into a rolling update.
    const annotations = stsSpec.template.metadata.annotations as Record<string, unknown>;
    const checksum = await resolve(annotations["grid.bigls.net/secret-checksum"]);
    expect(checksum).toMatch(/^[0-9a-f]{16}$/);
  });

  it("provisions fifty gibibytes for both stacks by default", () => {
    const claims = stsSpec.volumeClaimTemplates as Array<any>;
    expect(claims[0].spec.resources.requests.storage).toBe("50Gi");
  });
});

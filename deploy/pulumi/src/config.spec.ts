import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "./config";

// `new pulumi.Config()` (config.ts:873) namespaces every key by the PROJECT
// name, which the runtime reads from the mock context. Without this the keys
// resolve as `project:*` and every `require` misses.
pulumi.runtime.setMocks(
  { newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }), call: () => ({}) },
  "grid-oib",
  "test",
  false,
);

/**
 * Config validation, for the checks whose whole job is to refuse a value that
 * would otherwise deploy cleanly and be wrong.
 *
 * The bar for a test here is: would the misconfiguration produce a running,
 * healthy-looking cluster? Everything below meets it. A prefix that overlaps a
 * platform bucket does not error at deploy time — it silently widens a
 * wildcard grant. An even master count does not error at deploy time — it
 * produces a Raft cluster that tolerates zero failures. A replication factor
 * with nowhere to place its copies does not error at deploy time — it fails
 * the first volume-grow after the first volume fills, which surfaces weeks
 * later as uploads breaking for no visible reason.
 */

/**
 * Drive `loadConfig` with an explicit config map.
 *
 * `pulumi.runtime.setAllConfig` rather than stubbing `PULUMI_CONFIG`: the
 * runtime parses that env var once and memoizes it, so a second test would
 * silently read the first one's values — which is exactly the kind of
 * cross-contamination that makes a validation suite report green while
 * validating nothing.
 */
function loadWith(values: Record<string, string>, omit: string[] = []): Error | null {
  const config: Record<string, string> = {
    // Every `requireSecret` key, so a test about one knob is not defeated by a
    // different missing one.
    "grid-oib:kubeconfig": "apiVersion: v1",
    "grid-oib:baseDomain": "example.test",
    "grid-oib:storageClass": "premium",
    "grid-oib:letsEncryptEmail": "ops@example.test",
    "grid-oib:seaweedfsSecretKey": "s3-secret", // pragma: allowlist secret
    "grid-oib:seaweedfsBackendReadSecretKey": "read-secret", // pragma: allowlist secret
    "grid-oib:pgAppPassword": "pg-secret", // pragma: allowlist secret
    "grid-oib:pgRuntimePassword": "rw-secret", // pragma: allowlist secret
    "grid-oib:workosApiKey": "workos", // pragma: allowlist secret
    "grid-oib:workosClientId": "client",
    "grid-oib:workosCookiePassword": "cookie-cookie-cookie-cookie-cookie-x", // pragma: allowlist secret
    "grid-oib:gridInternalApiToken": "internal", // pragma: allowlist secret
    "grid-oib:gridAdminToken": "admin", // pragma: allowlist secret
    "grid-oib:tavilyApiKey": "tavily", // pragma: allowlist secret
    "grid-oib:openrouterApiKey": "or", // pragma: allowlist secret
    "grid-oib:dragonflyPassword": "df", // pragma: allowlist secret
    "grid-oib:rateLimitStorePassword": "rl", // pragma: allowlist secret
    "grid-oib:seaweedfsFilerDbPassword": "filer", // pragma: allowlist secret
    "grid-oib:seaweedfsTenantAdminSecretKey": "tenant", // pragma: allowlist secret
    ...values,
  };
  for (const key of omit) delete config[key];
  pulumi.runtime.setAllConfig(config);
  try {
    loadConfig();
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("tenant bucket prefix", () => {

  // The check that matters most, and the one that is easy to gate wrongly. The
  // grants are `<Action>:<prefix>*`, matched by STRING PREFIX and issued
  // whether or not per-organization buckets are enabled — so `grid-` would hand
  // `grid-documents` and `grid-pg-backups` to every identity holding a tenant
  // scope, including the read-only agent credential. That is precisely the bug
  // ADR-0043 exists to fix.
  it.each([["true"], ["false"]])(
    "refuses a prefix that overlaps a platform bucket, with the feature %s",
    (perOrg) => {
      const error = loadWith({
        "grid-oib:seaweedfsPerOrgBuckets": perOrg,
        "grid-oib:seaweedfsTenantBucketPrefix": "grid-",
      });
      expect(error?.message).toMatch(/is a prefix of the platform bucket/);
    },
  );

  it("refuses a prefix with no trailing hyphen", () => {
    // Without it, `grid-org*` would also match a bucket literally named
    // `grid-organizations`.
    const error = loadWith({ "grid-oib:seaweedfsTenantBucketPrefix": "grid-org" });
    expect(error?.message).toMatch(/end with "-"/);
  });

  it("refuses the S3-reserved xn-- prefix", () => {
    const error = loadWith({ "grid-oib:seaweedfsTenantBucketPrefix": "xn--t-" });
    expect(error?.message).toMatch(/xn--/);
  });

  it("accepts the default", () => {
    expect(loadWith({})).toBeNull();
  });
});

describe("SeaweedFS topology", () => {

  it("refuses an even master count", () => {
    // Two masters tolerate no more failures than one and add a way to deadlock.
    const error = loadWith({ "grid-oib:seaweedfsMasterReplicas": "2" });
    expect(error?.message).toMatch(/odd number/);
  });

  it("refuses more filer replicas than the embedded store can serve", () => {
    // Each replica would keep a private namespace on its own PVC, so the same
    // object would exist or not depending on which pod answered.
    const error = loadWith({
      "grid-oib:seaweedfsFilerStore": "leveldb",
      "grid-oib:seaweedfsFilerReplicas": "2",
    });
    expect(error?.message).toMatch(/private namespace/);
  });

  it("refuses a replication factor it cannot place", () => {
    // SeaweedFS does not fail the deploy for this; it fails each volume-grow
    // once the first volume fills, which looks like uploads spontaneously
    // breaking rather than a config error.
    const error = loadWith({
      "grid-oib:seaweedfsDefaultReplication": "010",
      "grid-oib:seaweedfsVolumeReplicas": "1",
    });
    expect(error?.message).toMatch(/asks for 2 copies but/);
  });

  it("refuses a free-space brake smaller than one volume", () => {
    // The disk can hit ENOSPC while a volume is growing into it — the brake
    // would engage after the crash it exists to prevent.
    const error = loadWith({
      "grid-oib:seaweedfsVolumeSizeLimitMB": "1024",
      "grid-oib:seaweedfsVolumeMinFreeSpace": "512MiB",
    });
    expect(error?.message).toMatch(/smaller than one volume/);
  });

  it("requires the filer store credential on the split topology", () => {
    // Without it the filer boots, cannot open its store, and `glog.Fatalf`s —
    // so the deploy fails on a crash-looping StatefulSet rather than on the
    // missing value that caused it.
    const error = loadWith({ "grid-oib:seaweedfsTopology": "split" }, [
      "grid-oib:seaweedfsFilerDbPassword",
    ]);
    expect(error?.message).toMatch(/seaweedfsFilerDbPassword is required/);
  });

  it("does not require it on the single-node topology, which has no filer store", () => {
    expect(
      loadWith({ "grid-oib:seaweedfsTopology": "single" }, [
        "grid-oib:seaweedfsFilerDbPassword",
      ]),
    ).toBeNull();
  });

  it("requires the bucket-lifecycle credential only when tenant buckets are on", () => {
    expect(
      loadWith({ "grid-oib:seaweedfsPerOrgBuckets": "true" }, [
        "grid-oib:seaweedfsTenantAdminSecretKey",
      ])?.message,
    ).toMatch(/seaweedfsTenantAdminSecretKey is required/);
    expect(
      loadWith({ "grid-oib:seaweedfsPerOrgBuckets": "false" }, [
        "grid-oib:seaweedfsTenantAdminSecretKey",
      ]),
    ).toBeNull();
  });
});

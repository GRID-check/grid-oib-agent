import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { RETIRED_VECTOR_KEYS, loadConfig } from "./config";
import { baseStackConfig } from "./test-support/stack-config";

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
    // Every `require` / `requireSecret` key, so a test about one knob is not
    // defeated by a different missing one. Shared with `index.spec.ts` rather
    // than copied: two copies drift the moment `loadConfig` gains another
    // required key, and the drift surfaces as an unrelated failure in whichever
    // suite was not updated.
    ...baseStackConfig(),
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

describe("the retired Chroma tier and vector switch (ADR-0113)", () => {
  // Each would read as a setting: `qdrantEnabled: false` as "no Qdrant",
  // `vectorBackend: chroma` as "reads stay on Chroma". Neither is true, so the
  // plan names the key instead of deploying past it.
  it.each([
    ["chromaEnabled", "true"],
    ["chromaImage", "chromadb/chroma:1.5.9"],
    ["chromaStorageSize", "20Gi"],
    ["qdrantEnabled", "false"],
    ["vectorBackend", "chroma"],
  ])("refuses a stack that still sets %s", (key, value) => {
    const error = loadWith({ [`grid-oib:${key}`]: value });
    expect(error?.message).toMatch(new RegExp(`grid-oib:${key} is retired: Qdrant is the only vector store`));
    expect(error?.message).toMatch(/pulumi config rm/);
  });

  it("names every retired key at once", () => {
    const all = Object.fromEntries(RETIRED_VECTOR_KEYS.map((k) => [`grid-oib:${k}`, "x"]));
    expect(loadWith(all)?.message).toMatch(
      /grid-oib:chromaEnabled, grid-oib:chromaImage, grid-oib:chromaStorageSize, grid-oib:qdrantEnabled, grid-oib:vectorBackend are retired/,
    );
  });
});

describe("the Chroma migration Job's knobs", () => {
  it("is off by default, and waits 40 minutes for the Job: inside the pipeline's hour", () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    expect(loadConfig().chromaMigration).toEqual({ enabled: false, scratchSize: "50Gi", timeoutMinutes: 40 });
  });

  it("takes another scratch size and timeout from the stack", () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      "grid-oib:chromaMigration": "true",
      "grid-oib:chromaMigrationScratchSize": "80Gi",
      "grid-oib:chromaMigrationTimeoutMinutes": "120",
    });
    expect(loadConfig().chromaMigration).toEqual({ enabled: true, scratchSize: "80Gi", timeoutMinutes: 120 });
  });

  it("refuses a timeout that is not a whole number of minutes", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:chromaMigrationTimeoutMinutes": "0" });
    expect(() => loadConfig()).toThrow(/chromaMigrationTimeoutMinutes must be a whole number/);
  });
});

describe("Qdrant (ADR-0113)", () => {
  it("defaults the cluster to the design's shape", () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    const cfg = loadConfig();
    expect(cfg.qdrant).toMatchObject({
      image: "qdrant/qdrant:v1.19.2",
      replicas: 3,
      cpu: "4",
      memory: "16Gi",
      storageSize: "100Gi",
      quotas: { memoryPercent: 90, diskPercent: 85 },
      snapshots: { schedule: "30 1 * * *", retentionDays: 7, s3AccessKey: "grid-qdrant" },
    });
  });

  // Qdrant refuses an unknown variant at start, on every peer at once.
  it("refuses a low-memory mode Qdrant does not know, and accepts the two it does", () => {
    const error = loadWith({ "grid-oib:qdrantLowMemoryMode": "bogus" });
    expect(error?.message).toMatch(/qdrantLowMemoryMode must be one of no_resident, no_populate/);
    expect(loadWith({ "grid-oib:qdrantLowMemoryMode": "no_populate" })).toBeNull();
  });

  // The rotation key is accepted as a read-write key by every peer.
  it("refuses a rotation key equal to the read-only key", () => {
    const error = loadWith({ "grid-oib:qdrantAltApiKey": "qd-ro" });
    expect(error?.message).toMatch(/qdrantAltApiKey must differ from grid-oib:qdrantReadOnlyApiKey/);
    expect(loadWith({ "grid-oib:qdrantAltApiKey": "qd-next" })).toBeNull();
  });

  // 100 is no quota at all, and 0 refuses every write.
  it.each([
    ["qdrantQuotaMemoryPercent", "100"],
    ["qdrantQuotaDiskPercent", "0"],
    ["qdrantQuotaDiskPercent", "85.5"],
  ])("refuses %s=%s", (key, value) => {
    const error = loadWith({ [`grid-oib:${key}`]: value });
    expect(error?.message).toMatch(new RegExp(`${key} must be a whole percentage between 1 and 99`));
  });

  // Open-source Qdrant answers anyone without a key, and it is always deployed.
  it("names every missing credential at once, on any stack", () => {
    const error = loadWith({}, ["grid-oib:qdrantApiKey", "grid-oib:qdrantReadOnlyApiKey", "grid-oib:qdrantS3SecretKey"]);
    expect(error?.message).toMatch(
      /grid-oib:qdrantApiKey, grid-oib:qdrantReadOnlyApiKey, grid-oib:qdrantS3SecretKey are required \(Qdrant is always deployed/,
    );
  });

  it("refuses a read-only key equal to the read-write key", () => {
    const error = loadWith({ "grid-oib:qdrantReadOnlyApiKey": "qd-rw" });
    expect(error?.message).toMatch(/qdrantReadOnlyApiKey must differ from grid-oib:qdrantApiKey/);
  });

  it("refuses a snapshot S3 secret shared with another identity", () => {
    const error = loadWith({ "grid-oib:qdrantS3SecretKey": "s3-secret" });
    expect(error?.message).toMatch(/qdrantS3SecretKey must differ from grid-oib:seaweedfsSecretKey/);
  });

  // Two voters lose quorum when either fails.
  it("refuses two replicas and accepts one", () => {
    expect(loadWith({ "grid-oib:qdrantReplicas": "2" })?.message).toMatch(
      /qdrantReplicas=2 is refused/,
    );
    expect(loadWith({ "grid-oib:qdrantReplicas": "1" })).toBeNull();
  });

  it("refuses a snapshot schedule that is not 5-field cron", () => {
    const error = loadWith({ "grid-oib:qdrantSnapshotSchedule": "0 30 1 * * *" });
    expect(error?.message).toMatch(/qdrantSnapshotSchedule must be a 5-field cron/);
  });

  it("refuses a tenant prefix that would cover the snapshot bucket", () => {
    const error = loadWith({ "grid-oib:seaweedfsTenantBucketPrefix": "qdrant-" });
    expect(error?.message).toMatch(/is a prefix of the platform bucket "qdrant-snapshots"/);
  });
});

describe("Qdrant's dashboard at the edge", () => {
  const connectApp = {
    "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
    "grid-oib:otelOidcClientId": "client_otel",
    "grid-oib:otelOidcClientSecret": "otel-client-secret", // pragma: allowlist secret
  };

  it("is off by default, on the qdrant.<baseDomain> host", () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    const cfg = loadConfig();
    expect(cfg.qdrant.dashboard).toEqual({ enabled: false, domain: "qdrant.example.test" });
    expect(cfg.dns.hosts).not.toContain("qdrant.example.test");
  });

  it("joins the DNS host set when on, and takes an overridden host", () => {
    pulumi.runtime.setAllConfig({
      ...baseStackConfig(),
      ...connectApp,
      "grid-oib:qdrantDashboardEnabled": "true",
      "grid-oib:qdrantDashboardDomain": "vectors.example.test",
    });
    const cfg = loadConfig();
    expect(cfg.qdrant.dashboard).toEqual({ enabled: true, domain: "vectors.example.test" });
    expect(cfg.dns.hosts).toContain("vectors.example.test");
  });

  // The zone check runs over the same host list, so a dashboard host outside
  // the zone is caught before Cloudflare appends the zone to it.
  it("is covered by the zone check when DNS is managed", () => {
    const error = loadWith({
      ...connectApp,
      "grid-oib:qdrantDashboardEnabled": "true",
      "grid-oib:qdrantDashboardDomain": "qdrant.elsewhere.test",
      "grid-oib:loadBalancerIp": "203.0.113.10",
      "grid-oib:dnsEnabled": "true",
      "grid-oib:dnsZoneId": "zone-abc123",
      "grid-oib:dnsZoneName": "example.test",
      "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
    });
    expect(error?.message).toMatch(/qdrant\.elsewhere\.test is not inside it/);
  });

  it("refuses the template placeholder host", () => {
    const error = loadWith({ "grid-oib:qdrantDashboardDomain": "qdrant.example.com" });
    expect(error?.message).toMatch(/grid-oib:qdrantDashboardDomain is still the template placeholder/);
  });

  // The gate is the only thing between the public host and the store.
  it("refuses to turn on without the Connect application, naming what is missing", () => {
    const error = loadWith({
      "grid-oib:qdrantDashboardEnabled": "true",
      "grid-oib:otelOidcIssuer": "https://grid.authkit.app",
    });
    expect(error?.message).toMatch(
      /qdrantDashboardEnabled needs the platform WorkOS Connect application .*missing grid-oib:otelOidcClientId, grid-oib:otelOidcClientSecret/,
    );
    expect(loadWith({ ...connectApp, "grid-oib:qdrantDashboardEnabled": "true" })).toBeNull();
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

describe("documents backup credentials", () => {
  const enable = {
    "grid-oib:seaweedfsBackupEnabled": "true",
    "grid-oib:seaweedfsBackupEndpoint": "https://offsite.example.test",
    "grid-oib:seaweedfsBackupAccessKey": "offsite-key", // pragma: allowlist secret
    "grid-oib:seaweedfsBackupSecretKey": "offsite-secret", // pragma: allowlist secret
  };

  // The guard's message named both keys and its condition tested one. A stack
  // that set the access key and omitted the secret planned clean, substituted
  // `pulumi.secret("")`, and `weed filer.backup` then signed every request with
  // an empty secret — `SignatureDoesNotMatch` against a mirror the operator
  // believes is running, which is the exact silent backup-to-nowhere this refuses.
  it.each([
    ["the secret key", "grid-oib:seaweedfsBackupSecretKey"],
    ["the access key", "grid-oib:seaweedfsBackupAccessKey"],
  ])("refuses a mirror missing %s", (_label, omitted) => {
    const error = loadWith(enable, [omitted]);
    expect(error?.message).toContain(omitted);
    expect(error?.message).toMatch(/required when seaweedfsBackupEnabled is true/);
  });

  /**
   * A key that is SET TO EMPTY is missing.
   *
   * `pulumi config set --secret grid-oib:seaweedfsBackupSecretKey ""` is easy to
   * do by accident — a shell variable that did not expand, a value pasted from an
   * empty clipboard — and `cfg.getSecret` returns a defined output for it, so an
   * unset-vs-set check waves it through. The result is not a configuration error
   * an operator can see: it is `weed filer.backup` signing every request with an
   * empty key, `SignatureDoesNotMatch`, and a mirror that reports nothing while
   * copying nothing. That is precisely what this guard exists to prevent, so the
   * condition is "can this credential sign?", not "does the key exist?".
   */
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses a key set to %s, which cannot sign anything", (_label, value) => {
    const error = loadWith({ ...enable, "grid-oib:seaweedfsBackupSecretKey": value });
    expect(error?.message).toContain("grid-oib:seaweedfsBackupSecretKey");
    expect(error?.message).toMatch(/required when seaweedfsBackupEnabled is true/);
  })

  it("names every missing key at once, so one plan reports the whole gap", () => {
    const error = loadWith(enable, [
      "grid-oib:seaweedfsBackupAccessKey",
      "grid-oib:seaweedfsBackupSecretKey",
    ]);
    expect(error?.message).toContain("grid-oib:seaweedfsBackupAccessKey");
    expect(error?.message).toContain("grid-oib:seaweedfsBackupSecretKey");
  });

  it("accepts a fully configured mirror", () => {
    expect(loadWith(enable)).toBeNull();
  });

  it("asks for neither key while the mirror is off", () => {
    expect(
      loadWith({}, [
        "grid-oib:seaweedfsBackupAccessKey",
        "grid-oib:seaweedfsBackupSecretKey",
      ]),
    ).toBeNull();
  });
});

describe("chat tier scale-out (ADR-0080)", () => {
  it("keeps affinity on by default, so the tier is the static hash it was", () => {
    expect(loadWith({})).toBeNull();
    pulumi.runtime.setAllConfig({ ...baseStackConfig() });
    expect(loadConfig().backend.chatAffinity).toBe(true);
  });

  it("keeps the short drain while the count is static, and the longest turn once KEDA owns it", () => {
    // A singleton serves nobody while it drains: a 45 minute wait on every deploy would be an outage.
    pulumi.runtime.setAllConfig({ ...baseStackConfig() });
    expect(loadConfig().backend.drainSeconds).toBe(20);
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:chatAffinity": "false" });
    expect(loadConfig().backend.drainSeconds).toBe(2730);
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:backendDrainSeconds": "300" });
    expect(loadConfig().backend.drainSeconds).toBe(300);
  });

  it("refuses a ceiling below the floor", () => {
    // KEDA would be handed min > max and the HPA rejects it at apply time, after
    // the rest of the stack has started changing.
    const error = loadWith({ "grid-oib:backendReplicas": "3", "grid-oib:backendMaxReplicas": "2" });
    expect(error?.message).toMatch(/backendMaxReplicas/);
  });

  it("refuses affinity off without the conversation bus", () => {
    // Without the bus nothing relays a turn to the replica holding the socket,
    // so the first socket the Service hands to the wrong replica hangs silently.
    const error = loadWith({ "grid-oib:chatAffinity": "false", "grid-oib:conversationBus": "false" });
    expect(error?.message).toMatch(/needs grid-oib:conversationBus=true/);
  });
});

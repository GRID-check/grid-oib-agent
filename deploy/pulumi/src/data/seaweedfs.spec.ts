import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";

/**
 * Manifest tests for the SeaweedFS topologies (ADR-0043).
 *
 * ## Why this file exists
 *
 * `tsc --noEmit` proves the program is well-typed. It proves nothing about the
 * manifests, which is where every SeaweedFS bug in this repo's history has
 * lived: a flag renamed between versions, a Service missing the gRPC port that
 * `weed shell` needs, a probe pointed at an endpoint that answers 423. Those
 * are all string-valued and all invisible to the type checker, and until now
 * the only way to find one was a live deploy.
 *
 * `pulumi.runtime.setMocks` runs the program without a cluster or a backend, so
 * the resource inputs can be asserted directly. What follows is deliberately
 * narrow: it pins the things that are load-bearing AND silent when wrong.
 *
 * ## What it cannot tell you
 *
 * That the cluster comes up. These are the manifests the program would apply,
 * checked against what the SeaweedFS 3.80 source says the flags mean. A
 * rehearsed deploy is still the only thing that proves the topology runs, and
 * ADR-0043 says so.
 */

// Mocks must be installed before any Pulumi resource is constructed, so every
// module under test is imported lazily, inside the helpers below.
/** Every Secret the program creates, and the file names inside it. */
const SECRET_KEYS: Array<{ name: string; keys: string[] }> = [];

/**
 * Pulumi lifts secretness to the ENCLOSING object when it serializes, so a
 * `stringData` map holding one secret value arrives at the mock wrapped in
 * `{ <sentinel>: sig, value: {...} }` rather than as the map itself. Unwrap it,
 * or `Object.keys` returns Pulumi's internals instead of the file names.
 */
// Pulumi's own well-known special-value marker, not a credential.
const SECRET_SENTINEL = "4dabf18193072939515e22adb298388d"; // pragma: allowlist secret
function unwrapSecret(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  return SECRET_SENTINEL in record
    ? (record.value as Record<string, unknown>)
    : record;
}

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      if (args.type === "kubernetes:core/v1:Secret") {
        SECRET_KEYS.push({
          name: (args.inputs.metadata as { name?: string } | undefined)?.name ?? args.name,
          keys: Object.keys(unwrapSecret(args.inputs.stringData) ?? {}),
        });
      }
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

/** Resolve an Output to a plain value. */
function value<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply(resolve));
}

type Container = { name: string; args?: string[]; [k: string]: unknown };
type Probe = { httpGet?: { path?: string; port?: number }; tcpSocket?: { port?: number } };

/**
 * The one place this file widens a type. Pulumi's generated StatefulSet input
 * types are deeply optional and mutually recursive; asserting through them
 * needs ~15 non-null assertions per lookup, which buries the assertion in
 * punctuation. The resolved value is plain JSON, so it is narrowed once, here,
 * and every helper below reads the narrowed shape.
 */
interface ResolvedPodSpec {
  containers: Container[];
  terminationGracePeriodSeconds?: number;
  topologySpreadConstraints?: unknown[];
}
interface ResolvedStatefulSet {
  replicas?: number;
  minReadySeconds?: number;
  updateStrategy?: { type?: string };
  podManagementPolicy?: string;
  serviceName?: string;
  volumeClaimTemplates?: Array<{
    metadata?: { name?: string };
    spec?: { resources?: { requests?: { storage?: string } } };
  }>;
  template: { spec: ResolvedPodSpec };
}

async function statefulSetSpec(ss: {
  spec: pulumi.Output<unknown>;
}): Promise<ResolvedStatefulSet> {
  return (await value(ss.spec)) as ResolvedStatefulSet;
}

function container(spec: ResolvedStatefulSet, name: string): Container {
  const found = spec.template.spec.containers.find((c) => c.name === name);
  if (!found) throw new Error(`no container named ${name}`);
  return found;
}

/** A test GridConfig. Only the SeaweedFS surface matters here. */
function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    protectDataResources: false,
    storage: { className: "premium" },
    ingress: { s3Domain: "s3.example.test" },
    seaweedfs: {
      image: "chrislusf/seaweedfs:3.80",
      storageSize: "20Gi",
      bucket: "grid-documents",
      accessKey: "grid",
      secretKey: pulumi.secret("root-secret"), // pragma: allowlist secret
      backendReadAccessKey: "grid-backend-read",
      backendReadSecretKey: pulumi.secret("read-secret"), // pragma: allowlist secret
      perOrgBuckets: false,
      tenantBucketPrefix: "grid-org-",
      tenantAdminAccessKey: "grid-tenant-admin",
      tenantAdminSecretKey: pulumi.secret("admin-secret"), // pragma: allowlist secret
      topology: "split" as const,
      masterReplicas: 1,
      volumeReplicas: 1,
      filerReplicas: 1,
      masterStorageSize: "1Gi",
      volumeSizeLimitMB: 1024,
      volumeMaxCount: 64,
      volumeMinFreeSpace: "2GiB",
      defaultReplication: "000",
      filerStore: "postgres" as const,
      filerDatabase: "seaweedfs_filer",
      filerDatabaseUser: "seaweedfs_filer",
      filerDatabasePassword: pulumi.secret("filer-secret"), // pragma: allowlist secret
      backup: {
        enabled: false,
        endpoint: "",
        bucket: "grid-documents-backup",
        region: "us-east-1",
        accessKey: pulumi.secret(""),
        secretKey: pulumi.secret(""),
        metadataSchedule: "0 3 * * *",
      },
      encryptVolumeData: true,
    },
    // `renderS3Config` zips the Langfuse S3 credential onto the catalogue
    // whenever the tier is on (ADR-0044), so the fixture has to carry it even
    // for the default-off case — reading `.s3AccessKey` off an absent
    // `langfuse` throws before the `enabled` flag is ever consulted.
    langfuse: {
      enabled: false,
      s3AccessKey: "grid-langfuse",
      s3SecretKey: pulumi.secret("langfuse-secret"), // pragma: allowlist secret
    },
  };
  return {
    ...base,
    seaweedfs: { ...base.seaweedfs, ...(overrides.seaweedfs as object) },
    langfuse: { ...base.langfuse, ...(overrides.langfuse as object) },
    // The modules under test only read the fields above; the cast is the one
    // documented boundary between this fixture and the full GridConfig.
  } as unknown as import("../config").GridConfig;
}

/**
 * Build either topology's workloads.
 *
 * Module scope rather than inside a `describe`, because one of the rules below
 * ("never probe a non-self-scoped endpoint") has to hold across BOTH topologies
 * — and a helper scoped to one describe is how that rule came to be asserted for
 * the split topology only while the single-node one broke it.
 *
 * Each provider gets a distinct name: Pulumi rejects two resources with the same
 * URN, so a shared one would make the second install in any test throw.
 */
let providerSeq = 0;
function nextProvider(k8s: typeof import("@pulumi/kubernetes"), label: string) {
  providerSeq += 1;
  return new k8s.Provider(`test-${label}-${providerSeq}`, {});
}

async function installSplit(overrides: Record<string, unknown> = {}) {
  const k8s = await import("@pulumi/kubernetes");
  const mod = await import("./seaweedfs-split");
  const identities = await import("./seaweedfs-identities");
  const provider = nextProvider(k8s, "split");
  const cfg = makeConfig(overrides);
  const secret = identities.s3ConfigSecret(cfg, provider, "grid", {
    platformBuckets: [cfg.seaweedfs.bucket],
    tenantBucketPrefix: cfg.seaweedfs.tenantBucketPrefix,
    provisioning: cfg.seaweedfs.perOrgBuckets,
  });
  return mod.installSplitSeaweedFS(
    cfg,
    provider,
    "grid",
    secret,
    pulumi.output("checksum"),
    "grid-pg-rw",
    [],
  );
}

async function installSingle(overrides: Record<string, unknown> = {}) {
  const k8s = await import("@pulumi/kubernetes");
  const { installSingleNodeSeaweedFS } = await import("./seaweedfs-single");
  const identities = await import("./seaweedfs-identities");
  const provider = nextProvider(k8s, "single");
  const cfg = makeConfig({ seaweedfs: { topology: "single", ...overrides } });
  const secret = identities.s3ConfigSecret(cfg, provider, "grid", {
    platformBuckets: [cfg.seaweedfs.bucket],
    tenantBucketPrefix: "grid-org-",
    provisioning: false,
  });
  return installSingleNodeSeaweedFS(cfg, provider, "grid", secret, pulumi.output("checksum"));
}

describe("split topology", () => {
  const install = installSplit;

  it("addresses the master separately from the S3 endpoint", async () => {
    const t = await install();
    // `weed shell` and the metadata snapshot dial the MASTER, not the gateway.
    // Under `single` these were the same host; a caller that kept assuming so
    // would connect-BLOCK rather than fail, because nothing listens on 9333 at
    // the filer Service.
    expect(t.masterAddress).toBe("seaweedfs-master:9333");
    expect(t.filerAddress).toBe("seaweedfs:8888");
  });

  it("keeps the filer on the `seaweedfs` name the app tier and the edge use", async () => {
    const t = await install();
    // `SEAWEED_ENDPOINT=http://seaweedfs:8333` and the `allow-edge-to-seaweedfs`
    // NetworkPolicy (which selects app.kubernetes.io/name=seaweedfs) both
    // depend on this. Renaming the workload silently removes the edge allow.
    const meta = (await value(t.service.metadata)) as { name?: string; labels?: Record<string, string> };
    expect(meta.name).toBe("seaweedfs");
    expect(meta.labels?.["app.kubernetes.io/name"]).toBe("seaweedfs");
  });

  it("publishes the gRPC ports weed tooling dials", async () => {
    const t = await install();
    const svc = (await value(t.service.spec)) as { ports?: Array<{ port: number }> };
    const master = (await value(t.masterService.spec)) as { ports?: Array<{ port: number }> };
    // 18888 is what `weed shell` and `filer.backup` use; a Service that omits
    // it makes them hang rather than error (found on a live deploy).
    expect(svc.ports?.map((p) => p.port).sort((a, b) => a - b)).toEqual([8333, 8888, 18888]);
    expect(master.ports?.map((p) => p.port).sort((a, b) => a - b)).toEqual([9333, 19333]);
  });

  describe("flags", () => {
    it("gives the master a peer list of resolvable per-pod DNS names", async () => {
      const t = await install({ seaweedfs: { masterReplicas: 3 } });
      const spec = await statefulSetSpec(t.workloads[0]);
      const args = container(spec, "master").args!.join(" ");
      expect(args).toContain(
        "-peers=seaweedfs-master-0.seaweedfs-master-peer.grid.svc.cluster.local:9333," +
          "seaweedfs-master-1.seaweedfs-master-peer.grid.svc.cluster.local:9333," +
          "seaweedfs-master-2.seaweedfs-master-peer.grid.svc.cluster.local:9333",
      );
    });

    it("advertises each pod under its own DNS name, never the Service name", async () => {
      const t = await install();
      const master = container(await statefulSetSpec(t.workloads[0]), "master").args!.join(" ");
      const volume = container(await statefulSetSpec(t.workloads[1]), "volume").args!.join(" ");
      const filer = container(await statefulSetSpec(t.workloads[2]), "filer").args!.join(" ");
      // The master keys its cluster-member map BY ADDRESS. Advertising a
      // Service name collapses every replica into one entry, which breaks
      // chunk placement and filer metadata aggregation — silently, in both
      // cases.
      expect(master).toContain("-ip=$(POD_NAME).seaweedfs-master-peer.$(POD_NAMESPACE)");
      expect(volume).toContain("-ip=$(POD_NAME).seaweedfs-volume-peer.$(POD_NAMESPACE)");
      expect(filer).toContain("-ip=$(POD_NAME).seaweedfs-filer-peer.$(POD_NAMESPACE)");
    });

    it("supplies the downward-API env those addresses interpolate from", async () => {
      const t = await install();
      for (const [i, name] of [["master"], ["volume"], ["filer"]].entries()) {
        const c = container(await statefulSetSpec(t.workloads[i]), name[0]);
        const env = (c.env as Array<{ name: string }>) ?? [];
        // Without these the shell expands `$(POD_NAME)` to the empty string and
        // every pod advertises the same malformed address.
        expect(env.map((e) => e.name)).toEqual(
          expect.arrayContaining(["POD_NAME", "POD_NAMESPACE", "NODE_NAME"]),
        );
      }
    });

    it("points the volume server at the master and the filer at the master", async () => {
      const t = await install();
      // Different flag NAMES for the same idea: `weed volume` takes -mserver,
      // `weed filer` takes -master. Swapping them is accepted by neither.
      expect(container(await statefulSetSpec(t.workloads[1]), "volume").args!.join(" ")).toContain(
        "-mserver=seaweedfs-master:9333",
      );
      expect(container(await statefulSetSpec(t.workloads[2]), "filer").args!.join(" ")).toContain(
        "-master=seaweedfs-master:9333",
      );
    });

    it("reports the Kubernetes node as the SeaweedFS rack", async () => {
      const t = await install();
      // This is what makes `-defaultReplication=010` mean "two machines"
      // rather than "two pods". With every server in one rack, a 010
      // placement can never be satisfied and volume growth fails once the
      // first volume fills — which looks like uploads spontaneously breaking.
      expect(container(await statefulSetSpec(t.workloads[1]), "volume").args!.join(" ")).toContain(
        "-rack=$(NODE_NAME)",
      );
    });

    it("passes -encryptVolumeData to the FILER, which is what owns the keys", async () => {
      const on = await install();
      const off = await install({ seaweedfs: { encryptVolumeData: false } });
      // The volume server has no concept of encryption; the flag belongs to the
      // filer, which mints and stores the per-chunk keys.
      expect(container(await statefulSetSpec(on.workloads[2]), "filer").args!.join(" ")).toContain(
        "-encryptVolumeData",
      );
      expect(
        container(await statefulSetSpec(off.workloads[2]), "filer").args!.join(" "),
      ).not.toContain("-encryptVolumeData");
      expect(container(await statefulSetSpec(on.workloads[1]), "volume").args!.join(" ")).not.toContain(
        "encryptVolumeData",
      );
    });

    it("gives every filer the same filerGroup", async () => {
      const t = await install({ seaweedfs: { filerReplicas: 3 } });
      // Filers only aggregate metadata from peers in the same group. A
      // mismatch produces replicas that never see each other's writes, with
      // nothing in any log to say so.
      expect(container(await statefulSetSpec(t.workloads[2]), "filer").args!.join(" ")).toContain(
        "-filerGroup=grid",
      );
    });
  });

  describe("probes", () => {
    it("never uses a non-self-scoped endpoint for LIVENESS", async () => {
      const t = await install();
      const master = container(await statefulSetSpec(t.workloads[0]), "master");
      const volume = container(await statefulSetSpec(t.workloads[1]), "volume");
      // The master's /cluster/healthz answers 423 while the leader holds a
      // topology lock, and the volume server's /healthz answers 503 when a PEER
      // is unreachable. As liveness probes the second turns one node going away
      // into a cluster-wide restart cascade.
      expect((master.livenessProbe as Probe).httpGet).toBeUndefined();
      expect((master.livenessProbe as Probe).tcpSocket?.port).toBe(9333);
      expect((volume.livenessProbe as Probe).httpGet).toBeUndefined();
      expect((volume.livenessProbe as Probe).tcpSocket?.port).toBe(8080);
      // Readiness is where the volume endpoint belongs: it takes a pod out of
      // the Service without restarting it, and with `000` replication it never
      // probes a peer at all.
      expect((volume.readinessProbe as Probe).httpGet?.path).toBe("/healthz");
      // The master's is different, and the reason is arithmetic rather than
      // semantics — see the next test.
      expect((master.readinessProbe as Probe).tcpSocket?.port).toBe(9333);
    });

    it("only puts the master's cluster health on readiness once there is a quorum", async () => {
      // With ONE master, that pod is the only endpoint of the `seaweedfs-master`
      // Service — which the volume servers, the filer and every `weed shell`
      // resolve. `/cluster/healthz` answers 423 while it holds a topology lock,
      // so 60s of an ordinary admin operation would empty the Service and fail
      // every new master connection in the cluster. TCP is the honest check
      // there: the only question a single master can answer is "am I up".
      const solo = await install();
      expect((container(await statefulSetSpec(solo.workloads[0]), "master").readinessProbe as Probe).tcpSocket?.port).toBe(9333);

      // With a quorum the calculus flips: a locked or leaderless member SHOULD
      // leave the Service, because the others can still serve.
      const quorum = await install({ seaweedfs: { masterReplicas: 3 } });
      expect(
        (container(await statefulSetSpec(quorum.workloads[0]), "master").readinessProbe as Probe)
          .httpGet?.path,
      ).toBe("/cluster/healthz");
    });

    it("uses the filer's own store round-trip for both of its probes", async () => {
      const t = await install();
      const filer = container(await statefulSetSpec(t.workloads[2]), "filer");
      // /healthz on the filer looks up /topics in its OWN store, so it fails
      // exactly when this pod cannot serve — the one endpoint of the three
      // that is safe as a liveness probe.
      expect((filer.readinessProbe as Probe).httpGet).toEqual({ path: "/healthz", port: 8888 });
      expect((filer.livenessProbe as Probe).httpGet).toEqual({ path: "/healthz", port: 8888 });
    });
  });

  describe("filer.toml", () => {
    it("tells weed where to find its store config", async () => {
      const t = await install();
      // Without `-config_dir`, `util.LoadConfiguration("filer", false)` finds
      // nothing and the filer falls back to an EMBEDDED leveldb2 — which boots
      // cleanly, reports healthy, and gives each replica a private namespace.
      const args = container(await statefulSetSpec(t.workloads[2]), "filer").args!.join(" ");
      expect(args).toContain("-config_dir=/etc/seaweedfs");
      expect(args).toContain("-s3.config=/etc/seaweedfs/s3.json");
    });

    it("mounts the config Secret read-only at that path", async () => {
      const t = await install();
      const spec = await statefulSetSpec(t.workloads[2]);
      const mounts = container(spec, "filer").volumeMounts as Array<{
        mountPath: string;
        readOnly?: boolean;
      }>;
      const config = mounts.find((m) => m.mountPath === "/etc/seaweedfs");
      expect(config?.readOnly).toBe(true);
    });
  });

  it("does not claim the PVC the single-node topology leaves behind", async () => {
    const t = await install();
    const filer = await statefulSetSpec(t.workloads[2]);
    // A StatefulSet's PVC is `<template>-<statefulset>-<ordinal>`, and the
    // filer deliberately keeps the workload name `seaweedfs`. A template named
    // `data` would therefore claim `data-seaweedfs-0` — the exact PVC the
    // single-node StatefulSet retains, holding every object in the deployment.
    // The new filer would adopt it silently, and the migration would find its
    // source already mounted by its destination.
    expect(filer.volumeClaimTemplates?.map((v) => v.metadata?.name)).toEqual(["filer-data"]);
    const master = await statefulSetSpec(t.workloads[0]);
    const volume = await statefulSetSpec(t.workloads[1]);
    // These two carry distinct workload names, so `data` is unambiguous there
    // and their PVCs cannot collide with the retained one either.
    expect(master.volumeClaimTemplates?.map((v) => v.metadata?.name)).toEqual(["data"]);
    expect(volume.volumeClaimTemplates?.map((v) => v.metadata?.name)).toEqual(["data"]);
  });

  it("sizes each role's disk from its own knob", async () => {
    const t = await installSplit({
      seaweedfs: { masterStorageSize: "1Gi", filerStorageSize: "40Gi", storageSize: "500Gi" },
    });
    const size = async (i: number) =>
      (await statefulSetSpec(t.workloads[i])).volumeClaimTemplates?.[0]?.spec?.resources?.requests
        ?.storage;

    // The filer's claim used to request `masterStorageSize` — a key documented
    // and defaulted (1Gi) for a raft log — while under `filerStore: "leveldb"`
    // it holds the metadata entry and the per-chunk AES key for every object in
    // the deployment. An operator whose filer store was filling had nothing to
    // raise but the master's claim, and a full filer store stops every write.
    expect(await size(0)).toBe("1Gi");
    expect(await size(1)).toBe("500Gi");
    expect(await size(2)).toBe("40Gi");
  });

  // The defect this pins killed the whole filer process, not just the S3 API:
  // `NewIdentityAccessManagement` calls `glog.Fatalf` when `-s3.config` names a
  // file it cannot read. The split rewrite mounted only `filer.toml`, so every
  // fresh `split` stack would have crash-looped from first boot — and the
  // bucket-init Job waits on the filer's /healthz, so `pulumi up` would never
  // converge and every downstream workload would block behind it.
  it("mounts BOTH config Secrets at the path the filer reads", async () => {
    const t = await install();
    const spec = await statefulSetSpec(t.workloads[2]);
    const volumes = (spec.template.spec as unknown as {
      volumes: Array<{ name: string; projected?: { sources: Array<{ secret: { name: string } }> } }>;
    }).volumes;
    const config = volumes.find((v) => v.name === "config");
    const mounted = config?.projected?.sources.map((src) => src.secret.name).sort();
    expect(mounted).toEqual(["seaweedfs-filer-config", "seaweedfs-s3-config"]);

    const mounts = container(spec, "filer").volumeMounts as Array<{ name: string; mountPath: string }>;
    expect(mounts.find((m) => m.name === "config")?.mountPath).toBe("/etc/seaweedfs");
  });

  // A projected volume without `items` surfaces every key of each source, so
  // two sources sharing a key name is a conflict the API server cannot catch at
  // admission — it lands as a pod stuck mounting. The two Secrets are disjoint
  // today; this is what keeps them so.
  it("projects two Secrets whose keys cannot collide", async () => {
    await install();
    // Earlier cases in this file build the topology too, so dedupe by name —
    // what is under test is the KEY SETS, not how many times they were created.
    const byName = new Map(
      SECRET_KEYS.filter(
        (s) => s.name === "seaweedfs-filer-config" || s.name === "seaweedfs-s3-config",
      ).map((s) => [s.name, s]),
    );
    const projected = [...byName.values()];
    expect(projected).toHaveLength(2);
    const all = projected.flatMap((s) => s.keys);
    expect(all.sort()).toEqual(["filer.toml", "s3.json"]);
    expect(new Set(all).size).toBe(all.length);
  });

  // Both config files are read once, at process start. Without a checksum on
  // the pod template, rotating either credential updates the Secret, restarts
  // nothing, and reports success while every pod keeps using the value that was
  // just retired.
  it("rolls the pods when either config file changes", async () => {
    const t = await install();
    const spec = await statefulSetSpec(t.workloads[2]);
    const annotations = (spec.template as unknown as {
      metadata: { annotations?: Record<string, string> };
    }).metadata.annotations;
    expect(annotations?.["grid.bigls.net/secret-checksum"]).toBeTruthy();
  });

  describe("policy-pack invariants", () => {
    it("holds for every workload", async () => {
      const t = await install({ seaweedfs: { masterReplicas: 3, volumeReplicas: 2, filerReplicas: 2 } });
      for (const workload of t.workloads) {
        const spec = await statefulSetSpec(workload);
        // statefulset-rollout-gated
        expect(spec.updateStrategy?.type ?? "RollingUpdate").toBe("RollingUpdate");
        expect(spec.minReadySeconds).toBeGreaterThan(0);
        // statefulset-no-immutable-field-writes: writing this plans a REPLACE
        // of a storage StatefulSet on an existing cluster.
        expect(spec.podManagementPolicy).toBeUndefined();
        // workload-graceful-termination
        expect(spec.template.spec.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(5);
        for (const c of spec.template.spec.containers) {
          // container-resources-bounded
          const r = c.resources as { requests?: Record<string, string>; limits?: Record<string, string> };
          expect(r?.requests?.cpu).toBeTruthy();
          expect(r?.requests?.memory).toBeTruthy();
          expect(r?.limits?.cpu).toBeTruthy();
          expect(r?.limits?.memory).toBeTruthy();
          // workload-health-probes
          expect(c.readinessProbe ?? c.livenessProbe).toBeTruthy();
        }
      }
    });

    it("gives a multi-replica tier a disruption budget and a single-replica tier none", async () => {
      // maxUnavailable:1 on one replica is a no-op, and anything tighter
      // deadlocks a node drain forever.
      expect((await install()).pdbs).toHaveLength(0);
      expect(
        (await install({ seaweedfs: { masterReplicas: 3, volumeReplicas: 2, filerReplicas: 2 } })).pdbs,
      ).toHaveLength(3);
    });
  });
});

describe("single-node topology", () => {
  /**
   * The rule that was written down and broken anyway.
   *
   * `/cluster/healthz` answers `423 Locked` while a master holds a topology
   * child lock — an ordinary admin or volume operation — and a kubelet reads 423
   * as a failed probe. The single-node comment explained exactly this, three
   * lines above a READINESS probe that used it. Readiness is the worse place for
   * it: this pod is the only endpoint of the `seaweedfs` Service, so a lock
   * removes the last endpoint and object storage goes offline for the app tier,
   * the purger, the edge and bucket-init at once, with nothing restarting and no
   * failing container to point at.
   *
   * Asserted as a rule over EVERY workload in BOTH topologies rather than as
   * three per-container assertions, because the defect was not a missing check —
   * it was a paragraph where a test belonged.
   */
  it("never probes /cluster/healthz outside a master quorum, in either topology", async () => {
    const solo = await installSingle();
    const split = await installSplit();

    const workloads = [...solo.workloads, ...split.workloads];
    for (const workload of workloads) {
      const spec = await statefulSetSpec(workload);
      for (const c of spec.template.spec.containers) {
        for (const probe of [c.readinessProbe, c.livenessProbe]) {
          expect((probe as Probe | undefined)?.httpGet?.path).not.toBe("/cluster/healthz");
        }
      }
    }

    // The one legitimate use, kept honest by the same test: with a quorum a
    // locked or leaderless member SHOULD leave the Service, because the others
    // can still serve. Readiness only — never liveness.
    const quorum = await installSplit({ seaweedfs: { masterReplicas: 3 } });
    const master = container(await statefulSetSpec(quorum.workloads[0]), "master");
    expect((master.readinessProbe as Probe).httpGet?.path).toBe("/cluster/healthz");
    expect((master.livenessProbe as Probe).httpGet).toBeUndefined();
  });

  it("reports readiness from the S3 gateway, which is the port every consumer uses", async () => {
    const t = await installSingle();
    const c = container(await statefulSetSpec(t.workloads[0]), "seaweedfs");
    // `/healthz` on 8333 is registered before any auth wrapper in 3.80
    // (`s3api_server.go`, under upstream's own "// Readiness Probe" comment) and
    // returns an unconditional 200 — so it answers for this process alone.
    expect((c.readinessProbe as Probe).httpGet).toEqual({ path: "/healthz", port: 8333 });
    // Liveness stays TCP: a restart here is a full storage outage.
    expect((c.livenessProbe as Probe).httpGet).toBeUndefined();
    expect((c.livenessProbe as Probe).tcpSocket?.port).toBe(9333);
  });

  it("still answers the master on the S3 host, because it is one process", async () => {
    const t = await installSingle();
    expect(t.masterAddress).toBe("seaweedfs:9333");
    expect(t.filerAddress).toBe("seaweedfs:8888");

    const spec = await statefulSetSpec(t.workloads[0]);
    const args = container(spec, "seaweedfs").args!.join(" ");
    // Pinned in full, so a change to this command line is a decision rather
    // than a diff nobody reads: it restarts the only storage server a `single`
    // stack has, and prod runs `single`.
    expect(args).toBe(
      "exec weed server -dir=/data -volume.max=64 -s3 " +
        "-s3.config=/etc/seaweedfs/s3.json -s3.port=8333 -filer.encryptVolumeData",
    );
  });

  it("takes the volume-slot cap from the operator knob, not from a literal", async () => {
    const t = await installSingle({ volumeMaxCount: 128 });
    const spec = await statefulSetSpec(t.workloads[0]);

    expect(container(spec, "seaweedfs").args!.join(" ")).toContain("-volume.max=128");
  });

  it("gives per-org buckets far more slots than the old cap of 8", async () => {
    // The staging outage: a bucket is a SeaweedFS COLLECTION and each one needs
    // a writable volume, so the slot count caps how many tenants can ever be
    // onboarded. At 8 the ninth organization's first write failed with a bare
    // S3 `InternalError` while 9.6 GB of a 9.7 GB disk sat free — the cap, not
    // the disk. Anything at or below 8 puts that ceiling back.
    const t = await installSingle({ perOrgBuckets: true });
    const spec = await statefulSetSpec(t.workloads[0]);
    const args = container(spec, "seaweedfs").args!.join(" ");

    const slots = Number(/-volume\.max=(\d+)/.exec(args)?.[1])
    expect(slots).toBeGreaterThan(8);
  });

  it("still does not re-size the volumes a running stack already holds", async () => {
    // `volumeSizeLimitMB` stays a split-topology knob: slots are a ceiling and
    // cost nothing, but the size limit changes volumes that already exist.
    const t = await installSingle({ volumeSizeLimitMB: 4096 });
    const spec = await statefulSetSpec(t.workloads[0]);

    expect(container(spec, "seaweedfs").args!.join(" ")).not.toContain("volumeSizeLimit");
  });
});

describe("s3 identities", () => {
  async function render(overrides: Record<string, unknown>, tenantPrefix?: string) {
    const { renderS3Config } = await import("./seaweedfs-identities");
    const cfg = makeConfig(overrides);
    const json = await value(
      renderS3Config(cfg, {
        platformBuckets: ["grid-documents", "grid-pg-backups"],
        tenantBucketPrefix: tenantPrefix ?? "grid-org-",
        provisioning: tenantPrefix !== undefined,
      }),
    );
    return JSON.parse(json) as { identities: Array<{ name: string; actions: string[] }> };
  }

  it("never grants a bare action, which SeaweedFS matches against every bucket", async () => {
    const cfg = await render({});
    for (const identity of cfg.identities) {
      for (const action of identity.actions) {
        // `canDo` compares a bare action with `a == action` BEFORE it looks at
        // the bucket. `"Read"` on its own is a grant on everything — which is
        // how the agent tier came to be able to read the Postgres PITR archive.
        expect(action).toContain(":");
      }
    }
  });

  it("keeps the agent tier off the Postgres backup bucket", async () => {
    const cfg = await render({});
    const backendRead = cfg.identities.find((i) => i.name === "grid-backend-read")!;
    // Document buckets only: the shared one and the tenant prefix. NOT the
    // PITR archive, which a bare `Read` used to cover — i.e. every row of
    // every database, readable by the agent tier.
    expect(backendRead.actions).toEqual(["Read:grid-documents", "Read:grid-org-*"]);
    expect(backendRead.actions.join(" ")).not.toContain("grid-pg-backups");
  });

  // The property that makes turning the feature OFF safe. The application layer
  // is already flag-independent on reads — it resolves the bucket from the row —
  // but the S3 grants are what actually authorise the presigned URL. Gate them
  // on the flag and a rollback silently AccessDenies every document written
  // while it was on, and makes the purge skip the tenant bucket while reporting
  // success.
  it("grants the tenant scope even when provisioning is off", async () => {
    const off = await render({});
    const grid = off.identities.find((i) => i.name === "grid")!;
    expect(grid.actions).toContain("Read:grid-org-*");
    expect(grid.actions).toContain("Write:grid-org-*");
    expect(grid.actions).toContain("List:grid-org-*");
  });

  it("gives the object-path identity no bucket lifecycle authority", async () => {
    const cfg = await render({ seaweedfs: { perOrgBuckets: true } }, "grid-org-");
    const grid = cfg.identities.find((i) => i.name === "grid")!;
    // `Admin:<bucket>` authorises DeleteBucket as well as CreateBucket, so the
    // credential every upload carries must not hold it at all.
    expect(grid.actions.some((a) => a.startsWith("Admin"))).toBe(false);
    expect(grid.actions).toContain("Read:grid-org-*");
    expect(grid.actions).toContain("Write:grid-org-*");
  });

  it("confines the lifecycle identity to the tenant prefix", async () => {
    const cfg = await render({ seaweedfs: { perOrgBuckets: true } }, "grid-org-");
    const admin = cfg.identities.find((i) => i.name === "grid-tenant-admin")!;
    expect(admin.actions).toEqual(["Admin:grid-org-*"]);
  });

  it("creates no lifecycle identity at all when per-org buckets are off", async () => {
    // Creating buckets is the one thing that genuinely stops. Reading and
    // deleting objects in buckets that already exist does not — which is why
    // only THIS identity is gated.
    const cfg = await render({});
    expect(cfg.identities.map((i) => i.name)).toEqual(["grid", "grid-backend-read"]);
  });
});

describe("config checksum", () => {
  /**
   * Both credentials, through the REAL `installSeaweedFS` path.
   *
   * The topology specs above pass a stubbed checksum, so nothing exercised the
   * computation itself. That matters because the failure it prevents is silent
   * in exactly the way a test is meant to catch: the Secret changes, no pod
   * field changes, `pulumi up` reports success, and every pod keeps using the
   * credential that was just retired.
   */
  async function checksumFor(overrides: Record<string, unknown>): Promise<string> {
    const k8s = await import("@pulumi/kubernetes");
    const { installSeaweedFS } = await import("./seaweedfs");
    const provider = new k8s.Provider(`ck-${JSON.stringify(overrides).length}-${Math.abs(
      JSON.stringify(overrides).split("").reduce((a, c) => a + c.charCodeAt(0), 0),
    )}`, {});
    const t = installSeaweedFS(makeConfig(overrides), provider, "grid", [], "grid-pg-rw", []);
    const spec = await statefulSetSpec(t.workloads[t.workloads.length - 1]);
    const annotations = (spec.template as unknown as {
      metadata: { annotations?: Record<string, string> };
    }).metadata.annotations;
    return annotations!["grid.bigls.net/secret-checksum"];
  }

  it("changes when the S3 secret key is rotated", async () => {
    const before = await checksumFor({});
    const after = await checksumFor({
      seaweedfs: { secretKey: pulumi.secret("rotated-s3") }, // pragma: allowlist secret
    });
    expect(after).not.toBe(before);
  });

  it("changes when the filer's Postgres password is rotated", async () => {
    // The quieter of the two: the filer keeps its existing connection pool, so
    // the auth failures start a `connection_max_lifetime` after the deploy.
    const before = await checksumFor({});
    const after = await checksumFor({
      seaweedfs: { filerDatabasePassword: pulumi.secret("rotated-pg") }, // pragma: allowlist secret
    });
    expect(after).not.toBe(before);
  });

  it("is stable when nothing changed", async () => {
    expect(await checksumFor({})).toBe(await checksumFor({}));
  });
});

/**
 * The compose stacks build `s3.json` with a shell `printf`, which is a SECOND
 * definition of the authorization model — and it had drifted. It declared two
 * identities where the catalogue declares three, so `grid-backend-read` did not
 * exist there and the agent tier ran on the write-capable `grid` credential: a
 * strictly weaker model than production, in the environment people develop
 * against.
 *
 * The old defence was a comment claiming the two were "the same shape, so a
 * developer can diff the two". Nothing made that true. These tests do: the
 * catalogue is the source, and a divergence fails the build.
 */
describe("compose stacks match the identity catalogue", () => {
  const COMPOSE_FILES = [
    "../compose/docker-compose.yaml",
    "../compose/docker-compose.coolify.yaml",
  ];

  /**
   * Pull the identity JSON out of a compose file's `printf` and parse it.
   *
   * The `%s` placeholders are the credentials, which differ per stack by design —
   * they are replaced with a marker so the JSON parses and only the NAMES and
   * ACTIONS are compared. Those are the authorization model; the credentials are
   * not.
   */
  async function composeIdentities(relativePath: string) {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), relativePath), "utf8");

    const match = /printf '(\{"identities".*?\})\\n'/s.exec(source);
    if (!match) throw new Error(`no identity printf found in ${relativePath}`);

    const parsed = JSON.parse(match[1].replace(/%s/g, "placeholder")) as {
      identities: Array<{ name: string; actions: string[] }>;
    };
    return parsed.identities;
  }

  it.each(COMPOSE_FILES)("%s declares the same identities and grants", async (file) => {
    const { s3IdentityCatalog } = await import("./seaweedfs-identities");
    // Compose runs one bucket and creates tenant buckets, so this is the
    // catalogue's shape for that configuration.
    const expected = s3IdentityCatalog({
      documentsBucket: "grid-documents",
      platformBuckets: ["grid-documents"],
      tenantBucketPrefix: "grid-org-",
      provisioning: true,
      // The compose stacks declare the Langfuse identity unconditionally
      // (ADR-0044) even though the profile that uses it is opt-in — an unused
      // identity costs nothing, and declaring it here is what keeps compose's
      // authorization model equal to production's rather than approximately
      // equal, which is the entire reason this test exists.
      langfuseBucket: "langfuse",
    });

    const actual = await composeIdentities(file);

    expect(actual.map((i) => i.name)).toEqual(expected.map((i) => i.name));
    for (const identity of expected) {
      const found = actual.find((i) => i.name === identity.name);
      // Sorted: `canDo` does not care about order, and pinning it would make
      // this test fail for a reason that is not a security change.
      expect(found?.actions.slice().sort()).toEqual(identity.actions.slice().sort());
    }
  });

  it.each(COMPOSE_FILES)("%s gives every identity a distinct credential", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const printf = /printf '\{"identities".*?> \/etc\/seaweedfs\/s3\.json/s.exec(source)![0];

    // One `$$VAR` PAIR per identity — an access key and a secret key — and all
    // of them different. Reusing a variable would make two identities the same
    // credential, which silently collapses the split this whole model rests on.
    //
    // Counted from the identity list in the same file rather than hardcoded:
    // the previous fixed `6` meant that adding a fourth identity failed here
    // with "expected 8 to be 6", which says nothing about credentials and
    // invites someone to bump the number without checking distinctness.
    const identities = await composeIdentities(file);
    const expectedVars = identities.length * 2;

    const vars = [...printf.matchAll(/"\$\$([A-Z_]+)"/g)].map((m) => m[1]);
    expect(vars).toHaveLength(expectedVars);
    expect(new Set(vars).size).toBe(expectedVars);
  });

  // The agent tier is the one that must NOT hold a write credential.
  it.each(COMPOSE_FILES)("%s points the agent tier at the read-only identity", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const agentBlock = source.slice(
      source.indexOf("  aiq-agent:"),
      source.indexOf("SEAWEED_BUCKET", source.indexOf("  aiq-agent:")),
    );
    expect(agentBlock).toContain("SEAWEED_READONLY_ACCESS_KEY");
    expect(agentBlock).not.toMatch(/SEAWEED_ACCESS_KEY=\$\{SEAWEED_ACCESS_KEY/);
  });
});

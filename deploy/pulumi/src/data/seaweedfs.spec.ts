import { describe, it, expect, beforeAll } from "vitest";
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

// Mocks must be installed before any Pulumi resource is constructed, so the
// modules under test are imported lazily inside `beforeAll`.
pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, metadata: args.inputs.metadata ?? { name: args.name } },
    }),
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
  volumeClaimTemplates?: Array<{ metadata?: { name?: string } }>;
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
  };
  return {
    ...base,
    seaweedfs: { ...base.seaweedfs, ...(overrides.seaweedfs as object) },
    // The modules under test only read the fields above; the cast is the one
    // documented boundary between this fixture and the full GridConfig.
  } as unknown as import("../config").GridConfig;
}

describe("split topology", () => {
  let mod: typeof import("./seaweedfs-split");
  let identities: typeof import("./seaweedfs-identities");
  let provider: import("@pulumi/kubernetes").Provider;
  let k8s: typeof import("@pulumi/kubernetes");

  beforeAll(async () => {
    k8s = await import("@pulumi/kubernetes");
    mod = await import("./seaweedfs-split");
    identities = await import("./seaweedfs-identities");
    provider = new k8s.Provider("test", {});
  });

  async function install(overrides: Record<string, unknown> = {}) {
    const cfg = makeConfig(overrides);
    const secret = identities.s3ConfigSecret(cfg, provider, "grid", {
      platformBuckets: [cfg.seaweedfs.bucket],
      tenantBucketPrefix: cfg.seaweedfs.perOrgBuckets
        ? cfg.seaweedfs.tenantBucketPrefix
        : undefined,
    });
    return mod.installSplitSeaweedFS(cfg, provider, "grid", secret, "grid-pg-rw", []);
  }

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
      // Readiness is where those endpoints belong: they take a pod out of the
      // Service without restarting it.
      expect((master.readinessProbe as Probe).httpGet?.path).toBe("/cluster/healthz");
      expect((volume.readinessProbe as Probe).httpGet?.path).toBe("/healthz");
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
  it("still answers the master on the S3 host, because it is one process", async () => {
    const k8s = await import("@pulumi/kubernetes");
    const { installSingleNodeSeaweedFS } = await import("./seaweedfs-single");
    const identities = await import("./seaweedfs-identities");
    const provider = new k8s.Provider("test-single", {});
    const cfg = makeConfig({ seaweedfs: { topology: "single" } });
    const secret = identities.s3ConfigSecret(cfg, provider, "grid", {
      platformBuckets: [cfg.seaweedfs.bucket],
    });
    const t = installSingleNodeSeaweedFS(cfg, provider, "grid", secret);
    expect(t.masterAddress).toBe("seaweedfs:9333");
    expect(t.filerAddress).toBe("seaweedfs:8888");

    const spec = await statefulSetSpec(t.workloads[0]);
    const args = container(spec, "seaweedfs").args!.join(" ");
    // Byte-for-byte the pre-ADR-0043 command line. A stack still on `single`
    // must see no change here — re-sizing volume slots restarts the only
    // storage server it has.
    expect(args).toBe(
      "exec weed server -dir=/data -volume.max=8 -s3 " +
        "-s3.config=/etc/seaweedfs/s3.json -s3.port=8333 -filer.encryptVolumeData",
    );
  });
});

describe("s3 identities", () => {
  async function render(overrides: Record<string, unknown>, tenantPrefix?: string) {
    const { renderS3Config } = await import("./seaweedfs-identities");
    const cfg = makeConfig(overrides);
    const json = await value(
      renderS3Config(cfg, {
        platformBuckets: ["grid-documents", "grid-pg-backups"],
        tenantBucketPrefix: tenantPrefix,
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
    expect(backendRead.actions).toEqual(["Read:grid-documents"]);
    expect(backendRead.actions.join(" ")).not.toContain("grid-pg-backups");
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
    const cfg = await render({});
    expect(cfg.identities.map((i) => i.name)).toEqual(["grid", "grid-backend-read"]);
  });
});

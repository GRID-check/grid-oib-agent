import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { load } from "js-yaml";
import { baseStackConfig } from "../test-support/stack-config";
import { loadConfig } from "../config";
import { QDRANT_ALERT_THRESHOLDS, qdrantAlertNames, qdrantAlertRules, quantityBytes } from "./qdrant-alerts";

/**
 * The Qdrant alert rules (`qdrant-alerts.ts`).
 *
 * A rule is a string that parses, loads and never fires when it names a series
 * that does not exist, and nothing in this stack evaluates the rules yet to
 * notice. So every name a rule uses is held to the collector's real export of
 * Qdrant 1.19.2 (`qdrant-metrics.fixture.txt`, captured in the 2026-10-13 drill,
 * where a counter gains `_total` and Qdrant's own names would miss), and every
 * runbook link to a heading that exists. The rendered file was also loaded by
 * `promtool check rules` and by a Prometheus 3.5 that fired QdrantPeerDown when
 * a peer was stopped (the drill).
 */

// `loadConfig` namespaces keys by the project, which the runtime reads from the mock context.
pulumi.runtime.setMocks(
  { newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }), call: () => ({}) },
  "grid-oib",
  "test",
  false,
);

type Rule = { alert: string; expr: string; for: string; labels: { severity: string }; annotations: Record<string, string> };

const REPO = path.resolve(__dirname, "../../../..");
const FIXTURE = fs.readFileSync(path.join(__dirname, "qdrant-metrics.fixture.txt"), "utf8");
const RUNBOOK = fs.readFileSync(path.join(REPO, "docs/deployment/qdrant-runbook.md"), "utf8");

/** Series the collector does not scrape, by design: disk use comes from the kubelet. */
const KUBELET = ["kubelet_volume_stats_used_bytes", "kubelet_volume_stats_capacity_bytes"];

function rulesFor(config: Record<string, string>): Rule[] {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...config });
  const doc = load(qdrantAlertRules(loadConfig())) as { groups: Array<{ name: string; rules: Rule[] }> };
  expect(doc.groups).toHaveLength(1);
  return doc.groups[0].rules;
}

/** Metric names a PromQL expression selects, histogram suffixes folded to the family. */
function selected(expr: string): string[] {
  return [...expr.matchAll(/([a-z_][a-z0-9_]*)\{/g)].map((m) => m[1].replace(/_(bucket|sum|count)$/, ""));
}

/** GitHub's heading anchors. */
function anchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{2,4} (.+)$/gm)].map((m) =>
      m[1]
        .toLowerCase()
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .replace(/ /g, "-"),
    ),
  );
}

describe("Qdrant alert rules", () => {
  const rules = rulesFor({});

  it("cover what the design names: dead replicas, Raft, memory, disk, latency, quotas", () => {
    expect(rules.map((r) => r.alert)).toEqual(
      expect.arrayContaining([
        "QdrantPeerDown",
        "QdrantDeadReplicas",
        "QdrantPendingRaftOperations",
        "QdrantMemoryHigh",
        "QdrantDiskHigh",
        "QdrantSearchLatencyHigh",
        "QdrantQuotaExceeded",
      ]),
    );
  });

  it("select only series the collector really exports, or the kubelet's", () => {
    const exported = new Set([...FIXTURE.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]));
    expect(exported.size).toBeGreaterThan(50);
    for (const rule of rules) {
      for (const name of selected(rule.expr)) {
        expect(exported.has(name) || KUBELET.includes(name), `${rule.alert}: ${name}`).toBe(true);
      }
    }
  });

  it("scope every Qdrant series to the scrape job", () => {
    for (const rule of rules.filter((r) => r.alert !== "QdrantDiskHigh")) {
      for (const match of rule.expr.matchAll(/[a-z_]+\{([^}]*)\}/g)) {
        expect(match[1], rule.alert).toContain('job="qdrant"');
      }
    }
  });

  it("link every rule to a runbook section that exists, with a severity and a by-hand check", () => {
    const headings = anchors(RUNBOOK);
    for (const rule of rules) {
      const [file, anchor] = rule.annotations.runbook.split("#");
      expect(file).toBe("docs/deployment/qdrant-runbook.md");
      expect(headings.has(anchor), `${rule.alert} -> #${anchor}`).toBe(true);
      expect(["critical", "warning"]).toContain(rule.labels.severity);
      expect(rule.annotations.check, rule.alert).toBeTruthy();
      expect(rule.for, rule.alert).toMatch(/^\d+[mh]$/);
    }
  });

  it("divide resident memory by this stack's limit, and warn below the quota", () => {
    const memory = (r: Rule[]) => r.find((x) => x.alert === "QdrantMemoryHigh")!.expr;
    expect(memory(rules)).toContain(`/ ${16 * 2 ** 30} > ${QDRANT_ALERT_THRESHOLDS.memoryRatio}`);
    expect(memory(rulesFor({ "grid-oib:qdrantMemory": "24Gi" }))).toContain(`/ ${24 * 2 ** 30} >`);
    expect(QDRANT_ALERT_THRESHOLDS.memoryRatio * 100).toBeLessThan(90);
    expect(QDRANT_ALERT_THRESHOLDS.diskRatio * 100).toBeLessThan(85);
  });

  // A one-hour increase held for the whole window: an increase over 26 hours
  // went pending the moment a fresh Prometheus started (the drill).
  it("judge snapshot staleness by a held condition, not a 26-hour window", () => {
    const stale = rules.find((r) => r.alert === "QdrantSnapshotsStale")!;
    expect(stale.expr).toContain("[1h]");
    expect(stale.for).toBe(`${QDRANT_ALERT_THRESHOLDS.snapshotStaleHours}h`);
  });

  it("drop the under-replication rule on a one-peer stack, which has one replica by design", () => {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), "grid-oib:qdrantReplicas": "1" });
    expect(qdrantAlertNames(loadConfig())).not.toContain("QdrantShardUnderReplicated");
    expect(rules.map((r) => r.alert)).toContain("QdrantShardUnderReplicated");
  });
});

describe("quantityBytes", () => {
  it.each([
    ["16Gi", 16 * 2 ** 30],
    ["512Mi", 512 * 2 ** 20],
    ["8G", 8e9],
    ["1.5Gi", 1.5 * 2 ** 30],
    ["1000", 1000],
  ])("%s is %d bytes", (quantity, bytes) => {
    expect(quantityBytes(quantity)).toBe(bytes);
  });

  it("refuses what is not a byte quantity", () => {
    expect(() => quantityBytes("16 GB")).toThrow(/not a byte quantity/);
    expect(() => quantityBytes("4m")).toThrow(/not a byte quantity/);
  });
});

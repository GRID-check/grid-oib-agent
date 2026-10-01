import { describe, it, expect } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "./config";
import { baseStackConfig } from "./test-support/stack-config";
import {
  appZoneStackConfig,
  CONTACT_ZONE,
  CONTACT_ZONE_ID,
  contactStackConfig,
} from "./test-support/contact-config";

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

/** `loadWith`, for a config that loads: the resolved values. */
function loadValues(values: Record<string, string>) {
  pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
  return loadConfig();
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

describe("feedback → GitHub issues", () => {
  function feedbackIssues(values: Record<string, string>) {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
    return loadConfig().feedbackIssues;
  }

  it("rides on err2issue's token and repo, without needing err2issue deployed", () => {
    const resolved = feedbackIssues({
      "grid-oib:err2issueEnabled": "false",
      "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
      "grid-oib:err2issueGithubToken": "gh-token", // pragma: allowlist secret
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.repo).toBe("GRID-check/grid-oib-agent");
  });

  it("can file into a repo of its own", () => {
    const resolved = feedbackIssues({
      "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
      "grid-oib:err2issueGithubToken": "gh-token", // pragma: allowlist secret
      "grid-oib:feedbackIssuesRepo": "GRID-check/feedback",
    });
    expect(resolved.repo).toBe("GRID-check/feedback");
  });

  it("is off without a token, whatever the flag says", () => {
    const resolved = feedbackIssues({
      "grid-oib:feedbackIssuesEnabled": "true",
      "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
    });
    expect(resolved.enabled).toBe(false);
  });

  it("is off when the flag says so, token or not", () => {
    const resolved = feedbackIssues({
      "grid-oib:feedbackIssuesEnabled": "false",
      "grid-oib:err2issueGithubRepo": "GRID-check/grid-oib-agent",
      "grid-oib:err2issueGithubToken": "gh-token", // pragma: allowlist secret
    });
    expect(resolved.enabled).toBe(false);
  });
});

describe("project mail inbox", () => {
  const mail = {
    "grid-oib:inboundMailDomain": "post.example.test",
    "grid-oib:inboundMailZoneId": "zone-mail-1",
    "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
    "grid-oib:cloudflareApiToken": "cf-token", // pragma: allowlist secret
  };

  it("is off, and asks for nothing, while the domain is unset", () => {
    expect(loadWith({})).toBeNull();
  });

  it("loads with the domain, the zone and both tokens", () => {
    expect(loadWith(mail)).toBeNull();
  });

  // A domain without the BFF token deploys a Worker whose every delivery gets
  // a 503: the sender's MTA retries for days, then bounces. Nothing fails here.
  it.each(["grid-oib:inboundMailToken", "grid-oib:cloudflareApiToken"])(
    "refuses the domain without %s",
    (key) => {
      expect(loadWith(mail, [key])?.message).toContain(key);
    },
  );

  it("counts an empty token as missing", () => {
    expect(loadWith({ ...mail, "grid-oib:inboundMailToken": "" })?.message).toContain(
      "grid-oib:inboundMailToken",
    );
  });

  it("refuses the domain without the zone to enable routing on", () => {
    expect(loadWith(mail, ["grid-oib:inboundMailZoneId"])?.message).toMatch(
      /inboundMailZoneId is required/,
    );
  });

  it.each(["https://post.example.test", "inbox@post.example.test", "post"])(
    "refuses %s as a domain",
    (domain) => {
      expect(loadWith({ ...mail, "grid-oib:inboundMailDomain": domain })?.message).toMatch(
        /must be a bare domain name/,
      );
    },
  );

  it("refuses a subdomain of the DNS zone, which the catch-all cannot cover", () => {
    // The natural choice, `eingang.<zone>`, and the one Cloudflare cannot do:
    // catch-all rules exist only for a zone's apex.
    const error = loadWith({
      ...mail,
      "grid-oib:inboundMailDomain": "eingang.example.test",
      "grid-oib:inboundMailZoneId": "zone-dns-1",
      "grid-oib:dnsZoneId": "zone-dns-1",
      "grid-oib:dnsZoneName": "example.test",
    });
    expect(error?.message).toMatch(/is not the apex of its zone/);
  });

  it("accepts the app zone's own apex on the stack that owns the zone", () => {
    expect(
      loadWith({
        ...appZoneStackConfig(),
        ...mail,
        "grid-oib:inboundMailDomain": CONTACT_ZONE,
        "grid-oib:inboundMailZoneId": CONTACT_ZONE_ID,
      }),
    ).toBeNull();
  });

  it("takes the app zone when the domain is its apex and no zone is given", () => {
    const values = {
      ...appZoneStackConfig(),
      "grid-oib:inboundMailDomain": CONTACT_ZONE,
      "grid-oib:inboundMailToken": mail["grid-oib:inboundMailToken"],
    };
    expect(loadWith(values)).toBeNull();
    expect(loadValues(values).inboundMail.zoneId).toBe(CONTACT_ZONE_ID);
  });

  it.each([
    ["grid-oib:dnsZoneBaseline", "false"],
    ["grid-oib:dnsEnabled", "false"],
  ])("refuses the inbox on the app zone unless this stack owns it (%s=%s)", (key, value) => {
    // The catch-all is one object per zone: a second stack's `up` would
    // silently repoint it at its own Worker.
    const error = loadWith({
      ...appZoneStackConfig(),
      ...mail,
      "grid-oib:inboundMailDomain": CONTACT_ZONE,
      "grid-oib:inboundMailZoneId": CONTACT_ZONE_ID,
      // The apex-serving stack must itself be the baseline; serve a subdomain
      // so that the only refusal left is the inbox's.
      "grid-oib:baseDomain": `www2.${CONTACT_ZONE}`,
      [key]: value,
    });
    expect(error?.message).toMatch(/inboundMailDomain on the app zone needs grid-oib:dnsEnabled/);
  });
});

describe("contact address and form", () => {
  const contact = contactStackConfig();

  function resolved(values: Record<string, string>) {
    pulumi.runtime.setAllConfig({ ...baseStackConfig(), ...values });
    return loadConfig().contact;
  }

  it("is off, and asks for nothing, while the address is unset", () => {
    expect(loadWith({})).toBeNull();
    expect(resolved({}).enabled).toBe(false);
  });

  it("loads with the address, its targets and both web secrets", () => {
    expect(loadWith(contact)).toBeNull();
    const c = resolved(contact);
    expect(c.enabled).toBe(true);
    expect(c.address).toBe("kontakt@example.test");
    expect(c.zoneId).toBe(CONTACT_ZONE_ID);
    expect(c.domain).toBe("example.test");
  });

  it("reads the targets as a comma-separated list, trimmed, lowercased and deduplicated", () => {
    const c = resolved({
      ...contact,
      "grid-oib:contactForwardTo":
        " Mail@Founder-One.example,,mail@founder-two.example, mail@founder-one.example ",
    });
    expect(c.forwardTo).toEqual(["mail@founder-one.example", "mail@founder-two.example"]);
  });

  it.each(["grid-oib:contactEmailToken", "grid-oib:contactFormSecret"])(
    "refuses the address without %s",
    (key) => {
      expect(loadWith(contact, [key])?.message).toContain(key);
    },
  );

  it("counts an empty secret as missing", () => {
    expect(loadWith({ ...contact, "grid-oib:contactFormSecret": " " })?.message).toContain(
      "grid-oib:contactFormSecret",
    );
  });

  it("refuses the address without forward targets", () => {
    expect(loadWith(contact, ["grid-oib:contactForwardTo"])?.message).toMatch(
      /contactForwardTo is required/,
    );
    expect(loadWith({ ...contact, "grid-oib:contactForwardTo": " , " })?.message).toMatch(
      /contactForwardTo is required/,
    );
  });

  it.each([
    ["kontakt@piloti.example", "another domain"],
    ["kontakt@eingang.example.test", "a subdomain of the zone"],
    ["example.test", "no local part"],
    ["a@b@example.test", "two @"],
  ])("refuses %s (%s)", (address) => {
    expect(loadWith({ ...contact, "grid-oib:contactAddress": address })?.message).toMatch(
      /must be an address on the app zone's apex/,
    );
  });

  it.each([
    ["kontakt@example.test", "the contact address itself, a loop"],
    ["office@example.test", "another address on the routed apex, with no mailbox behind it"],
    ["not-an-address", "no domain"],
  ])("refuses %s as a forward target (%s)", (target) => {
    expect(
      loadWith({
        ...contact,
        "grid-oib:contactForwardTo": `mail@founder-one.example,${target}`,
      })?.message,
    ).toMatch(/each target must be a mailbox outside/);
  });

  it.each([
    ["grid-oib:dnsZoneBaseline", "false"],
    ["grid-oib:dnsEnabled", "false"],
  ])("refuses the address unless this stack owns the app zone (%s=%s)", (key, value) => {
    // Routing on the apex is zone-level, like _dmarc: two stacks both enabling
    // it on one zone would each think they own it. The baseline flag is the
    // one-owner-per-zone switch `stack-files.spec.ts` already checks.
    const values = { ...contact, [key]: value };
    // The apex-serving stack must itself be the baseline; serve a subdomain
    // so that the only refusal left is the contact one.
    values["grid-oib:baseDomain"] = "www2.example.test";
    expect(loadWith(values)?.message).toMatch(/contactAddress needs grid-oib:dnsEnabled/);
  });

  it("accepts the project mail inbox on the same zone, the production setup", () => {
    // Cloudflare matches the contact rule before the inbox's catch-all, and
    // `installMailZones` enables routing on the shared zone once.
    expect(
      loadWith({
        ...contact,
        "grid-oib:inboundMailDomain": "example.test",
        "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
      }),
    ).toBeNull();
  });

  it("accepts the project mail inbox on a zone of its own", () => {
    expect(
      loadWith({
        ...contact,
        "grid-oib:inboundMailDomain": "post.example.org",
        "grid-oib:inboundMailZoneId": "zone-mail-1",
        "grid-oib:inboundMailToken": "inbound-token", // pragma: allowlist secret
      }),
    ).toBeNull();
  });
});

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

/**
 * What the two Cloudflare Email Routing modules share: the project mail inbox
 * (`inbound-mail.ts`, a catch-all on a zone of its own) and the contact
 * address (`contact-mail.ts`, one literal rule on the app zone).
 *
 * ## The apex MX guard
 *
 * Enabling Email Routing on a domain (`EmailRoutingDns`) moves the apex's MX
 * to Cloudflare and locks them. If the apex already receives mail elsewhere
 * (say `office@piloti.at` is delivered by Microsoft 365), that mail would go
 * to Cloudflare from then on: into the inbox's catch-all, or, on the app zone,
 * into a bounce for every address but the one routed. So before either module
 * creates anything, the preview reads the apex's MX records and refuses any
 * that point anywhere but Cloudflare's own `*.mx.cloudflare.net`.
 *
 * No MX at all passes: that is the first run on a fresh domain. Cloudflare's
 * MX passes: that is every run after it. Subdomains' MX records are not read:
 * routing on the apex does not touch them, so a `cf-bounce.<apex>` or
 * `send.<apex>` bounce MX for an outbound provider is safe.
 */

/** Cloudflare Email Routing's own MX hosts: `route1.mx.cloudflare.net` and its siblings. */
const CLOUDFLARE_MX = /\.mx\.cloudflare\.net$/;

/** The parts of a DNS record the MX guard reads. */
export interface MxRecord {
  name: string;
  content: string;
}

/**
 * Refuse an apex whose MX records point anywhere but Cloudflare Email Routing.
 * Records on other names are ignored. `configKey` names the stack key that
 * chose the domain, so the error says what to change.
 */
export function assertNoForeignMx(
  configKey: string,
  domain: string,
  zoneId: string,
  records: readonly MxRecord[],
): void {
  const foreign = records
    .filter((r) => normalizeHost(r.name) === domain)
    .map((r) => normalizeHost(r.content))
    .filter((host) => !CLOUDFLARE_MX.test(host));
  if (foreign.length === 0) return;
  throw new Error(
    `grid-oib:${configKey} puts Cloudflare Email Routing on "${domain}" (zone ${zoneId}), but ` +
      `that domain already receives mail elsewhere: its MX records point at ` +
      `${foreign.map((h) => h || ".").join(", ")}. Email Routing would take its MX over and ` +
      "capture that mail. Use a domain of its own, or remove those MX records if nothing " +
      "should receive mail there.",
  );
}

/** DNS names compare case-insensitively and with or without the root dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** The parts of a TXT record the DMARC guard reads. */
export interface TxtRecord {
  name: string;
  content: string;
}

/**
 * Refuse more than one DMARC policy for `domain`. RFC 7489 §6.6.3: with two
 * `v=DMARC1` records at `_dmarc.<domain>`, a receiver applies NO policy, so
 * spoofed mail from the domain stops being rejected, and nothing reports it.
 * The way to get there is one click: onboarding a domain for Cloudflare Email
 * Sending adds its own `_dmarc` record (`v=DMARC1; p=reject;`) beside the one
 * `dnsDmarc` already manages. Any record on another name is ignored.
 */
export function assertSingleDmarc(
  domain: string,
  zoneId: string,
  records: readonly TxtRecord[],
): void {
  const name = `_dmarc.${domain}`;
  const policies = records
    .filter((r) => normalizeHost(r.name) === name)
    .map((r) => r.content.trim().replace(/^"|"$/g, "").trim())
    .filter((content) => /^v=DMARC1\b/i.test(content));
  if (policies.length <= 1) return;
  throw new Error(
    `${name} (zone ${zoneId}) holds ${policies.length} DMARC records: ` +
      `${policies.map((p) => `"${p}"`).join(", ")}. With more than one, receivers apply no ` +
      "DMARC policy at all. Delete all but one in the Cloudflare dashboard; if " +
      "grid-oib:dnsDmarc is set, keep that one (Email Sending onboarding adds its own).",
  );
}

/** What the zone lookups yield once every guard has passed. */
export interface CheckedZone {
  /** The account that owns the zone: where Workers and destination addresses live. */
  accountId: string;
  zoneId: string;
}

/**
 * Look up the zone and its apex MX, and run the guards inside the lookup:
 * `checkZoneName` (the caller's check of the zone's real name) and the MX
 * guard. Every Email Routing resource must take its zone or account id from
 * the result, so that none is registered, not even in a preview, unless the
 * guards passed.
 */
export function checkedRoutingZone(args: {
  configKey: string;
  zoneId: string;
  domain: string;
  provider: cloudflare.Provider;
  checkZoneName: (zoneName: string) => void;
}): pulumi.Output<CheckedZone> {
  const opts = { provider: args.provider };
  const zone = cloudflare.getZoneOutput({ zoneId: args.zoneId }, opts);
  const mx = cloudflare.getDnsRecordsOutput(
    { zoneId: args.zoneId, type: "MX", name: { exact: args.domain } },
    opts,
  );
  return pulumi.all([zone, mx]).apply(([z, records]) => {
    args.checkZoneName(z.name);
    assertNoForeignMx(args.configKey, args.domain, args.zoneId, records.results);
    return { accountId: z.account.id, zoneId: args.zoneId };
  });
}

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";

/**
 * What the two Cloudflare Email Routing features share: the project mail inbox
 * (`inbound-mail.ts`, the zone's catch-all to an Email Worker) and the contact
 * address (`contact-mail.ts`, one literal rule). Both normally live on the
 * product's own apex (`piloti.at`); the inbox may instead have a zone of its
 * own.
 *
 * ## One owner per zone
 *
 * Email Routing is enabled once per zone (`EmailRoutingDns`), and the guards
 * below are per zone. `installMailZones` creates that once for every zone a
 * feature routes mail on and hands the same `MailZone` to every feature on it,
 * so a shared zone gets one provider, one set of guards and one enablement.
 * Two enablements on one zone would each believe they owned it, and deleting
 * either would switch routing off for both.
 *
 * On a shared zone the features cannot step on each other: Cloudflare matches
 * literal rules (the contact address) before the catch-all (the inbox), and
 * the Worker refuses every address that is not project-shaped
 * (`inbound-mail-worker.js`).
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
 * Records on other names are ignored. `configKey` names the stack key(s) that
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
    `${configKey} put Cloudflare Email Routing on "${domain}" (zone ${zoneId}), but ` +
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

/** Email Routing on one zone apex, shared by every feature that routes mail there. */
export interface MailZone {
  provider: cloudflare.Provider;
  /** The apex, e.g. `piloti.at`. */
  domain: string;
  /** Taken from the guarded lookup, so nothing using them exists unless the guards passed. */
  zoneId: pulumi.Output<string>;
  accountId: pulumi.Output<string>;
  /** Enables Email Routing on the apex and adds (and locks) its MX and SPF records. */
  routing: cloudflare.EmailRoutingDns;
}

/** The zone each mail feature routes on; the same object when they share one. */
export interface MailZones {
  contact?: MailZone;
  inbound?: MailZone;
}

/** A Pulumi name for something per mail zone: `piloti.at` → `piloti-at`. */
function zoneKey(domain: string): string {
  return domain.replace(/[^a-z0-9]+/g, "-");
}

/**
 * Refuse a zone whose real name is not the apex the config claims. Thrown
 * inside the zone lookup, so `pulumi preview` fails before anything routes.
 * `configKeys` names the stack keys that chose the zone, so the error says
 * what to change.
 */
export function assertZoneApex(
  configKeys: string,
  domain: string,
  zoneId: string,
  zoneName: string,
): void {
  if (zoneName === domain) return;
  throw new Error(
    `${configKeys} route mail on "${domain}", but zone ${zoneId} is "${zoneName}". The ` +
      "domain must be the zone's apex: Cloudflare Email Routing has no catch-all for " +
      "subdomains, and a zone id naming another zone would route mail there.",
  );
}

function installMailZone(args: {
  configKeys: string;
  zoneId: string;
  domain: string;
  apiToken: pulumi.Output<string>;
  /** Whether the contact address's sender domain lives here: its `_dmarc` is then checked. */
  checkDmarc: boolean;
}): MailZone {
  const key = zoneKey(args.domain);
  // A provider per zone rather than the DNS module's: that one exists only
  // inside `installDns`, and an inbox zone of its own need not be the DNS zone.
  const provider = new cloudflare.Provider(`cloudflare-mail-${key}`, { apiToken: args.apiToken });
  const opts = { provider };

  const checked = checkedRoutingZone({
    configKey: args.configKeys,
    zoneId: args.zoneId,
    domain: args.domain,
    provider,
    checkZoneName: (zoneName) =>
      assertZoneApex(args.configKeys, args.domain, args.zoneId, zoneName),
  });
  // The contact form's sender domain is onboarded for Email Sending by hand
  // (no provider resource), and that onboarding adds a `_dmarc` record of its
  // own. Refuse a zone left with two (`assertSingleDmarc`).
  const guarded = args.checkDmarc
    ? pulumi
        .all([
          checked,
          cloudflare.getDnsRecordsOutput(
            { zoneId: args.zoneId, type: "TXT", name: { exact: `_dmarc.${args.domain}` } },
            opts,
          ),
        ])
        .apply(([zone, records]) => {
          assertSingleDmarc(args.domain, args.zoneId, records.results);
          return zone;
        })
    : checked;
  const zoneId = guarded.zoneId;

  // `email/routing/dns` rather than the older `email/routing/enable`
  // (`EmailRoutingSettings`): same effect, and this one names the domain.
  const routing = new cloudflare.EmailRoutingDns(
    `mail-routing-${key}`,
    { zoneId, name: args.domain },
    opts,
  );

  return { provider, domain: args.domain, zoneId, accountId: guarded.accountId, routing };
}

/**
 * Email Routing for every zone the stack routes mail on: the app zone when the
 * contact address is set, the inbox's zone when the inbox is on. When both are
 * the same zone (the inbox on the product's own apex), one `MailZone` serves
 * both; `loadConfig` has already checked that the inbox's domain is then that
 * zone's apex and that this stack owns the zone.
 */
export function installMailZones(cfg: GridConfig): MailZones {
  const contact = cfg.contact.enabled ? cfg.contact : undefined;
  const inbound = cfg.inboundMail.enabled ? cfg.inboundMail : undefined;
  const shared = contact !== undefined && inbound !== undefined && inbound.zoneId === contact.zoneId;

  const contactZone = contact
    ? installMailZone({
        configKeys: shared
          ? "grid-oib:contactAddress and grid-oib:inboundMailDomain"
          : "grid-oib:contactAddress",
        zoneId: contact.zoneId,
        domain: contact.domain,
        apiToken: contact.apiToken,
        checkDmarc: true,
      })
    : undefined;
  if (shared) return { contact: contactZone, inbound: contactZone };

  const inboundZone = inbound
    ? installMailZone({
        configKeys: "grid-oib:inboundMailDomain",
        zoneId: inbound.zoneId,
        domain: inbound.domain,
        apiToken: inbound.apiToken,
        checkDmarc: false,
      })
    : undefined;
  return { contact: contactZone, inbound: inboundZone };
}

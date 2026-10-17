import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";

/**
 * Cloudflare Email Routing on the project mail inbox's zone apex
 * (`inbound-mail.ts` puts the zone's catch-all and its Email Worker on it):
 * the provider, the guards, and the enablement. Normally the product's own
 * apex (`piloti.at`); the inbox may instead have a zone of its own.
 *
 * ## The apex MX guard
 *
 * Enabling Email Routing on a domain (`EmailRoutingDns`) moves the apex's MX
 * to Cloudflare and locks them. If the apex already receives mail elsewhere
 * (say `office@piloti.at` is delivered by Microsoft 365), that mail would go
 * to Cloudflare from then on, into the inbox's catch-all, which refuses every
 * address that is not project-shaped. So before anything is created, the
 * preview reads the apex's MX records and refuses any that point anywhere but
 * Cloudflare's own `*.mx.cloudflare.net`.
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

/** Email Routing on one zone apex, guarded and enabled. */
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

/**
 * The routing resource's options beyond the provider. Exported for the spec:
 * Pulumi's mocks do not carry resource options.
 */
export const ROUTING_RESOURCE_OPTIONS = {
  // Deleting it (unsetting `inboundMailDomain`, or a destroy) turns Email
  // Routing off for the whole zone: its MX, SPF and DKIM go, and with them every
  // company address's literal rule. Turning the inbox off must leave those be.
  retainOnDelete: true,
} as const satisfies pulumi.CustomResourceOptions;

/**
 * Email Routing on the inbox's zone, or undefined while the inbox is off.
 * `loadConfig` has already refused a subdomain of the DNS zone and an inbox on
 * the app zone in a stack that does not own it; the zone lookup here refuses
 * every other mismatch at preview.
 */
export function installInboundMailZone(cfg: GridConfig): MailZone | undefined {
  const mail = cfg.inboundMail;
  if (!mail.enabled) return undefined;
  const configKeys = "grid-oib:inboundMailDomain";
  // A provider of its own rather than the DNS module's: that one exists only
  // inside `installDns`, and an inbox zone of its own need not be the DNS zone.
  const provider = new cloudflare.Provider("cloudflare-inbound-mail", { apiToken: mail.apiToken });

  const checked = checkedRoutingZone({
    configKey: configKeys,
    zoneId: mail.zoneId,
    domain: mail.domain,
    provider,
    checkZoneName: (zoneName) => assertZoneApex(configKeys, mail.domain, mail.zoneId, zoneName),
  });

  // `email/routing/dns` rather than the older `email/routing/enable`
  // (`EmailRoutingSettings`): same effect, and this one names the domain.
  const routing = new cloudflare.EmailRoutingDns(
    "inbound-mail-routing",
    { zoneId: checked.zoneId, name: mail.domain },
    { provider, ...ROUTING_RESOURCE_OPTIONS },
  );

  return {
    provider,
    domain: mail.domain,
    zoneId: checked.zoneId,
    accountId: checked.accountId,
    routing,
  };
}

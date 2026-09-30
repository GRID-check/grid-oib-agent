import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import type { GridConfig } from "../config";
import { assertSingleDmarc, checkedRoutingZone } from "./email-routing";

/**
 * The company's contact address, e.g. `kontakt@piloti.at`: Cloudflare Email
 * Routing on the app zone's apex, forwarding that ONE address to the founders'
 * own mailboxes (`contactForwardTo`).
 *
 * Created only when `contactAddress` is set, and only on the stack that owns
 * the zone (`dnsZoneBaseline`; `loadConfig` refuses the rest). Nothing here
 * runs in the cluster; the web pods get the account id from here and send the
 * contact form through Cloudflare's Email Service to the same addresses
 * (`app/web.ts`).
 *
 * ## One literal rule, and no catch-all
 *
 * Unlike the project mail inbox (`inbound-mail.ts`), which owns a zone of its
 * own and takes every address on it, this zone is the product's own domain.
 * Only the one address is routed. Every other address on the apex has no rule
 * and is refused by Cloudflare, as it was refused before (the apex had no MX).
 * The two modules never share a zone: `loadConfig` refuses an inbox zone that
 * is the app zone, and each has its own provider and resource names.
 *
 * ## The apex must not already receive mail elsewhere
 *
 * Enabling routing moves the apex's MX to Cloudflare, so a company mailbox
 * already delivered there would stop arriving. The preview refuses that
 * (`assertNoForeignMx` in `email-routing.ts`).
 *
 * ## Destination addresses must be verified, once, by a person
 *
 * Cloudflare forwards only to VERIFIED destination addresses, and the Email
 * Service sends free only to those. Creating an `EmailRoutingAddress` makes
 * Cloudflare send a verification mail to that inbox; until its owner clicks
 * the link, the address is `unverified` and mail to it is not delivered.
 * `pulumi up` succeeds either way, so the click is a deploy step
 * (docs/deployment/kubernetes.md, "Contact address and form"). Destination
 * addresses belong to the ACCOUNT, not the zone: one that already exists
 * there (added by hand in the dashboard) makes the create fail, and is
 * adopted with `pulumi import` instead.
 *
 * ## Email Sending onboarding is a dashboard step, and must not break DMARC
 *
 * The form sends from `contactAddress` through Cloudflare's Email Service,
 * which requires the domain to be onboarded for Email Sending. The provider
 * (@pulumi/cloudflare 6.19) has no resource for that, so it is a one-time
 * dashboard step (docs/deployment/kubernetes.md §3d). It adds records on
 * `cf-bounce.<apex>` (MX, SPF, DKIM at `cf-bounce._domainkey`), which neither
 * the MX guard (apex only) nor the routing resources touch, and a `_dmarc`
 * record (`v=DMARC1; p=reject;`), which would sit beside `dnsDmarc`'s. The
 * preview refuses a zone with two (`assertSingleDmarc`). Its "Email preview"
 * keeps sent messages for about seven days and is on by default: it must be
 * switched off, since form messages are personal data. Neither is in the API
 * this program can reach.
 *
 * ## Cloudflare API token scopes (the stack's `cloudflareApiToken`)
 *
 *   - Account · Email Routing Addresses · Edit (the destination addresses)
 *   - Zone · Email Routing Rules · Edit (the rule), on the app zone
 *   - Zone · Zone Settings · Edit (enabling routing, `email/routing/dns`)
 *   - Zone · DNS · Edit (routing adds and locks its MX and SPF records; the
 *     MX guard reads them)
 *   - Zone · Zone · Read (`getZone`: the apex check and the account id)
 *
 * The web pods never hold this token. They get `contactEmailToken`, a token of
 * its own with Account · Email Sending · Edit and nothing else.
 */

export interface ContactMail {
  provider: cloudflare.Provider;
  routing: cloudflare.EmailRoutingDns;
  addresses: cloudflare.EmailRoutingAddress[];
  rule: cloudflare.EmailRoutingRule;
  /** The account that owns the app zone: the one the web pods send through. */
  accountId: pulumi.Output<string>;
}

/**
 * Refuse a zone whose real name is not the `dnsZoneName` the stack claims.
 * `loadConfig` has already checked the address against `dnsZoneName`; this
 * checks `dnsZoneName` against Cloudflare, so a `dnsZoneId` that names some
 * other zone cannot route mail there.
 */
export function assertContactZone(domain: string, zoneId: string, zoneName: string): void {
  if (zoneName === domain) return;
  throw new Error(
    `grid-oib:dnsZoneName is "${domain}" but zone ${zoneId} is "${zoneName}". ` +
      "grid-oib:contactAddress would route mail on the wrong zone; fix dnsZoneId or dnsZoneName.",
  );
}

/** A Pulumi name for a destination address, stable across reorderings of the list. */
function addressResourceName(address: string): string {
  return `contact-mail-destination-${address.replace(/[^a-z0-9]+/g, "-")}`;
}

export function installContactMail(cfg: GridConfig): ContactMail | undefined {
  const contact = cfg.contact;
  if (!contact.enabled) {
    return undefined;
  }

  // Its own provider, as the inbox has: the DNS module's exists only inside
  // `installDns`, and a separate one keeps the two features' resources apart.
  const provider = new cloudflare.Provider("cloudflare-contact-mail", {
    apiToken: contact.apiToken,
  });
  const opts = { provider };

  // Every resource takes its account or zone id from `checked`, so nothing is
  // registered unless the zone is the one claimed and its apex receives no
  // mail elsewhere.
  const checked = checkedRoutingZone({
    configKey: "contactAddress",
    zoneId: contact.zoneId,
    domain: contact.domain,
    provider,
    checkZoneName: (zoneName) => assertContactZone(contact.domain, contact.zoneId, zoneName),
  });
  // The contact address's sender domain is onboarded for Email Sending by hand
  // (there is no provider resource for it), and that onboarding adds a
  // `_dmarc` record of its own. Refuse a zone left with two, which would
  // switch DMARC off for the product's domain (`assertSingleDmarc`).
  const dmarc = cloudflare.getDnsRecordsOutput(
    { zoneId: contact.zoneId, type: "TXT", name: { exact: `_dmarc.${contact.domain}` } },
    opts,
  );
  const guarded = pulumi.all([checked, dmarc]).apply(([zone, records]) => {
    assertSingleDmarc(contact.domain, contact.zoneId, records.results);
    return zone;
  });
  const accountId = guarded.accountId;
  const zoneId = guarded.zoneId;

  // Enables Email Routing on the apex and adds (and locks) its MX and SPF
  // records. The same resource the inbox uses, on a different zone.
  const routing = new cloudflare.EmailRoutingDns(
    "contact-mail-routing",
    { zoneId, name: contact.domain },
    opts,
  );

  // Creating one sends Cloudflare's verification mail to that inbox. Until
  // its owner clicks the link, nothing is forwarded to it (see the header).
  const addresses = contact.forwardTo.map(
    (email) =>
      new cloudflare.EmailRoutingAddress(addressResourceName(email), { accountId, email }, opts),
  );

  const rule = new cloudflare.EmailRoutingRule(
    "contact-mail-rule",
    {
      zoneId,
      name: `Contact address (${contact.address})`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: contact.address }],
      actions: [{ type: "forward", values: addresses.map((a) => a.email) }],
    },
    { provider, dependsOn: [routing, ...addresses] },
  );

  return { provider, routing, addresses, rule, accountId };
}
